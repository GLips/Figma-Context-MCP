// markdown — the WRITE-edge inverse of figma-mcp read's `escapeMarkdown` + `renderRunMarkdown`
// (figma-mcp/src/core/transformers/text.ts), pinned by the shared spec's "Markdown leaf format"
// section (canonical-vocabulary.md). A plain authored string is decoded (escapes → literal chars,
// the two-character `\n` → a real newline) and its markdown markers (**bold**, *italic*, ~~strike~~,
// [text](url)) parsed into styled segments.
//
// WHY A FLAT FLAG SET, NOT A TREE. A segment only accumulates a FLAG SET (bold/italic/strike/link) —
// it never builds a nesting tree. read's renderRunMarkdown wraps a run inner→outer (italic, bold,
// strike, link), so the maximum stack `[~~***x***~~](url)` and any other legal stacking all collapse
// to the same {bold, italic, strike, link} on `x`. Because we only need the per-character flag union,
// the parser is free of wrapper-order bookkeeping — which is exactly what makes the read→re-author
// round-trip exact (spec "Round-trip requirement"): the flags a run rendered FROM are the flags it
// parses back TO, regardless of how the markers nested.
//
// This module is figma-free (pure string work) and closure-private in the bundle — flcm.ts is the sole
// caller. It fails loud only on markdown image syntax `![…](…)`, which has no text form (ADR-0003).

export interface MdSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  hyperlink?: string; // URL — markdown [text](url), inverse of read's escapeLinkUrl
}

// The accumulated decorations, minus the text — used for a parse node's in-progress flags and for the
// flag an emphasis pair stamps onto the text it encloses.
type Flags = Omit<MdSegment, "text">;

// The escapeMarkdown set (figma-mcp), restated: a backslash before any of these is a literal char.
// A `\n` (backslash + n) is the two-char newline; a stray backslash before anything else stays literal
// (read never emits that form — escapeMarkdown escapes `\` itself, so real backslashes arrive as `\\`).
const ESCAPABLE = "\\*_~[](){}";

interface Ch {
  c: string; // the decoded character (what the text renders as)
  // The raw source that produced this char (`*`, `\*`, or the two-char `\n`). A link URL is rebuilt from
  // `src`, NOT `c` — URL destinations are escapeLinkUrl-encoded (percent-only, backslashes untouched), a
  // DIFFERENT convention than the surrounding text's escapeMarkdown. Decoding `\n`→newline or `\*`→`*`
  // inside a URL would corrupt a destination that legitimately contains a backslash sequence.
  src: string;
  lit: boolean; // produced by an escape (or the two-char newline) — can NEVER be a marker
}

// Decode escapes into a char stream. `lit` marks a char that came from an escape sequence, so the
// parser can tell an authored literal `\*` from a live `*` marker.
function lex(raw: string): Ch[] {
  const out: Ch[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === "n") { out.push({ c: "\n", src: "\\n", lit: true }); i++; continue; }
      if (ESCAPABLE.indexOf(n) !== -1) { out.push({ c: n, src: "\\" + n, lit: true }); i++; continue; }
    }
    out.push({ c, src: c, lit: false });
  }
  return out;
}

const isWs = (c: string): boolean => /\s/.test(c);

// Reverse escapeLinkUrl: `(`/`)` and each whitespace char were percent-encoded on read. Only those are
// undone — a literal `%` an author wrote survives (escapeLinkUrl never produced a bare `%`, so there is
// nothing to over-decode). A URL that literally contained `%28` is the one unavoidable ambiguity.
const URL_UNESCAPE: Record<string, string> = {
  "%28": "(", "%29": ")", "%20": " ", "%09": "\t", "%0a": "\n", "%0b": "\v", "%0c": "\f", "%0d": "\r",
};
function unescapeLinkUrl(u: string): string {
  return u.replace(/%(?:2[89]|09|0[abcd]|20)/gi, (m) => URL_UNESCAPE[m.toLowerCase()]);
}

interface Link { start: number; innerStart: number; innerEnd: number; after: number; url: string }

// Find the first `[text](url)` whose brackets/parens are all live (unescaped) and whose `]` is
// immediately followed by `(`. A link needs a non-empty destination — `[x]()` is treated as literal
// text, not a broken link. `![…](…)` (markdown image) fails loud: text can't embed an image.
function findFirstLink(chs: Ch[]): Link | null {
  for (let i = 0; i < chs.length; i++) {
    if (chs[i].lit || chs[i].c !== "[") continue;
    let j = i + 1;
    for (; j < chs.length; j++) if (!chs[j].lit && chs[j].c === "]") break;
    if (j >= chs.length) continue;
    if (j + 1 >= chs.length || chs[j + 1].lit || chs[j + 1].c !== "(") continue;
    let k = j + 2;
    for (; k < chs.length; k++) if (!chs[k].lit && chs[k].c === ")") break;
    if (k >= chs.length) continue;
    // Rebuild the URL from RAW source (src, not the decoded c) — see the Ch.src comment: the destination
    // is escapeLinkUrl-encoded, so only that is reversed; the text-escape decode must not touch it.
    let raw = "";
    for (let m = j + 2; m < k; m++) raw += chs[m].src;
    const url = unescapeLinkUrl(raw);
    if (!url.trim()) continue; // empty destination — not a link
    if (i > 0 && !chs[i - 1].lit && chs[i - 1].c === "!") {
      throw new Error("flcm.text: markdown image syntax ![…](…) has no text equivalent — use flcm.image(url) for a raster fill, or flcm.svg(markup) / flcm.path({ d }) for vector art.");
    }
    return { start: i, innerStart: i + 1, innerEnd: j, after: k + 1, url };
  }
  return null;
}

// A parse node: either a run of literal text (carrying its accumulated flags) or an unresolved
// emphasis delimiter run whose `n` is decremented as it pairs off.
type Node =
  | { kind: "text"; text: string; flags: Flags }
  | { kind: "delim"; ch: string; n: number; canOpen: boolean; canClose: boolean };

function parse(chs: Ch[]): MdSegment[] {
  // Links resolve outermost (read nests them last), so peel the first link, parse its neighbours and its
  // inner text independently, and tag the inner segments with the URL. Emphasis inside a link still
  // parses because the inner slice runs through `parse` again.
  const link = findFirstLink(chs);
  if (link) {
    const before = parse(chs.slice(0, link.start));
    const inner = parse(chs.slice(link.innerStart, link.innerEnd));
    for (const s of inner) if (s.hyperlink === undefined) s.hyperlink = link.url;
    const after = parse(chs.slice(link.after));
    return [...before, ...inner, ...after];
  }
  return parseEmphasis(chs);
}

function parseEmphasis(chs: Ch[]): MdSegment[] {
  const nodes: Node[] = [];
  const pushText = (t: string): void => {
    const last = nodes[nodes.length - 1];
    if (last && last.kind === "text") last.text += t;
    else nodes.push({ kind: "text", text: t, flags: {} });
  };

  let i = 0;
  while (i < chs.length) {
    const ch = chs[i];
    if (!ch.lit && (ch.c === "*" || ch.c === "~")) {
      let n = 1;
      while (i + n < chs.length && !chs[i + n].lit && chs[i + n].c === ch.c) n++;
      // `~` is a marker only as an exact pair (~~, GFM strikethrough). Any other run of `~` is literal.
      if (ch.c === "~" && n !== 2) { pushText(ch.c.repeat(n)); i += n; continue; }
      // Flanking rule (CommonMark, simplified): an opener can't be followed by whitespace, a closer
      // can't be preceded by whitespace. A run at a string boundary sees a virtual space, so it can
      // only face inward. This is the exact inverse of read's splitEdgeWhitespace, and it keeps
      // arithmetic like `2 * 3` (space-flanked `*`) literal.
      const before = i > 0 ? chs[i - 1].c : " ";
      const after = i + n < chs.length ? chs[i + n].c : " ";
      nodes.push({ kind: "delim", ch: ch.c, n, canOpen: !isWs(after), canClose: !isWs(before) });
      i += n;
      continue;
    }
    pushText(ch.c);
    i++;
  }

  resolveEmphasis(nodes);

  const segs: MdSegment[] = [];
  for (const node of nodes) {
    if (node.kind === "delim") { if (node.n > 0) pushSeg(segs, { text: node.ch.repeat(node.n) }); }
    else if (node.text) pushSeg(segs, { ...node.flags, text: node.text });
  }
  return segs;
}

// Pair emphasis delimiters and stamp the enclosed text nodes with a flag. Bold consumes two `*` from
// each side, italic one; strike consumes two `~`. Nesting order is irrelevant — we only OR a flag onto
// the text between a matched opener/closer — so `***x***` (a 3-run against a 3-run) resolves to bold+
// italic on `x` in two passes, and `**a****b**` (a 4-run acting as close-then-open) works too.
function resolveEmphasis(nodes: Node[]): void {
  for (let ci = 0; ci < nodes.length; ci++) {
    const closer = nodes[ci];
    if (closer.kind !== "delim" || !closer.canClose || closer.n === 0) continue;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = nodes[oi];
      if (opener.kind !== "delim" || !opener.canOpen || opener.ch !== closer.ch || opener.n === 0) continue;
      let flag: Flags;
      let use: number;
      if (closer.ch === "~") {
        if (opener.n < 2 || closer.n < 2) continue;
        use = 2;
        flag = { strike: true };
      } else {
        use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
        flag = use === 2 ? { bold: true } : { italic: true };
      }
      for (let m = oi + 1; m < ci; m++) {
        const mid = nodes[m];
        if (mid.kind === "text") Object.assign(mid.flags, flag);
      }
      opener.n -= use;
      closer.n -= use;
      if (closer.n > 0) ci--; // reprocess this closer against earlier openers (n strictly shrinks)
      break;
    }
  }
}

function sameFlags(a: MdSegment, b: MdSegment): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && a.hyperlink === b.hyperlink;
}

function pushSeg(segs: MdSegment[], seg: MdSegment): void {
  const last = segs[segs.length - 1];
  if (last && sameFlags(last, seg)) last.text += seg.text;
  else segs.push(seg);
}

// Parse an authored plain string into styled segments. A string with no live markers and no escapes
// returns a single flagless segment whose text equals the input — the common, allocation-cheap path.
// The empty string returns []. Callers (flcm.text) treat a single flagless segment as plain `text` and
// anything richer as `runs`.
export function parseInlineMarkdown(raw: string): MdSegment[] {
  return parse(lex(raw));
}
