// reference — the doc generator. It turns the schema (the single source: every verb/prop/type/one-liner)
// plus the hand-written narrative fragments plus the compile-checked examples into two deliverables:
//   • buildQuickStart()          → the ≤2KB figma_execute_code description (critical-first, signatures generated).
//   • buildReferenceSections(s)  → the get_flcm_reference tool output: the named sections, or a refusal
//     naming the sections when none were asked for.
// buildFullReference() concatenates every section for the committed human doc (slice: flcm.md regen), so
// the repo doc and the served doc are assembled from the SAME source and cannot drift.
//
// Nothing here is hand-maintained per-prop: the prop/verb tables are walked from the zod schemas, so a
// prop that isn't in the schema can't appear in any output, and a deleted one vanishes everywhere at once.

import { z } from "zod";
import {
  VERBS,
  FIELD_GROUPS,
  INPUT_ALIASES,
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
  ANNOTATIONS_REFERENCE,
  CSS_SUBSET,
  FAILS_LOUD,
  EDIT_INTRO,
  EDIT_REMOVAL,
  EDIT_RULES,
  EDIT_MANY,
  STRUCTURE_INTRO,
  STRUCTURE_RULES,
  COMPONENTS_CREATE,
  COMPONENTS_PROPERTIES,
  COMPONENTS_VARIANTS,
  COMPONENTS_EDIT_MAIN,
  COMPONENTS_INTRO,
  COMPONENTS_EDIT,
  COMPONENTS_DETACH,
  COMPONENTS_RULES,
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

// Input aliases are accepted by the schemas but documented once, outside the canonical vocabulary.
function documentedFields(fields: Fields): [string, z.ZodType][] {
  return Object.entries(fields).filter(([, field]) => !field.meta()?.inputOnly);
}

function nativeSpellings(): string {
  const lines = Object.values(INPUT_ALIASES).flatMap((rule) =>
    rule.keys.map((key) => `- \`${key}\` → \`${rule.path.join(".")}\``),
  );
  return (
    "### Native spellings accepted\n\n" +
    "Aliases normalize silently on every verb; equivalent duplicates agree, conflicting values fail. " +
    "Grid aliases also work inside `layout`. Native anchors are 0-based and combine with spans into 1-based CSS placement.\n\n" +
    lines.join("\n")
  );
}

// Render a field group (name/key/opacity, size, a verb's props, …) as a markdown prop table.
function propTable(fields: Fields): string {
  const rows = documentedFields(fields).map(
    ([name, field]) =>
      `| \`${name}\` | ${cell(typeLabel(field))} | ${cell(field.description ?? "")} |`,
  );
  return ["| Prop | Type | Notes |", "| --- | --- | --- |", ...rows].join("\n");
}

// The per-type editable-word lists, composed from EDIT_TYPE_WORD_GROUPS — the SAME table the
// runtime legality gate composes from (edit-plan.ts DELTA_KEYS_BY_TYPE), intersected with the edit
// field set the same way, so the doc can't promise a word the gate rejects.
function editTypeWordLines(): string {
  const editWords = new Set(documentedFields(FIELD_GROUPS.edit).map(([key]) => key));
  const lines: string[] = [];
  const labels: Partial<Record<keyof typeof EDIT_TYPE_WORD_GROUPS, string>> = {
    VECTOR: "VECTOR (path- or svg-born)",
  };
  for (const t of Object.keys(EDIT_TYPE_WORD_GROUPS) as (keyof typeof EDIT_TYPE_WORD_GROUPS)[]) {
    const words = [
      ...new Set(
        EDIT_TYPE_WORD_GROUPS[t].flatMap((g) =>
          documentedFields(FIELD_GROUPS[g]).map(([key]) => key),
        ),
      ),
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
  blurb: string; // one-liner for the menu a nameless call gets back
  body: () => string;
}

const SECTIONS: Section[] = [
  // First, and named in the blank-call refusal, because it is the part that stops an agent being wrong
  // about what a spec IS — identity, copying, session lifetime, read shape. An agent that already knows
  // enough to name `structure` or `components` never asks for a general overview, so the rules have to
  // be reachable by name.
  {
    id: "mental-model",
    title: "The mental model",
    blurb:
      "what a spec is, and the identity, copying, session and read-shape rules every other section assumes. Read this first",
    body: () =>
      `${MENTAL_MODEL}\n\n### Rules that hold everywhere\n\n` +
      "- Return ids and handles, never live Figma nodes.\n" +
      "- Every metric (`width`, `height`, `gap`, `padding`, `borderRadius`, `strokeWidth`, `left`/`top`) " +
      'takes a number or `"Npx"`; `width`/`height`/`left`/`top` also take `"N%"`, and `width`/`height` take ' +
      '`"fill"`/`"hug"`. Colors, gradients and shadows are CSS strings.\n' +
      "- Out-of-subset CSS fails loud.",
  },
  {
    id: "verbs",
    title: "The verbs",
    blurb: "the full verb list and what each builds",
    body: () =>
      `\`flcm\` exposes exactly these. Nothing else is on the \`flcm\` object.\n\n${verbTable()}\n\n` +
      "Nodes are data with type FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR or INSTANCE. " +
      "gradient, image and effects produce reusable values for props.\n\n" +
      `### Children and composition\n\n${CHILDREN}`,
  },
  {
    id: "props",
    title: "Props by node",
    blurb: "every prop on every verb, with types",
    body: () =>
      "New nodes require type; INSTANCE also requires componentId, and VECTOR requires exactly one of svg or d. " +
      "An id refers to a live node; type can be omitted for a move. children is an array of plain specs. " +
      "Other omitted props keep live values or use creation defaults. The verb returns the spec copied with ids.\n\n" +
      `${nativeSpellings()}\n\n` +
      `### Shared by every node\n\n${propTable(FIELD_GROUPS.shared)}\n\n` +
      `### Annotations\n\n${propTable(FIELD_GROUPS.annotation)}\n\n${ANNOTATIONS_REFERENCE}\n\n` +
      "### Size & position (FRAME, TEXT, RECTANGLE, ELLIPSE, VECTOR, INSTANCE)\n\n" +
      'A LINE sizes along its length alone, its `width`: a number, or `"fill"` under a row or column parent — the divider case, ' +
      'where the flow supplies the length. There is no `height`, no `"hug"` and no percent.\n\n' +
      `${propTable(FIELD_GROUPS.size)}\n\n` +
      `#### Percent sizing\n\n${PERCENT_SIZING}\n\n` +
      `### FRAME — container props\n\n${propTable({ ...FIELD_GROUPS.appearance, ...FIELD_GROUPS.frame })}\n\n` +
      `#### Auto-layout config (the \`layout\` object)\n\n${propTable(FIELD_GROUPS.containerLayout)}\n\n#### Placement under a parent (in the same \`layout\` object)\n\n${propTable(FIELD_GROUPS.childLayout)}\n\n` +
      `### TEXT — text props\n\n${propTable(FIELD_GROUPS.text)}\n\n` +
      "`text` is a string or array of styled runs. `fill` is its paint. " +
      "`boldWeight` says what `**` in `text` resolves to. A fixed `width` makes it wrap (grows in height); " +
      "otherwise it grows sideways.\n\n" +
      `#### Text style (the \`textStyle\` object)\n\n${propTable(FIELD_GROUPS.textStyle)}\n\n` +
      `### TEXT — rich text (runs)\n\n${RICH_TEXT}\n\nEach styled run's delta fields:\n\n${propTable(FIELD_GROUPS.run)}\n\n` +
      `### RECTANGLE — shape props\n\n${propTable(FIELD_GROUPS.appearance)}\n\n` +
      `### ELLIPSE — shape props\n\n(An ellipse has no \`borderRadius\` — its edge is already round.)\n\n${propTable(FIELD_GROUPS.ellipse)}\n\n` +
      `### LINE — line props\n\n${propTable(FIELD_GROUPS.line)}\n\n` +
      `### VECTOR — vector props\n\n(Use \`svg\` for opaque markup with shared and size/position props; use \`d\` for a themeable path with the props below.)\n\n${propTable(FIELD_GROUPS.path)}\n\n` +
      // The instance table prints once, here beside its sibling node types; the components section's
      // prose explains the same two words at length rather than repeating the table.
      "### INSTANCE — component words\n\n(An instance also takes every `FRAME` prop above; each one " +
      "named is a root-level override. `componentId` names the component in the props form, and swaps it under edit — see the components section.)\n\n" +
      propTable({ ...FIELD_GROUPS.swap, ...FIELD_GROUPS.instance }),
  },
  {
    id: "vector",
    title: "Vector art (svg & path)",
    blurb: "SVG imports and themeable vector paths",
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
      "On a node type with no vocabulary of its own (GROUP, SECTION, POLYGON, …) only the shared words apply: " +
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
    id: "components",
    title: "Components — making and using them",
    blurb:
      "flcm.component / variants to make one; INSTANCE / edit / detach to stamp, override, swap, detach",
    body: () =>
      // The swap word (`componentId`) has no table here: it is edit-only, so it rides the edit
      // section's table, and the narrative below says what it does.
      `${COMPONENTS_CREATE}\n\n### flcm.component options\n\n${propTable(FIELD_GROUPS.componentOptions)}\n\n` +
      `### Properties\n\n${COMPONENTS_PROPERTIES}\n\n` +
      // The binding word has no table of its own: the Properties prose and its sample carry the whole
      // shape, and the edit section's field table lists the word.
      `#### One \`propertyDefinitions\` entry\n\n${propTable(FIELD_GROUPS.propertyDefinition)}\n\n` +
      // No tables for the variants entry/options or the edit-only definition words: the code samples
      // show both shapes, and the definition words already ride the edit section's field table.
      `### Variants — \`flcm.variants\`\n\n${COMPONENTS_VARIANTS}\n\n` +
      `### Changing a component — \`flcm.edit\`\n\n${COMPONENTS_EDIT_MAIN}\n\n` +
      // No instance or fill-word table here: the instance table prints in the props section beside the
      // other node types, and the fill word's whole shape is in the "Filling a slot" prose.
      `### Using one — \`INSTANCE\`\n\n${COMPONENTS_INTRO}\n\n` +
      // COMPONENTS_RULES is the section's one refusal catalogue; the prose above states each other
      // refusal beside the rule it enforces, so nothing is listed twice.
      `${COMPONENTS_EDIT}\n\n${COMPONENTS_DETACH}\n\n${COMPONENTS_RULES}`,
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
  value: "value ",
  render: "render",
  edit: "edit  ",
  structure: "tree  ",
  read: "read  ",
  page: "page  ",
  target: "target",
  component: "comp  ",
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

// The docs pointer prints the literal first call: it names the must-read section and shows that the
// argument is required, in one gesture. `mental-model` is SECTIONS[0], so the rest list without it —
// which also buys back bytes of a budget the reference tool's own ids keep eating.
const DOCS_POINTER = `FULL DOCS — get_flcm_reference(["${SECTION_IDS[0]}"]) first, then: ${SECTION_IDS.slice(1).join(", ")}.`;

// ---- The ≤2KB quick-start = the figma_execute_code description. Critical-first: execution model, generated
// verb signatures, the must-knows, the pointer to the reference tool. ----
export function buildQuickStart(): string {
  const verbLines = quickStartVerbLines();
  const quickStart = `Execute JavaScript in Figma with \`flcm\`.

EXECUTION: await/return directly. Only session survives calls: plain-data snapshots, ids as pointers. session.last keeps full plain-data returns, else undefined. Same plugin run, including reconnects/pages; close/file switch clears it. Declarations and flcm are per-call.

AUTHOR:
  const t = { type:"FRAME", layout:{ mode:"column", gap:16 }, children:[{ type:"TEXT", text:"Hi" }] };
  session.screen = await flcm.render(t); // copied spec with ids
  // id means move + edit; no id means create, at every depth.

VERBS — all on \`flcm.\`, nothing else is:
${verbLines}

MUST-KNOW
- Store plain data; return ids for live nodes.
- get/find predicates see full trees. Reads project at return/console: elided gives cut sizes in JSON characters. Survey session.last or fresh flcm.get(id); never rerun edits. Computed data stays whole.
- Metrics take a number or "Npx"; width/height also take "N%", "fill", "hug". Colors/gradients/shadows are CSS strings.
- Unsupported CSS fails loud.

${DOCS_POINTER}

RETURNS { result, console, errors }: JSON-safe result, captured console lines, error string or null.`;

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

// A call that names nothing gets the menu and no prose. Retryable wording, not a failure: an agent that
// reads a terminal error abandons the tool, and the one thing a blank call is missing is the names.
function blankCallRefusal(note: string): string {
  const menu = SECTIONS.map((s) => `- \`${s.id}\` — ${s.blurb}`).join("\n");
  return (
    `# flcm reference\n\n${note}` +
    "`get_flcm_reference` needs the sections you want, so this call returned no reference. " +
    'Retry naming them — start with `get_flcm_reference(["mental-model"])`. ' +
    "Several ids in one call are served together, deduped and in the order below.\n\n" +
    `${menu}`
  );
}

// ---- The sectioned reference tool. The named sections, DEDUPED and in canonical (SECTIONS) order, each
// under its own heading — so an agent can assemble the whole picture (or any subset) in ONE call instead of
// many. Unknown ids are dropped with a note rather than erroring, so a wrong name self-corrects. ----
export function buildReferenceSections(sections?: string[]): string {
  const wanted = (sections ?? []).map((s) => s.trim().toLowerCase());
  const chosen = SECTIONS.filter((s) => wanted.includes(s.id)); // canonical order + dedupe
  const unknown = wanted.filter((w) => !SECTION_IDS.includes(w));
  if (!chosen.length) {
    const note = unknown.length ? `No section ${unknown.map((u) => `"${u}"`).join(", ")}.\n\n` : "";
    return blankCallRefusal(note);
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

// The whole reference, in section order — the committed human doc is regenerated from this, so repo and
// served docs are the same bytes. The mental model rides in as the first section, not separately.
export function buildFullReference(): string {
  const body = SECTIONS.map((s) => `## ${s.title}\n\n${s.body()}`).join("\n\n");
  return `# Authoring with \`flcm\`\n\n${body}\n`;
}

export { SECTION_IDS };
