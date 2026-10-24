/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// reference — the doc generator. It turns the schema (the single source: every verb/prop/type/one-liner)
// plus the hand-written narrative fragments plus the compile-checked examples into two deliverables:
//   • buildQuickStart()          → the ≤2KB figma_execute_code description (critical-first, signatures
//     generated), also printed by `execute --help`.
//   • buildReferenceSections(s)  → the get_flcm_reference tool / `reference` command output: the named
//     sections, or a refusal naming the sections when none were asked for.
// Both are served over MCP and the CLI, so every pointer to screenshots or more docs is spelled by a
// DocsChannel (channels.ts).
// buildFullReference() concatenates every section for the committed human doc (slice: flcm.md regen), so
// the repo doc and the served doc are assembled from the SAME source and cannot drift.
//
// Nothing here is hand-maintained per-prop: the prop/verb tables are walked from the zod schemas, so a
// prop that isn't in the schema can't appear in any output, and a deleted one vanishes everywhere at once.

import { z } from "zod";
import {
  VERBS,
  FIELD_GROUPS,
  TYPE_WORD_GROUPS,
  CREATE_ONLY_WORDS,
  editWordsOf,
  FrameSchema,
  TextSchema,
  ShapeSchema,
  EllipseSchema,
  LineSchema,
  PathSchema,
  SvgSchema,
  InstanceSchema,
  INSTANCE_WRITE_RULES,
  instanceWordsVerifiedToLand,
  type VerbCategory,
} from "@framelink/plugin/schema";
import {
  mentalModel,
  CHILDREN,
  RICH_TEXT,
  LAYOUT_MODEL,
  VECTOR_INTRO,
  PAINT_INTRO,
  IMAGE_INTRO,
  EFFECTS_INTRO,
  TOKENS,
  RENDER_KEYS,
  verifyRecipe,
  RAW_FIGMA,
  PAGES,
  READS,
  annotationsReference,
  CSS_SUBSET,
  FIDELITY_AND_SCOPE,
  IMAGE_REF_REUSE,
  UNRENDERABLE_GLYPHS,
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
  INSTANCE_WRITE_RULES_INTRO,
  COMPONENTS_DETACH,
  COMPONENTS_RULES,
} from "./narrative.js";
import { EXAMPLES } from "./examples.js";
import type { DocsChannel } from "./channels.js";

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

// Input aliases are accepted by the schemas but never documented: flcm broadcasts one
// vocabulary, and an alias an agent reads becomes a second spelling it writes.
function documentedFields(fields: Fields): [string, z.ZodType][] {
  return Object.entries(fields).filter(([, field]) => !field.meta()?.inputOnly);
}

// Render a field group (name/key/opacity, size, a verb's props, …) as a markdown prop table.
function propTable(fields: Fields): string {
  const rows = documentedFields(fields).map(
    ([name, field]) =>
      `| \`${name}\` | ${cell(typeLabel(field))} | ${cell(field.description ?? "")} |`,
  );
  return ["| Prop | Type | Notes |", "| --- | --- | --- |", ...rows].join("\n");
}

// The props a node type is created with.
const CREATE_FIELDS_BY_TYPE: Record<string, Fields> = {
  FRAME: FrameSchema.shape,
  TEXT: TextSchema.shape,
  RECTANGLE: ShapeSchema.shape,
  ELLIPSE: EllipseSchema.shape,
  LINE: LineSchema.shape,
  VECTOR: { ...PathSchema.shape, ...SvgSchema.shape },
  INSTANCE: InstanceSchema.shape,
};

const words = (keys: Iterable<string>) => [...keys].map((k) => `\`${k}\``).join(", ");
const listTypes = (types: string[]) =>
  types.length > 1 ? `${types.slice(0, -1).join(", ")} and ${types.at(-1)}` : types[0];

// A node type's own fields: those that aren't the very field objects of a table printed elsewhere.
// Identity, not name — LINE's `stroke` is its own object with its own note, so it stays.
function ownFields(fields: Fields, ...printed: Fields[]): Fields {
  const shared = new Set(printed.flatMap((group) => Object.values(group)));
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => !shared.has(field)));
}

// Which node types take the shared appearance table, in full or in part, by field identity — so
// the sentence over the table can't drift from the schemas the compiler builds from.
// The path form stands in for VECTOR: an svg import's own fill/stroke repaint the art inside it.
function appearanceCoverage(): string {
  const appearance = documentedFields(FIELD_GROUPS.appearance);
  const full: string[] = [];
  const partial = new Map<string, string[]>(); // the missing words → types
  const byType: [string, Fields][] = Object.entries(CREATE_FIELDS_BY_TYPE).map(([type, fields]) =>
    type === "VECTOR" ? ["path VECTOR", PathSchema.shape] : [type, fields],
  );
  for (const [type, fields] of byType) {
    const values = new Set<z.ZodType>(Object.values(fields));
    const missing = appearance.filter(([, f]) => !values.has(f)).map(([k]) => k);
    if (!missing.length) full.push(type);
    else if (missing.length < appearance.length) {
      const key = missing.join(",");
      partial.set(key, [...(partial.get(key) ?? []), type]);
    }
  }
  const take = (types: string[]) => `${listTypes(types)} ${types.length > 1 ? "take" : "takes"}`;
  const parts = [...partial].map(
    ([missing, types]) => `${take(types)} all but ${words(missing.split(","))}`,
  );
  return `${take(full)} every prop below; ${parts.join("; ")}.`;
}

type DocumentedType = keyof typeof TYPE_WORD_GROUPS;

// The words flcm.edit takes per node type — the runtime gate's own row (vocabulary.ts editWordsOf),
// narrowed to documented words — so the doc can't promise a word the gate rejects.
function editWordsFor(type: DocumentedType): Set<string> {
  const documented = new Set(documentedFields(FIELD_GROUPS.edit).map(([key]) => key));
  return new Set([...(editWordsOf(type) ?? [])].filter((k) => documented.has(k)));
}

// Edit is create's vocabulary, so the doc prints only where the two differ: create words edit
// refuses, and the vocabularies of types that can be edited but never created.
function editExceptions(): string {
  const createOnly = new Map<string, string[]>(); // word → types
  const editOnlyByType = new Map<string, string[]>();
  for (const [type, fields] of Object.entries(CREATE_FIELDS_BY_TYPE)) {
    const editable = editWordsFor(type as DocumentedType);
    const created = documentedFields(fields).map(([k]) => k);
    for (const k of created.filter((k) => !editable.has(k)))
      createOnly.set(k, [...(createOnly.get(k) ?? []), type]);
    const extra = [...editable].filter((k) => !created.includes(k));
    if (extra.length) editOnlyByType.set(type, extra);
  }
  // Words sharing a reason and the same types print as one line.
  const allTypes = Object.keys(CREATE_FIELDS_BY_TYPE).length;
  const byReason = new Map<string, { words: string[]; types: string[] }>();
  for (const [word, types] of createOnly) {
    const reason: string | undefined = Object.prototype.hasOwnProperty.call(CREATE_ONLY_WORDS, word)
      ? CREATE_ONLY_WORDS[word as keyof typeof CREATE_ONLY_WORDS]
      : undefined;
    if (!reason)
      throw new Error(
        `flcm docgen: create word '${word}' is missing from edit with no CREATE_ONLY_WORDS reason.`,
      );
    const key = `${reason}|${types.join(",")}`;
    byReason.set(key, { words: [...(byReason.get(key)?.words ?? []), word], types });
  }
  const createLines = [...byReason].map(([key, { words: ws, types }]) => {
    const where = types.length === allTypes ? "" : ` (${listTypes(types)})`;
    return `- ${words(ws)}${where} — ${key.split("|")[0]}.`;
  });
  const extraLines = [...editOnlyByType].map(
    ([type, extra]) => `- ${type} also takes ${words(extra)}.`,
  );

  // Types with no create path, described against FRAME's words when they're close to it.
  const frame = editWordsFor("FRAME");
  const byVocabulary = new Map<string, string[]>();
  for (const type of Object.keys(TYPE_WORD_GROUPS) as DocumentedType[]) {
    if (type in CREATE_FIELDS_BY_TYPE) continue;
    const own = editWordsFor(type);
    const minus = [...frame].filter((k) => !own.has(k));
    const plus = [...own].filter((k) => !frame.has(k));
    const text =
      minus.length + plus.length < own.size
        ? "FRAME's words" +
          (minus.length ? ` without ${words(minus)}` : "") +
          (plus.length ? `, plus ${words(plus)}` : "")
        : `only ${words(own)}`;
    byVocabulary.set(text, [...(byVocabulary.get(text) ?? []), type]);
  }
  const editOnlyTypes = [...byVocabulary].map(
    ([text, types]) => `- ${listTypes(types)} — ${text}.`,
  );
  // The runtime's floor for a type with no vocabulary of its own (edit-plan.ts SHARED_DELTA_KEYS).
  const editable = new Set(documentedFields(FIELD_GROUPS.edit).map(([key]) => key));
  const floor = documentedFields(FIELD_GROUPS.shared)
    .map(([k]) => k)
    .filter((k) => editable.has(k));
  editOnlyTypes.push(`- Any other type (GROUP, SECTION, …) — only ${words(floor)}.`);

  return (
    "Create words that edit refuses:\n\n" +
    [...createLines, ...extraLines].join("\n") +
    "\n\nTypes you can edit but never create:\n\n" +
    editOnlyTypes.join("\n")
  );
}

// A rule word is code up to its first " (", which starts a plain-prose note.
const ruleWord = (word: string) => {
  const note = word.indexOf(" (");
  return note < 0 ? `\`${word}\`` : `\`${word.slice(0, note)}\`${word.slice(note)}`;
};

// Printed from the policy the authorization refuses with, so a rule or its fix can't drift from
// what the plugin enforces.
function instanceWriteRulesSection(): string {
  const rows = INSTANCE_WRITE_RULES.map((rule) => {
    const change =
      rule.words.map(ruleWord).join(", ") +
      (rule.scope === "instance-root" ? " on the instance itself" : "");
    const figma = rule.figma === "ignores" ? "ignores it" : "throws";
    return `| \`${rule.id}\` | ${cell(change)} | ${figma} | ${cell(rule.remedy)} |`;
  });
  return [
    "### What an instance takes",
    "",
    INSTANCE_WRITE_RULES_INTRO,
    "",
    "| Rule | Change | Figma | Do instead |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Verified to land on any layer inside an instance: ${instanceWordsVerifiedToLand().map(ruleWord).join(", ")}.`,
  ].join("\n");
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
  body: (channel: DocsChannel) => string;
}

// Inside a merged section, a fragment's own `###` subheadings sit one level under the section's `###`.
const demoteHeadings = (md: string) => md.replace(/^### /gm, "#### ");

// Ordered explanation → reference → recipes, so the full doc reads top-down and the first id is the
// one every agent should fetch.
const SECTIONS: Section[] = [
  // First, and named in the blank-call refusal, because it is the part that stops an agent being wrong
  // about what a spec IS — identity, copying, session lifetime. An agent that already knows enough to
  // name `verbs` or `components` never asks for a general overview, so the rules have to be reachable
  // by name.
  {
    id: "mental-model",
    title: "The mental model",
    blurb:
      "what a spec is, and the identity, copying, session and fidelity rules every other section assumes. Read this first",
    body: (channel) =>
      `${mentalModel(channel.sessionHowTo)}\n\n### Fidelity and scope\n\n${FIDELITY_AND_SCOPE}`,
  },
  {
    id: "layout",
    title: "Layout and sizing",
    blurb:
      "where sizing differs from CSS: fixed/fill/hug/percent, constraints, text width, bounds and overflow",
    body: () => LAYOUT_MODEL,
  },
  {
    id: "reads",
    title: "Reads and returned data",
    blurb:
      "what reads and returns hand back: get/find shape, using a read as a spec, elided, session.last, readOnlySource, warnings",
    body: () => READS,
  },
  {
    id: "verbs",
    title: "The verbs",
    blurb: "every verb, render and keys, placing/moving/removing nodes, and pages",
    body: () =>
      `\`flcm\` exposes exactly these. Nothing else is on the \`flcm\` object.\n\n${verbTable()}\n\n` +
      "Nodes are data with type FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR or INSTANCE. " +
      "gradient, image and effects produce reusable values for props.\n\n" +
      `### Children and composition\n\n${CHILDREN}\n\n` +
      `### render(), keys & handles\n\n${RENDER_KEYS}\n\n` +
      `### Tree shape — placing, moving, removing\n\n${STRUCTURE_INTRO}\n\n${STRUCTURE_RULES}\n\n` +
      `### Pages\n\n${PAGES}`,
  },
  {
    id: "props",
    title: "Props by node",
    blurb: "every prop on every node type, with types",
    body: () =>
      "Props use CSS names and CSS value syntax; the notes say only where flcm differs.\n\n" +
      "New nodes require type; INSTANCE also requires componentId, and VECTOR exactly one geometry prop (see vector art in values). " +
      "An id refers to a live node; type can be omitted for a move. children is an array of plain specs. " +
      "Other omitted props keep live values or use creation defaults. The verb returns the spec copied with ids.\n\n" +
      `### Shared by every node\n\n${propTable(FIELD_GROUPS.shared)}\n\n` +
      "### Size & position (FRAME, TEXT, RECTANGLE, ELLIPSE, VECTOR, INSTANCE)\n\n" +
      'A LINE sizes along its length alone, its `width`: a number, or `"fill"` under a row or column parent — the divider case, ' +
      'where the flow supplies the length. There is no `height`, no `"hug"` and no percent.\n\n' +
      `${propTable(FIELD_GROUPS.size)}\n\n` +
      "How these sizes resolve is in the layout section.\n\n" +
      `### Appearance — paint, border, corners, effects, rotation\n\n${appearanceCoverage()}\n\n${propTable(FIELD_GROUPS.appearance)}\n\n` +
      `### FRAME — container props\n\n${propTable(FIELD_GROUPS.frame)}\n\n` +
      `#### Auto-layout config (the \`layout\` object)\n\n${propTable(FIELD_GROUPS.containerLayout)}\n\n#### Placement under a parent (in the same \`layout\` object)\n\n${propTable(FIELD_GROUPS.childLayout)}\n\n` +
      `### TEXT — text props\n\n${propTable(FIELD_GROUPS.text)}\n\n` +
      "`text` is a string or array of styled runs. `fill` is its paint. " +
      "`boldWeight` says what `**` in `text` resolves to. How a text sizes without a fixed `width` is under text width in layout.\n\n" +
      `#### Text style (the \`textStyle\` object)\n\n${propTable(FIELD_GROUPS.textStyle)}\n\n` +
      `#### Unrenderable glyphs\n\n${UNRENDERABLE_GLYPHS}\n\n` +
      `### TEXT — rich text (runs)\n\n${RICH_TEXT}\n\nEach styled run's delta fields:\n\n${propTable(FIELD_GROUPS.run)}\n\n` +
      `### LINE — line props\n\nA LINE takes the placement words from Size & position, but not its size words, plus:\n\n${propTable(ownFields(FIELD_GROUPS.line, FIELD_GROUPS.size))}\n\n` +
      `### VECTOR — path props (\`d\` / \`vectorPaths\`)\n\nBare geometry: the node's box is the path's bounding box, so there is no \`width\`/\`height\` here — \`scale\` is the size word.\n\n${propTable(ownFields(FIELD_GROUPS.path, FIELD_GROUPS.appearance))}\n\n` +
      `### VECTOR — svg props (\`svg\`)\n\nA canvas of art, so it takes the shared and size/position props too. These two reach the vectors INSIDE the import.\n\n${propTable(FIELD_GROUPS.svg)}\n\n` +
      // The instance table prints once, here beside its sibling node types; the components section's
      // prose explains the same two words at length rather than repeating the table.
      "### INSTANCE — component words\n\n(An instance also takes every `FRAME` prop above; each one " +
      "named is a root-level override. `componentId` names the component in the props form, and swaps it under edit — see the components section.)\n\n" +
      `${propTable({ ...FIELD_GROUPS.swap, ...FIELD_GROUPS.instance })}`,
  },
  {
    id: "annotations",
    title: "Annotations",
    blurb: "reading and writing Figma's native layer annotations",
    body: (channel) =>
      `${propTable(FIELD_GROUPS.annotation)}\n\n${annotationsReference(channel.commentsHowTo)}`,
  },
  {
    id: "values",
    title: "Values — colors, gradients, images, effects, tokens, vector art",
    blurb:
      "the CSS subset, paint and flcm.gradient, flcm.image, flcm.effects, variable and style references, and svg/path vector art",
    body: () =>
      `### The CSS subset\n\n${demoteHeadings(CSS_SUBSET)}\n\n` +
      `### Paint & gradients\n\n${PAINT_INTRO}\n\n#### flcm.gradient fields\n\n${propTable(FIELD_GROUPS.gradient)}\n\n` +
      `### Images\n\n${IMAGE_INTRO}\n\n${IMAGE_REF_REUSE}\n\n#### flcm.image opts\n\n${propTable(FIELD_GROUPS.image)}\n\n` +
      `### Effects\n\n${EFFECTS_INTRO}\n\n#### flcm.effects fields\n\n${propTable(FIELD_GROUPS.effects)}\n\n` +
      `### Variables and styles\n\n${TOKENS}\n\n` +
      `### Vector art (svg & path)\n\n${VECTOR_INTRO}`,
  },
  {
    id: "edit",
    title: "edit() / editMany() — changing existing nodes",
    blurb: "partial deltas against live nodes, batching them atomically, and the rollback contract",
    body: () =>
      `${EDIT_INTRO}\n\n### Where edit differs from create\n\n${editExceptions()}\n\n` +
      `${EDIT_REMOVAL}\n\n${EDIT_RULES}\n\n${EDIT_MANY}`,
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
      `${COMPONENTS_EDIT}\n\n${instanceWriteRulesSection()}\n\n${COMPONENTS_DETACH}\n\n${COMPONENTS_RULES}`,
  },
  {
    id: "recipes",
    title: "Recipes",
    blurb:
      "how-tos by task: check what you built, build a screen, lay out a grid, copy from the canvas, make and use components, document operations",
    // Check-what-you-built leads because every other recipe finishes with it.
    body: (channel) =>
      `### Check what you built\n\n${verifyRecipe(channel.screenshotHowTo)}\n\n` +
      EXAMPLES.map((ex) => `### ${ex.title}\n\n${ex.intro}\n\n\`\`\`js\n${ex.code}\n\`\`\``).join(
        "\n\n",
      ) +
      `\n\n### Move the viewport, selection and other document state\n\n${RAW_FIGMA}`,
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
function docsPointer(channel: DocsChannel): string {
  return `FULL DOCS — ${channel.referenceCall([SECTION_IDS[0]])} first, then: ${SECTION_IDS.slice(1).join(", ")}.`;
}

// ---- The ≤2KB quick-start = the figma_execute_code description. Critical-first: execution model, generated
// verb signatures, the must-knows, the pointer to the reference tool. ----
export function buildQuickStart(channel: DocsChannel): string {
  const verbLines = quickStartVerbLines();
  const quickStart = `Execute JavaScript in Figma with \`flcm\`.

EXECUTION: await/return directly; await every mutation. Not a transaction: verbs commit alone; after an error, inspect before retrying. Only session survives calls.${channel.savedScriptHowTo ? `\n\n${channel.savedScriptHowTo}` : ""}

AUTHOR:
  const t = { type:"FRAME", layout:{ mode:"column", gap:16 }, children:[{ type:"TEXT", text:"Hi" }] };
  session.screen = await flcm.render(t); // copied spec with ids
  // id: move + edit; no id: create, at every depth.

VERBS — all on \`flcm.\`, nothing else is:
${verbLines}

MUST-KNOW
- Store plain data; return ids for live nodes.
- find predicates see the full read shape. Reads project at return/console: elided = cut sizes in JSON chars. Survey session.last or flcm.get(id); never rerun edits. Computed data stays whole.
- Metrics take a number or "Npx"; width/height also take "N%", "fill", "hug". Colors/gradients/shadows are CSS strings. Bind designTokens(), not literals.
- Unsupported CSS fails loud.

${docsPointer(channel)}

RETURNS { result, console, errors }: JSON-safe result, console lines, error or null.`;

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
/** Every section id with its one-line blurb, in canonical order. */
export function buildReferenceMenu(): string {
  return SECTIONS.map((s) => `- \`${s.id}\` — ${s.blurb}`).join("\n");
}

function blankCallRefusal(note: string, channel: DocsChannel): string {
  return (
    `# flcm reference\n\n${note}` +
    "The reference needs the sections you want, so this call returned none. " +
    `Retry naming them — start with \`${channel.referenceCall([SECTION_IDS[0]])}\`. ` +
    "Several ids in one call are served together, deduped and in the order below.\n\n" +
    buildReferenceMenu()
  );
}

// ---- The sectioned reference tool. The named sections, DEDUPED and in canonical (SECTIONS) order, each
// under its own heading — so an agent can assemble the whole picture (or any subset) in ONE call instead of
// many. Unknown ids are dropped with a note rather than erroring, so a wrong name self-corrects. ----
export function buildReferenceSections(
  sections: string[] | undefined,
  channel: DocsChannel,
): string {
  const wanted = (sections ?? []).map((s) => s.trim().toLowerCase());
  const chosen = SECTIONS.filter((s) => wanted.includes(s.id)); // canonical order + dedupe
  const unknown = wanted.filter((w) => !SECTION_IDS.includes(w));
  if (!chosen.length) {
    const note = unknown.length ? `No section ${unknown.map((u) => `"${u}"`).join(", ")}.\n\n` : "";
    return blankCallRefusal(note, channel);
  }

  // Fill the budget in canonical order, then say out loud which sections didn't fit and how to get them.
  // Never silently truncate: an agent that can't tell a short answer from a cut one guesses at the rest.
  const parts: string[] = [];
  const dropped: string[] = [];
  let bytes = 0;
  for (const section of chosen) {
    const part = `# flcm reference — ${section.title}\n\n${section.body(channel)}`;
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
        `${dropped.map((d) => `\`${d}\``).join(", ")}. Run \`${channel.referenceCall(dropped)}\` for ${dropped.length > 1 ? "them" : "it"}._`,
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
export function oversizedReferenceSections(
  channels: DocsChannel[],
): { id: string; bytes: number; limit: number }[] {
  return SECTIONS.map((s) => ({
    id: s.id,
    bytes: Math.max(
      ...channels.map((c) =>
        Buffer.byteLength(`# flcm reference — ${s.title}\n\n${s.body(c)}`, "utf8"),
      ),
    ),
    limit: REFERENCE_LIMIT_BYTES,
  })).filter((s) => s.bytes > s.limit);
}

// The whole reference, in section order — the committed human doc is regenerated from this, so repo and
// served docs are the same bytes. The mental model rides in as the first section, not separately.
export function buildFullReference(channel: DocsChannel): string {
  const body = SECTIONS.map((s) => `## ${s.title}\n\n${s.body(channel)}`).join("\n\n");
  return `# Authoring with \`flcm\`\n\n${body}\n`;
}

export { SECTION_IDS };
