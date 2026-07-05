// reference — the doc generator. It turns the schema (the single source: every verb/prop/type/one-liner)
// plus the hand-written narrative fragments plus the compile-checked examples into two deliverables:
//   • buildQuickStart()          → the ≤2KB figma_execute_code description (critical-first, signatures generated).
//   • buildReferenceSections(s?) → the get_flcm_reference tool output (index+cheat-sheet, named sections, or all).
// buildFullReference() concatenates every section for the committed human doc (slice: flcm.md regen), so
// the repo doc and the served doc are assembled from the SAME source and cannot drift.
//
// Nothing here is hand-maintained per-prop: the prop/verb tables are walked from the zod schemas, so a
// prop that isn't in the schema can't appear in any output, and a deleted one vanishes everywhere at once.

import { z } from "zod";
import { VERBS, FIELD_GROUPS } from "@framelink/plugin/schema";
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
  CSS_SUBSET,
  FAILS_LOUD,
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
      `### Shared by every node\n\n${propTable(FIELD_GROUPS.shared)}\n\n` +
      "### Size & position (frame, text, rect, ellipse)\n\n" +
      '(A `line` sizes differently — it takes a numeric `length`/`w` and ignores `h`/`"fill"`/`"hug"`.)\n\n' +
      `${propTable(FIELD_GROUPS.size)}\n\n` +
      `#### Percent sizing\n\n${PERCENT_SIZING}\n\n` +
      `### flcm.frame — container props\n\n${propTable({ ...FIELD_GROUPS.appearance, ...FIELD_GROUPS.frame })}\n\n` +
      `#### Auto-layout config (the \`layout\` object)\n\n${propTable(FIELD_GROUPS.layout)}\n\n` +
      `### flcm.text — text props\n\n${propTable(FIELD_GROUPS.text)}\n\n` +
      "`content` is passed first: a plain string, or an array of styled runs (below). A fixed `width` makes it " +
      "wrap (grows in height); otherwise it grows sideways.\n\n" +
      `#### Text style (the \`textStyle\` object)\n\n${propTable(FIELD_GROUPS.textStyle)}\n\n` +
      `### flcm.text — rich text (runs)\n\n${RICH_TEXT}\n\nEach styled run's delta fields:\n\n${propTable(FIELD_GROUPS.run)}\n\n` +
      `### flcm.rect / flcm.ellipse — shape props\n\n${propTable(FIELD_GROUPS.appearance)}\n\n` +
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
const CATEGORY_LABELS: Record<string, string> = {
  build: "build ",
  value: "value ",
  render: "render",
  read: "read  ",
  target: "target",
};

function quickStartVerbLines(): string {
  const order: string[] = [];
  const byCategory = new Map<string, string[]>();
  for (const v of VERBS) {
    if (!byCategory.has(v.category)) {
      byCategory.set(v.category, []);
      order.push(v.category);
    }
    byCategory.get(v.category)!.push(v.signature);
  }
  return order
    .map((cat) => `  ${CATEGORY_LABELS[cat] ?? cat}: ${byCategory.get(cat)!.join(", ")}`)
    .join("\n");
}

// ---- The ≤2KB quick-start = the figma_execute_code description. Critical-first: execution model, generated
// verb signatures, the must-knows, the pointer to the reference tool. ----
export function buildQuickStart(): string {
  const verbLines = quickStartVerbLines();
  const quickStart = `Execute JavaScript against the live Figma Plugin API (figma.*) in the plugin sandbox. The \`flcm\` DSL is already in scope — prefer it over raw figma.*.

EXECUTION MODEL — your code runs in an async function body: use \`await\` directly and \`return <value>\`. Each call runs in its OWN scope — thread state by returning ids/keys and re-targeting them (flcm.get).

DESCRIBE an inert tree, then RENDER once:
  const t = flcm.frame({ layout:{ mode:"column", gap:16 } }, [ flcm.text("Hi",{ color:"#111" }) ]);
  const out = await flcm.render(t);   // creates nodes → { root, keyed }

VERBS (nothing else is on \`flcm\`):
${verbLines}

MUST-KNOW
- Constructors are inert — only \`await flcm.render(tree)\` creates anything.
- Return ids/handles, NEVER live Figma nodes (they can't cross the bridge).
- width/height & layout.gap/padding are px NUMBERS (w/h also "fill"/"hug"); colors/gradients/shadows ARE CSS strings.
- Anything outside the documented CSS subset FAILS LOUD, never wrong pixels.

FULL DOCS — get_flcm_reference(sections?): ${SECTION_IDS.join(", ")} (["all"] = everything).

RETURNS { result, console, errors } — result: your value, JSON-safe (live nodes collapse to { id, name, type }); console: captured console.*; errors: the error string, else null.

Raw figma.*: fills are 0–1, assigned as a NEW array; load a font before setting characters; a node is invisible until appended.`;

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

// Claude Code truncates a tool RESULT near ~25K tokens, and a truncated reference silently drops the tail
// an agent needs. The full reference is ~18K chars (~5K tokens) today — comfortably under — but the
// ["all"]/multi-section payload must trip THIS guard as sections grow, rather than being cut mid-doc in an
// agent's context. docs:check renders the whole reference through here, so overflow fails validate (tier-2)
// instead of surfacing at runtime. ~4 chars/token puts ~25K tokens near 100K chars; we guard well below.
const REFERENCE_LIMIT_BYTES = 80_000;

function capped(doc: string): string {
  const bytes = Buffer.byteLength(doc, "utf8");
  if (bytes > REFERENCE_LIMIT_BYTES) {
    throw new Error(
      `flcm reference payload is ${bytes} bytes, over the ${REFERENCE_LIMIT_BYTES}B get_flcm_reference cap — ` +
        `Claude Code truncates a tool result near ~25K tokens, and a truncated reference silently drops the ` +
        `tail. Split the reference into more sections or raise the cap deliberately.`,
    );
  }
  return doc;
}

// ---- The sectioned reference tool. No/empty sections → index + cheat-sheet. An "all" member → the whole
// reference in one call. Otherwise the named sections, DEDUPED and in canonical (SECTIONS) order, each
// under its own heading — so an agent can assemble the whole picture (or any subset) in ONE call instead
// of many. Unknown ids are dropped with a note rather than erroring, so a wrong name self-corrects. ----
export function buildReferenceSections(sections?: string[]): string {
  if (!sections || !sections.length) return indexBody();
  const wanted = sections.map((s) => s.trim().toLowerCase());
  if (wanted.includes("all")) return capped(buildFullReference());
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
  const parts = chosen.map((s) => `# flcm reference — ${s.title}\n\n${s.body()}`);
  if (unknown.length) {
    parts.push(
      `_Ignored unknown section${unknown.length > 1 ? "s" : ""}: ${unknown.map((u) => `"${u}"`).join(", ")}. Valid: ${SECTION_IDS.join(", ")}._`,
    );
  }
  return capped(parts.join("\n\n---\n\n"));
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

- Constructors are inert; only \`await flcm.render(tree)\` creates nodes → \`{ root, keyed }\`.
- Return ids/handles, never live Figma nodes.
- \`width\`/\`height\` and \`layout.gap\`/\`layout.padding\` are numbers (px) or \`"fill"\`/\`"hug"\` (width/height); colors/gradients/shadows are CSS strings.
- Out-of-subset CSS fails loud.`;
}

// The whole reference, in section order — the committed human doc is regenerated from this, so repo and
// served docs are the same bytes.
export function buildFullReference(): string {
  const body = SECTIONS.map((s) => `## ${s.title}\n\n${s.body()}`).join("\n\n");
  return `# Authoring with \`flcm\`\n\n${MENTAL_MODEL}\n\n${body}\n`;
}

export { SECTION_IDS };
