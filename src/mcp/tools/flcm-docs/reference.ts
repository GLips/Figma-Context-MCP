// reference — the doc generator. It turns the schema (the single source: every verb/prop/type/one-liner)
// plus the hand-written narrative fragments plus the compile-checked examples into two deliverables:
//   • buildQuickStart()          → the ≤2KB figma_execute_code description (critical-first, signatures generated).
//   • buildReferenceSections(s?) → the get_flcm_reference tool output (index+cheat-sheet, or named sections).
// buildFullReference() concatenates every section for the committed human doc (slice: flcm.md regen), so
// the repo doc and the served doc are assembled from the SAME source and cannot drift.
//
// Nothing here is hand-maintained per-prop: the prop/verb tables are walked from the zod schemas, so a
// prop that isn't in the schema can't appear in any output, and a deleted one vanishes everywhere at once.

import { z } from "zod";
import {
  VERBS,
  FIELD_GROUPS,
  EDIT_TYPE_WORD_GROUPS,
  type VerbCategory,
} from "@framelink/plugin/schema";
import {
  MENTAL_MODEL,
  CHILDREN,
  RICH_TEXT,
  PERCENT_SIZING,
  VECTOR_INTRO,
  PAINT_INTRO,
  IMAGE_INTRO,
  EFFECTS_INTRO,
  RENDER_KEYS,
  VERIFY_READBACK,
  CSS_SUBSET,
  FAILS_LOUD,
  EDIT_INTRO,
  EDIT_REMOVAL,
  EDIT_RULES,
  EDIT_MANY,
  STRUCTURE_INTRO,
  STRUCTURE_RULES,
} from "./narrative.js";
import { EXAMPLES } from "./examples.js";

type Fields = Record<string, z.ZodType>;

// A markdown cell can't contain a raw `|` (type labels like `number | "fill"` do) — escape it.
const cell = (s: string) => s.replace(/\|/g, "\\|").trim();

// The displayed type for a field. The authored .meta({ type }) wins when present — some fields are
// intentionally shown looser-but-richer than their TS type (a `number | string` metric documented as
// `number | "Npx"`). Otherwise derive the label straight from the zod def, so a field whose type IS its
// documentation (enums, `number | "fill" | "hug"`) needs no hand-authored label and can't drift. The
// residual hand-authored surface is exactly the .meta labels on genuinely-loose leaves (z.custom<PadInput>,
// fill, effects, stops, …). Throws if a field is neither labelled nor derivable — a loud build-time signal
// that a new schema field needs a label rather than a silently blank doc column.
//
// Reads zod v4's internal `_zod.def` (private API, pinned to the ^4.4.3 caret). docs:check exercises every
// field through here, so a zod bump that changes this shape fails validate loudly, not silently.
function typeLabel(field: z.ZodType): string {
  const meta = field.meta() as { type?: string } | undefined;
  if (meta?.type) return meta.type;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod's internal def is untyped by design here
  const derived = deriveLabel((field as unknown as { _zod: { def: any } })._zod.def);
  if (derived) return derived;
  const kind = (field as unknown as { _zod: { def: { type: string } } })._zod.def.type;
  throw new Error(
    `flcm docgen: schema field of kind '${kind}' has no .meta({ type }) and isn't derivable.`,
  );
}

// Render a zod def as a type label, or "" when the shape isn't self-documenting (z.custom, object) and a
// hand-authored .meta label should win instead. `any` throughout: this walks zod's private def tree,
// which has no public type — the header comment's docs:check gate is what pins the shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveLabel(def: any): string {
  while (def.type === "optional" || def.type === "nullable" || def.type === "default")
    def = def.innerType._zod.def;
  switch (def.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "enum":
      return Object.keys(def.entries)
        .map((v) => `"${v}"`)
        .join(" | ");
    case "literal":
      return def.values.map((v: unknown) => JSON.stringify(v)).join(" | ");
    case "union":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see deriveLabel
      return def.options.map((o: any) => deriveLabel(o._zod.def)).join(" | ");
    default:
      return "";
  }
}

// Render a field group (name/key/opacity, size, a verb's props, …) as a markdown prop table.
function propTable(fields: Fields): string {
  const rows = Object.entries(fields).map(
    ([name, field]) =>
      `| \`${name}\` | ${cell(typeLabel(field))} | ${cell(field.description ?? "")} |`,
  );
  return ["| Prop | Type | Notes |", "| --- | --- | --- |", ...rows].join("\n");
}

// The per-type editable-word lists, composed from EDIT_TYPE_WORD_GROUPS — the SAME table the
// runtime legality gate composes from (edit.ts DELTA_KEYS_BY_TYPE), intersected with the edit
// field set the same way, so the doc can't promise a word the gate rejects.
function editTypeWordLines(): string {
  const editWords = new Set(Object.keys(FIELD_GROUPS.edit));
  const lines: string[] = [];
  const labels: Partial<Record<keyof typeof EDIT_TYPE_WORD_GROUPS, string>> = {
    VECTOR: "VECTOR (path- or svg-born)",
  };
  for (const t of Object.keys(EDIT_TYPE_WORD_GROUPS) as (keyof typeof EDIT_TYPE_WORD_GROUPS)[]) {
    const words = [
      ...new Set(EDIT_TYPE_WORD_GROUPS[t].flatMap((g) => Object.keys(FIELD_GROUPS[g]))),
    ]
      .filter((k) => editWords.has(k))
      .map((k) => `\`${k}\``)
      .join(", ");
    lines.push(`- **${labels[t] ?? t}** — ${words}`);
  }
  return lines.join("\n");
}

function verbTable(): string {
  const rows = VERBS.map((v) => `| \`${v.signature}\` | ${cell(v.builds)} | ${cell(v.args)} |`);
  return ["| Verb | Builds | Arguments |", "| --- | --- | --- |", ...rows].join("\n");
}

// ---- Sections. Each is addressable by id via get_flcm_reference(id); the whole set (in order) is the
// full human doc. Bodies interleave generated tables with narrative fragments. ----
interface Section {
  id: string;
  title: string;
  blurb: string; // one-liner for the index
  body: () => string;
}

const SECTIONS: Section[] = [
  {
    id: "verbs",
    title: "The verbs",
    blurb: "the full verb list and what each builds",
    body: () =>
      `\`flcm\` exposes exactly these. Nothing else is on the \`flcm\` object.\n\n${verbTable()}\n\n` +
      "`FRAME`, `TEXT`, `RECTANGLE`, `ELLIPSE`, `LINE`, and `VECTOR` (via `flcm.svg`/`flcm.path`) are the " +
      "**only** node types you can create — anything else fails loud at render. `flcm.gradient` and " +
      "`flcm.effects` don't build nodes; they build " +
      "*values* you pass to a `fill`/`effects` prop (you can also write the equivalent CSS string directly).\n\n" +
      `### Children and composition\n\n${CHILDREN}`,
  },
  {
    id: "props",
    title: "Props by node",
    blurb: "every prop on every verb, with types",
    body: () =>
      "Every prop is optional; an omitted prop is simply not applied (a frame with no `fill` is transparent, " +
      "not white).\n\n" +
      "**Read and write share one vocabulary.** What `get` returns spreads straight into any constructor or " +
      "`flcm.edit` — `flcm.rect({ ...spec, width: 320 })`, `flcm.text(spec)` — because `left`/`top`, `fill`, " +
      "`text`, `boldWeight` and the rest are the same words on both sides. A spec's read-only words (`id`, " +
      "`type`, a root's `contextual` size beside `designedWidth`) fold away. A spec with `children` needs " +
      "`flcm.fromRead(spec)`, which rebuilds the whole subtree and refuses by name the fields flcm has no " +
      "word for (an INSTANCE's `componentId`, `strokeDashes`, a grid).\n\n" +
      `### Shared by every node\n\n${propTable(FIELD_GROUPS.shared)}\n\n` +
      "### Size & position (frame, text, rect, ellipse)\n\n" +
      '(A `line` sizes on a numeric `width` alone — its length; there is no `height`, `"fill"`, or `"hug"`.)\n\n' +
      `${propTable(FIELD_GROUPS.size)}\n\n` +
      `#### Percent sizing\n\n${PERCENT_SIZING}\n\n` +
      `### flcm.frame — container props\n\n${propTable({ ...FIELD_GROUPS.appearance, ...FIELD_GROUPS.frame })}\n\n` +
      `#### Auto-layout config (the \`layout\` object)\n\n${propTable(FIELD_GROUPS.layout)}\n\n` +
      `### flcm.text — text props\n\n${propTable(FIELD_GROUPS.text)}\n\n` +
      '`text` is the content — passed first (`flcm.text("Hi", props)`) or as the `text` prop (`flcm.text(props)`), ' +
      "never both: a plain string, or an array of styled runs (below). `fill` is its paint, like any node; " +
      "`boldWeight` says what `**` in `text` resolves to. A fixed `width` makes it wrap (grows in height); " +
      "otherwise it grows sideways.\n\n" +
      `#### Text style (the \`textStyle\` object)\n\n${propTable(FIELD_GROUPS.textStyle)}\n\n` +
      `### flcm.text — rich text (runs)\n\n${RICH_TEXT}\n\nEach styled run's delta fields:\n\n${propTable(FIELD_GROUPS.run)}\n\n` +
      `### flcm.rect — shape props\n\n${propTable(FIELD_GROUPS.appearance)}\n\n` +
      `### flcm.ellipse — shape props\n\n(An ellipse has no \`borderRadius\` — its edge is already round.)\n\n${propTable(FIELD_GROUPS.ellipse)}\n\n` +
      `### flcm.line — line props\n\n${propTable(FIELD_GROUPS.line)}\n\n` +
      `### flcm.path — vector props\n\n(\`flcm.svg\` takes only the shared and size/position props above — colors are baked into the markup.)\n\n${propTable(FIELD_GROUPS.path)}`,
  },
  {
    id: "vector",
    title: "Vector art (svg & path)",
    blurb: "icons/logos via flcm.svg and flcm.path",
    body: () => VECTOR_INTRO,
  },
  {
    id: "paint",
    title: "Paint & gradients",
    blurb: "fill/stroke/color values and flcm.gradient",
    body: () => `${PAINT_INTRO}\n\n### flcm.gradient fields\n\n${propTable(FIELD_GROUPS.gradient)}`,
  },
  {
    id: "images",
    title: "Images",
    blurb: "raster image fills via flcm.image",
    body: () => `${IMAGE_INTRO}\n\n### flcm.image opts\n\n${propTable(FIELD_GROUPS.image)}`,
  },
  {
    id: "effects",
    title: "Effects",
    blurb: "shadows & blur, and flcm.effects",
    body: () => `${EFFECTS_INTRO}\n\n### flcm.effects fields\n\n${propTable(FIELD_GROUPS.effects)}`,
  },
  {
    id: "render",
    title: "render(), keys & handles",
    blurb: "creating nodes, addressing them, returning results",
    body: () => RENDER_KEYS,
  },
  {
    id: "edit",
    title: "edit() / editMany() — changing existing nodes",
    blurb: "partial deltas against live nodes, batching them atomically, and the rollback contract",
    body: () =>
      `${EDIT_INTRO}\n\n### Editable fields\n\n${propTable(FIELD_GROUPS.edit)}\n\n` +
      `### Words by node type\n\n${editTypeWordLines()}\n\n` +
      // Derived from the schema's shared group (minus key, which is never editable) so this sentence
      // can't drift from the runtime's non-createable gate, which composes from the same group.
      "On a node type flcm can't create (GROUP, INSTANCE, COMPONENT, …) only the shared words apply: " +
      `${Object.keys(FIELD_GROUPS.shared)
        .filter((k) => k !== "key")
        .map((k) => `\`${k}\``)
        .join(", ")}.\n\n` +
      `${EDIT_REMOVAL}\n\n${EDIT_RULES}\n\n${EDIT_MANY}`,
  },
  {
    id: "structure",
    title: "Tree shape — placing, moving, removing",
    blurb: "append/prepend/insertBefore/insertAfter against live nodes",
    body: () => `${STRUCTURE_INTRO}\n\n${STRUCTURE_RULES}`,
  },
  {
    id: "verify",
    title: "Seeing what you built (get_screenshot)",
    blurb: "the build → screenshot → look → fix loop, and the raw figma.* escape hatch",
    body: () => VERIFY_READBACK,
  },
  {
    id: "css-subset",
    title: "The CSS subset",
    blurb: "which CSS colors/gradients/effects/metrics are supported",
    body: () => CSS_SUBSET,
  },
  {
    id: "fails-loud",
    title: "What fails loud",
    blurb: "what we reject rather than approximate",
    body: () => FAILS_LOUD,
  },
  {
    id: "examples",
    title: "Worked examples",
    blurb: "complete flcm trees exercising most of the surface",
    body: () =>
      EXAMPLES.map((ex) => `### ${ex.title}\n\n${ex.intro}\n\n\`\`\`js\n${ex.code}\n\`\`\``).join(
        "\n\n",
      ),
  },
];

const SECTION_IDS = SECTIONS.map((s) => s.id);

// Claude Code truncates tool descriptions at a hard 2KB, and the truncated tail (the return-envelope
// contract + raw-figma guidance) is exactly what an agent needs. So the ≤2KB cap is a real invariant, not
// a nicety — enforced here (tier-2) rather than trusted to a comment. Interpolating VERBS means adding
// verbs grows the string, so this throws loud at startup / in validate if the quick-start ever overflows.
const QUICKSTART_LIMIT_BYTES = 2048;

// Quick-start verb rendering groups signatures by category, one line per group — the ≤2KB budget can't
// afford a line-plus-description per verb once the read verbs land. Grouping walks VERBS in order (so a new
// category can't be silently dropped — it just prints under its own key) and the byte guard below still
// fires on overflow. The full per-verb table lives in the reference tool, unaffected.
// Typed by VerbCategory so a new category fails typecheck until it has a label — the trailing padding keeps
// the quick-start's category column aligned.
const CATEGORY_LABELS: Record<VerbCategory, string> = {
  build: "build ",
  value: "value ",
  render: "render",
  edit: "edit  ",
  structure: "tree  ",
  read: "read  ",
  page: "page  ",
  target: "target",
};

// The `flcm.` prefix is stated ONCE in the block header rather than repeated per verb: at 24 verbs
// that repetition alone costs ~120 bytes of a 2048-byte budget, and the budget is the binding
// constraint (see QUICKSTART_LIMIT_BYTES). A verb whose `quickStart` is null is already covered by
// the previous entry's combined spelling and prints nothing.
function quickStartVerbLines(): string {
  // Map preserves insertion order, so categories print in first-seen VERBS order (no separate order array).
  const byCategory = new Map<VerbCategory, string[]>();
  for (const v of VERBS) {
    const spelling = v.quickStart === undefined ? v.signature : v.quickStart;
    if (spelling === null) continue;
    const stripped = spelling.replace(/\bflcm\./g, "");
    const sigs = byCategory.get(v.category);
    if (sigs) sigs.push(stripped);
    else byCategory.set(v.category, [stripped]);
  }
  return [...byCategory]
    .map(([cat, sigs]) => `  ${CATEGORY_LABELS[cat]}: ${sigs.join(", ")}`)
    .join("\n");
}

// ---- The ≤2KB quick-start = the figma_execute_code description. Critical-first: execution model, generated
// verb signatures, the must-knows, the pointer to the reference tool. ----
export function buildQuickStart(): string {
  const verbLines = quickStartVerbLines();
  const quickStart = `Execute JavaScript against the live Figma Plugin API (figma.*) in the plugin sandbox. The \`flcm\` DSL is already in scope — prefer it over raw figma.*.

EXECUTION MODEL — your code runs in an async function body: use \`await\` directly and \`return <value>\`. Each call runs in its OWN scope — thread state by returning ids/keys and re-targeting them (flcm.get).

DESCRIBE an inert tree, then RENDER once:
  const t = flcm.frame({ layout:{ mode:"column", gap:16 } }, [ flcm.text("Hi",{ fill:"#111" }) ]);
  const out = await flcm.render(t);   // creates nodes → { node, keyed }

VERBS — all on \`flcm.\`, nothing else is:
${verbLines}

MUST-KNOW
- Return ids/handles, NEVER live Figma nodes (they can't cross the bridge).
- Metrics take a number or "Npx"; width/height also take "N%", "fill", "hug". Colors/gradients/shadows are CSS strings.
- Anything outside the documented CSS subset FAILS LOUD, never wrong pixels.

FULL DOCS — get_flcm_reference(sections?): ${SECTION_IDS.join(", ")} (no arg = index + cheat-sheet).

RETURNS { result, console, errors } — result: your value, JSON-safe (live nodes collapse to { id, name, type }); console: captured console.*; errors: the error string, else null.`;

  const bytes = Buffer.byteLength(quickStart, "utf8");
  if (bytes > QUICKSTART_LIMIT_BYTES) {
    throw new Error(
      `flcm quick-start is ${bytes} bytes, over the ${QUICKSTART_LIMIT_BYTES}B figma_execute_code description cap — ` +
        `the truncated tail (return envelope, raw-figma guidance) is what an agent needs. Trim the prose or ` +
        `move detail into a get_flcm_reference section.`,
    );
  }
  return quickStart;
}

// A client truncates a tool RESULT near ~25K tokens, and a truncated reference silently drops the tail an
// agent needs — Claude Code doesn't even deliver it, it writes the whole payload to a file and hands back
// an error, so ONE over-budget call costs the agent the response AND the handshake preamble travelling with
// it. The whole reference is ~76K chars today, well over that ceiling: there is deliberately no "give me
// everything" argument, and a multi-section request is served up to this budget with the overflow NAMED
// rather than cut. Dense markdown runs closer to ~3 chars/token than 4, so budget from the measured
// failure (79K chars was refused) rather than from a nominal 4×.
const REFERENCE_LIMIT_BYTES = 50_000;

// ---- The sectioned reference tool. No/empty sections → index + cheat-sheet. Otherwise the named sections,
// DEDUPED and in canonical (SECTIONS) order, each under its own heading — so an agent can assemble the whole
// picture (or any subset) in ONE call instead of many. Unknown ids are dropped with a note rather than
// erroring, so a wrong name self-corrects. ----
export function buildReferenceSections(sections?: string[]): string {
  if (!sections || !sections.length) return indexBody();
  const wanted = sections.map((s) => s.trim().toLowerCase());
  const chosen = SECTIONS.filter((s) => wanted.includes(s.id)); // canonical order + dedupe
  const unknown = wanted.filter(
    (w) => w !== "index" && w !== "overview" && !SECTION_IDS.includes(w),
  );
  if (!chosen.length) {
    const note = unknown.length
      ? `No section ${unknown.map((u) => `"${u}"`).join(", ")}. Valid sections: ${SECTION_IDS.join(", ")}.\n\n`
      : "";
    return `# flcm reference\n\n${note}${indexBody()}`;
  }

  // Fill the budget in canonical order, then say out loud which sections didn't fit and how to get them.
  // Never silently truncate: an agent that can't tell a short answer from a cut one guesses at the rest.
  const parts: string[] = [];
  const dropped: string[] = [];
  let bytes = 0;
  for (const section of chosen) {
    const part = `# flcm reference — ${section.title}\n\n${section.body()}`;
    const size = Buffer.byteLength(part, "utf8");
    if (parts.length && bytes + size > REFERENCE_LIMIT_BYTES) {
      dropped.push(section.id);
      continue;
    }
    parts.push(part);
    bytes += size;
  }
  if (dropped.length) {
    parts.push(
      `_Too big for one response, so ${dropped.length > 1 ? "these sections were" : "this section was"} left out: ` +
        `${dropped.map((d) => `\`${d}\``).join(", ")}. Call \`get_flcm_reference([${dropped.map((d) => `"${d}"`).join(", ")}])\` for ${dropped.length > 1 ? "them" : "it"}._`,
    );
  }
  if (unknown.length) {
    parts.push(
      `_Ignored unknown section${unknown.length > 1 ? "s" : ""}: ${unknown.map((u) => `"${u}"`).join(", ")}. Valid: ${SECTION_IDS.join(", ")}._`,
    );
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Any single section must fit the response budget on its own — otherwise it is unreachable through the
 * tool, since the budget loop always emits the first one. Called by `docs:gen`/`docs:check` so a section
 * that outgrows the ceiling fails validate (tier-2) instead of shipping a doc no agent can read.
 */
export function oversizedReferenceSections(): { id: string; bytes: number; limit: number }[] {
  return SECTIONS.map((s) => ({
    id: s.id,
    bytes: Buffer.byteLength(`# flcm reference — ${s.title}\n\n${s.body()}`, "utf8"),
    limit: REFERENCE_LIMIT_BYTES,
  })).filter((s) => s.bytes > s.limit);
}

function indexBody(): string {
  const sectionList = SECTIONS.map((s) => `- \`${s.id}\` — ${s.blurb}`).join("\n");
  return `# flcm reference

${MENTAL_MODEL}

## Sections

Call \`get_flcm_reference(["<id>"])\` for any of:

${sectionList}

## Cheat-sheet

${verbTable()}

- Constructors are inert; only \`await flcm.render(tree)\` creates nodes → \`{ node, keyed }\`.
- Return ids/handles, never live Figma nodes.
- Every metric (\`width\`, \`height\`, \`gap\`, \`padding\`, \`borderRadius\`, \`strokeWidth\`, \`left\`/\`top\`) takes a number or \`"Npx"\`; \`width\`/\`height\`/\`left\`/\`top\` also take \`"N%"\`, and \`width\`/\`height\` take \`"fill"\`/\`"hug"\`. Colors, gradients and shadows are CSS strings.
- Out-of-subset CSS fails loud.`;
}

// The whole reference, in section order — the committed human doc is regenerated from this, so repo and
// served docs are the same bytes.
export function buildFullReference(): string {
  const body = SECTIONS.map((s) => `## ${s.title}\n\n${s.body()}`).join("\n\n");
  return `# Authoring with \`flcm\`\n\n${MENTAL_MODEL}\n\n${body}\n`;
}

export { SECTION_IDS };
