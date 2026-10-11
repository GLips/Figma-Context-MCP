/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// figma_execute_code's reply text. A reply is compact JSON, except where the result holds designTokens
// entries: those render as a token tree, one line per token, in the spirit of the read tools' node lines.
//
//   [COLLECTION] "Theme" modes=["Light","Dark"]
//     [COLOR] "color/bg" #FFFFFF #000000 scopes=["FRAME_FILL"]
//   [TEXT] "Heading/H1" value={"fontFamily":"Inter","fontSize":32}
//
// An entry is recognised only by the mark the preamble's egress puts on it (TOKEN_ENTRY_MARK), never by
// shape, so an agent's own look-alike data stays JSON. Lossless: every field an entry carries lands on
// its line, the ones without a slot of their own as key=value.
import { TOKEN_ENTRY_MARK, type TokenEntryKind } from "@framelink/plugin/token-mark";

interface ExecuteCodeReplyText {
  result?: unknown;
  console: string[];
  errors: string | null;
}

type TokenEntry = Record<string, unknown>;

export function formatExecuteCodeReply(reply: ExecuteCodeReplyText): string {
  if (!holdsTokenEntry(reply.result)) return JSON.stringify(reply);
  const lines = ["result:"];
  renderValue(reply.result, 1, lines);
  lines.push(
    `console: ${JSON.stringify(reply.console)}`,
    `errors: ${JSON.stringify(reply.errors)}`,
  );
  return lines.join("\n");
}

/** The reply as plain data, for consumers that keep JSON (the CLI's stdout and --output file). */
export function withoutTokenMarks<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(withoutTokenMarks) as T;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== TOKEN_ENTRY_MARK)
      .map(([key, item]) => [key, withoutTokenMarks(item)]),
  ) as T;
}

function entryKind(value: unknown): TokenEntryKind | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mark = (value as TokenEntry)[TOKEN_ENTRY_MARK];
  return mark === "variable" || mark === "style" ? mark : undefined;
}

function holdsTokenEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (entryKind(value)) return true;
  return Object.values(value).some(holdsTokenEntry);
}

// Only the containers that hold an entry are broken into lines; everything else stays one JSON value.
function renderValue(value: unknown, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  if (entryKind(value)) return renderEntries([value as TokenEntry], depth, out);
  if (Array.isArray(value)) {
    let run: TokenEntry[] = [];
    const flush = () => {
      if (run.length) renderEntries(run, depth, out);
      run = [];
    };
    for (const item of value) {
      if (entryKind(item)) {
        run.push(item as TokenEntry);
        continue;
      }
      flush();
      if (holdsTokenEntry(item)) {
        out.push(`${indent}-`);
        renderValue(item, depth + 1, out);
      } else out.push(`${indent}- ${JSON.stringify(item)}`);
    }
    flush();
    return;
  }
  for (const [key, item] of Object.entries(value as object)) {
    if (holdsTokenEntry(item)) {
      out.push(`${indent}${renderKey(key)}:`);
      renderValue(item, depth + 1, out);
    } else out.push(`${indent}${renderKey(key)}: ${JSON.stringify(item)}`);
  }
}

// Entries keep the order they were returned in. A header opens wherever the library or (for variables)
// the collection changes from the line before, so a designTokens listing, already ordered that way,
// reads as one tree, and a sorted or interleaved selection keeps its order, repeating headers where it
// must. Library headers appear only when the run reaches beyond the file's own tokens.
function renderEntries(entries: TokenEntry[], depth: number, out: string[]): void {
  const headed = entries.some((entry) => libraryHeader(entry) !== LOCAL);
  const at = headed ? depth + 1 : depth;
  let library: string | undefined;
  for (const run of consecutiveRuns(entries, runKey)) {
    const header = libraryHeader(run[0]);
    if (headed && header !== library) out.push(`${"  ".repeat(depth)}${header}`);
    library = header;
    if (entryKind(run[0]) === "style") run.forEach((entry) => out.push(tokenLine(entry, at)));
    else renderCollection(run, at, out);
  }
}

function runKey(entry: TokenEntry): string {
  const kind = entryKind(entry);
  return JSON.stringify([
    kind,
    libraryHeader(entry),
    kind === "variable" ? collectionKey(entry) : "",
  ]);
}

const LOCAL = "[LOCAL]";

// Figma names a remote token's library only sometimes; a remote entry without one still says it is remote.
function libraryHeader(entry: TokenEntry): string {
  if (typeof entry.library === "string") return `[LIBRARY] ${quote(entry.library)}`;
  return entry.remote === true ? "[REMOTE]" : LOCAL;
}

function collectionKey(entry: TokenEntry): string {
  return typeof entry.collection === "string" ? entry.collection : "";
}

// Modes are named once, on the collection; each line then lists its values in that order. An entry
// whose modes don't match the header (an unreadable collection keys values by mode id) spells them out.
function renderCollection(entries: TokenEntry[], depth: number, out: string[]): void {
  const modes = [...new Set(entries.flatMap((entry) => Object.keys(valuesOf(entry) ?? {})))];
  const name = entries[0].collection;
  const header = typeof name === "string" ? `[COLLECTION] ${quote(name)}` : "[COLLECTION]";
  out.push(`${"  ".repeat(depth)}${header} modes=${JSON.stringify(modes)}`);
  for (const entry of entries) out.push(tokenLine(entry, depth + 1, modes));
}

function valuesOf(entry: TokenEntry): Record<string, unknown> | undefined {
  const { values } = entry;
  return values && typeof values === "object" && !Array.isArray(values)
    ? (values as Record<string, unknown>)
    : undefined;
}

// Fields with a slot of their own: the mark, the type label, the reference, and what the headers carry.
const SLOTTED = new Set([TOKEN_ENTRY_MARK, "type", "reference", "collection", "library", "remote"]);

function tokenLine(entry: TokenEntry, depth: number, modes?: string[]): string {
  const parts: string[] = [];
  if (typeof entry.type === "string") parts.push(`[${entry.type}]`);
  parts.push(renderReference(entry.reference));
  const values = valuesOf(entry);
  const inline = modes && values && sameKeys(Object.keys(values), modes);
  if (inline) parts.push(...modes.map((mode) => renderInline(values[mode])));
  for (const [key, value] of Object.entries(entry)) {
    if (SLOTTED.has(key) || (inline && key === "values")) continue;
    parts.push(`${renderKey(key)}=${renderInline(value)}`);
  }
  return "  ".repeat(depth) + parts.join(" ");
}

function sameKeys(keys: string[], modes: string[]): boolean {
  return keys.length === modes.length && keys.every((key, i) => key === modes[i]);
}

// `{ variable: "color/bg" }` reads `"color/bg"`; an `{ id, name }` target reads like a node line,
// `"name" #id`. Anything else in the reference trails as key=value; an unexpected shape stays JSON.
function renderReference(reference: unknown): string {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    return `reference=${JSON.stringify(reference)}`;
  }
  const { variable, style, ...rest } = reference as Record<string, unknown>;
  const target = variable ?? style;
  if (target === undefined || (variable !== undefined && style !== undefined)) {
    return `reference=${JSON.stringify(reference)}`;
  }
  const parts: string[] = [];
  if (typeof target === "string") parts.push(quote(target));
  else if (target && typeof target === "object" && !Array.isArray(target)) {
    const { id, name, ...more } = target as Record<string, unknown>;
    if (name !== undefined)
      parts.push(typeof name === "string" ? quote(name) : `name=${JSON.stringify(name)}`);
    if (id !== undefined)
      parts.push(typeof id === "string" ? `#${id}` : `id=${JSON.stringify(id)}`);
    for (const [key, value] of Object.entries(more))
      parts.push(`${renderKey(key)}=${renderInline(value)}`);
  } else return `reference=${JSON.stringify(reference)}`;
  for (const [key, value] of Object.entries(rest))
    parts.push(`${renderKey(key)}=${renderInline(value)}`);
  return parts.join(" ");
}

// Bare where unambiguous (`#FFFFFF`, `Medium`); a string that would read as another type (`12`, `.5`,
// `true`, `NaN`), or that would split the space-separated line, is JSON-quoted. Objects, arrays,
// numbers and booleans are JSON.
function renderInline(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value);
  const readsAsOther =
    /^(?:true|false|null|[+-]?(?:NaN|Infinity))$/.test(value) ||
    (value.trim() !== "" && !Number.isNaN(Number(value)));
  return value === "" || readsAsOther || /[\s"=]|^[[{]/.test(value) ? quote(value) : value;
}

function renderKey(key: string): string {
  return /^[\w$-]+$/.test(key) ? key : quote(key);
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function consecutiveRuns<T>(items: T[], key: (item: T) => string): T[][] {
  const runs: T[][] = [];
  let last: string | undefined;
  for (const item of items) {
    const k = key(item);
    if (runs.length && k === last) runs[runs.length - 1].push(item);
    else runs.push([item]);
    last = k;
  }
  return runs;
}
