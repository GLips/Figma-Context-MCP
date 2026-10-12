/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import ts from "typescript";
// Regenerate (or drift-check) the two GENERATED flcm-docs artifacts from the same source the
// get_flcm_reference tool serves — so the doc a human reads in the repo, the strings the server
// ships, and the code that just type-checked share one source:
//
//   • src/commercial/tools/flcm-docs/examples-code.generated.ts — the marked region of each worked example
//     (examples/<id>.ts) and each named narrative sample (examples/narrative-samples.ts), transpiled
//     to runnable JavaScript. The sources stay real .ts files the root tsc program type-checks; the
//     runtime imports these strings instead of reading source files, because the npm product runs
//     from a tsup bundle where sources aren't on disk.
//   • plugin/docs/authoring/flcm.md — the committed human-readable authoring doc, rendered by the
//     SAME generator that feeds the get_flcm_reference tool.
//
//   pnpm docs:gen     → write both
//   pnpm docs:check   → fail if either committed artifact is stale (wired into validate)
//
// The banner marks each file as generated; the doc body is buildFullReference() verbatim (the same
// content the reference tool serves section by section). License headers are part of the generated
// content, so docs:check's drift check covers them too: the examples module is commercial like its
// sources, while the doc is an explicit MIT exception so the public reference stays public.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMERCIAL_HEADER, MIT_DOC_MARKER } from "./check-license-headers.mjs";

const FLCM_DOCS_DIR = new URL("../src/commercial/tools/flcm-docs/", import.meta.url);
const DOC_PATH = fileURLToPath(new URL("../plugin/docs/authoring/flcm.md", import.meta.url));
const EXAMPLES_MODULE_PATH = fileURLToPath(new URL("examples-code.generated.ts", FLCM_DOCS_DIR));

// Keys double as file names: examples/<id>.ts. Adding an example = add the file, add its id here,
// add its title/intro in examples.ts, run docs:gen.
const EXAMPLE_IDS = ["login", "grid", "reuse", "makeComponent", "components"] as const;

const START = "// example:start";
const END = "// example:end";

function readExampleSource(name: string): { path: string; lines: string[] } {
  const path = fileURLToPath(new URL(`examples/${name}.ts`, FLCM_DOCS_DIR));
  return { path, lines: readFileSync(path, "utf8").split("\n") };
}

// Type-checking happened in the root tsc program; this only cuts the TS-only syntax (annotations,
// `!`, `as`, type arguments) out of the source text, so the served code keeps the layout it was
// written in — TS's printer would re-indent it. Two proofs keep the cut honest: both texts transpile
// alike (only type syntax went), and the result holds no type syntax (nothing TS-only stayed).
const PRINT_OPTIONS = {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
};
function toJavaScript(region: string[]): string {
  const source = dedent(region);
  const file = ts.createSourceFile("region.ts", source, ts.ScriptTarget.ES2022, true);
  const cuts: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return; // cut whole by its owner; a nested cut would overlap
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.type) {
      cuts.push([(node.questionToken ?? node.name).end, node.type.end]);
    } else if (ts.isFunctionLike(node) && node.type) {
      const colon = node.getChildren().find((child) => child.kind === ts.SyntaxKind.ColonToken)!;
      cuts.push([colon.getStart(), node.type.end]); // the return type
    } else if (ts.isNonNullExpression(node)) {
      cuts.push([node.expression.end, node.end]);
    } else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      cuts.push([node.expression.end, node.end]);
    } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.typeArguments) {
      cuts.push([node.typeArguments.pos - 1, node.typeArguments.end + 1]); // the `<` … `>` around them
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  let code = source;
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0]))
    code = code.slice(0, from) + code.slice(to);
  const print = (text: string) => ts.transpileModule(text, PRINT_OPTIONS).outputText;
  const hasTypeSyntax = (node: ts.Node): boolean =>
    ts.isTypeNode(node) ||
    ts.isNonNullExpression(node) ||
    ts.forEachChild(node, hasTypeSyntax) === true;
  const left = ts.createSourceFile("region.ts", code, ts.ScriptTarget.ES2022, true);
  if (print(code) !== print(source) || hasTypeSyntax(left)) {
    throw new Error(
      `Cannot serve this region as JavaScript — it uses TS syntax the doc generator doesn't strip:\n${source}`,
    );
  }
  return code.trim();
}

// Pull the marked region out of an example file and dedent it to column 0. Markers are matched as
// whole lines (trimmed), so a stray mention of the token in prose can't be mistaken for a real
// marker. Fail loud if they're gone: a silently-empty example is exactly the stale-docs failure
// this generator exists to kill.
function extractExample(id: string): string {
  const { path, lines } = readExampleSource(id);
  const start = lines.findIndex((l) => l.trim() === START);
  const end = lines.findIndex((l) => l.trim() === END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `Cannot inline example: the ${START} / ${END} marker lines are missing or out of order in ${path}.`,
    );
  }
  return toJavaScript(lines.slice(start + 1, end));
}

// Every `// sample:start <id>` … `// sample:end` region of the narrative samples file, in file order.
// The ids become NARRATIVE_SAMPLES keys, so narrative.ts naming a missing one fails to compile.
const SAMPLE_START = /^\/\/ sample:start (\w+)$/;
const SAMPLE_END = "// sample:end";
function extractNarrativeSamples(): [string, string][] {
  const { path, lines } = readExampleSource("narrative-samples");
  const samples: [string, string][] = [];
  for (let i = 0; i < lines.length; i++) {
    const id = SAMPLE_START.exec(lines[i].trim())?.[1];
    if (!id) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === SAMPLE_END);
    const nextStart = lines.findIndex((l, j) => j > i && SAMPLE_START.test(l.trim()));
    if (end === -1 || (nextStart !== -1 && nextStart < end)) {
      throw new Error(
        `Narrative sample '${id}' in ${path} has no ${SAMPLE_END} before the next sample.`,
      );
    }
    if (samples.some(([seen]) => seen === id))
      throw new Error(`Narrative sample '${id}' appears twice in ${path}.`);
    samples.push([id, toJavaScript(lines.slice(i + 1, end))]);
    i = end;
  }
  return samples;
}

// Strip the common leading indentation (the region sits inside a function body) and trim blank edges.
function dedent(lines: string[]): string {
  const body = [...lines];
  while (body.length && body[0].trim() === "") body.shift();
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  const indents = body.filter((l) => l.trim().length).map((l) => l.match(/^ */)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return body.map((l) => l.slice(min)).join("\n");
}

// Emit each example as a template literal (backslash-escaped) rather than a JSON one-liner: the
// generated module stays readable in diffs and stable under prettier, which never reformats
// template-literal contents.
function templateLiteral(code: string): string {
  return "`" + code.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

function buildExamplesModule(): string {
  const entries = EXAMPLE_IDS.map((id) => `  ${id}: ${templateLiteral(extractExample(id))},`);
  const samples = extractNarrativeSamples().map(
    ([id, code]) => `  ${id}: ${templateLiteral(code)},`,
  );
  return (
    COMMERCIAL_HEADER +
    "// Generated by `pnpm docs:gen` (scripts/gen-flcm-doc.ts) — do not edit.\n" +
    "// Each entry is a marked region of examples/, extracted (dedented, TS syntax stripped) so the\n" +
    "// served code is the code that type-checked. `pnpm docs:check` fails on drift.\n" +
    "\n" +
    "export const EXAMPLE_CODE = {\n" +
    entries.join("\n") +
    "\n} as const;\n" +
    "\n" +
    "export const NARRATIVE_SAMPLES = {\n" +
    samples.join("\n") +
    "\n} as const;\n"
  );
}

// Provenance is a VISIBLE blockquote, not an HTML comment: the repo's hidden-char
// scanner rejects long HTML comments (a prompt-injection vector), and a human
// reading the rendered doc should see the "do not edit" warning anyway. The SPDX marker is the one
// HTML comment: short enough for the scanner, and machine-readable where the prose note is not.
const BANNER =
  MIT_DOC_MARKER +
  "> **Generated — do not edit.** Regenerate with `pnpm docs:gen`.\n" +
  "> Source: `plugin/src/preamble/schema.ts` (verbs/props) + `src/commercial/tools/flcm-docs/{narrative,examples}`.\n" +
  "> License: this generated reference is MIT, unlike its commercial sources, so public docs stay public.\n\n";

const mode = process.argv[2];

// In check mode, fail if the committed artifact no longer matches what the generator produces;
// otherwise (re)write it.
function syncArtifact(path: string, expected: string, staleReason: string): void {
  if (mode === "check") {
    if (readFileSync(path, "utf8") !== expected) {
      console.error(`${staleReason}\nRun \`pnpm docs:gen\` and commit the result.`);
      process.exit(1);
    }
  } else {
    writeFileSync(path, expected);
    console.log(`Wrote ${path}`);
  }
}

syncArtifact(
  EXAMPLES_MODULE_PATH,
  buildExamplesModule(),
  "src/commercial/tools/flcm-docs/examples-code.generated.ts is stale — it no longer matches the " +
    "marked regions of the example sources.",
);

// Import the reference builders only now: they read the generated examples module, which the gen
// path just rewrote (and the check path just verified fresh) — a static import would render the
// doc from stale strings.
const { buildFullReference, buildQuickStart, oversizedReferenceSections } = await import(
  "../src/commercial/tools/flcm-docs/reference.js"
);
const { CLI_DOCS_CHANNEL, MCP_DOCS_CHANNEL } = await import(
  "../src/commercial/tools/flcm-docs/channels.js"
);

// Building the quick-start here (not just the full doc) makes its ≤2KB cap a validate-time gate: the
// call throws if the figma_execute_code description ever overflows, so `docs:check` fails rather than
// the server silently shipping a truncated contract.
buildQuickStart(MCP_DOCS_CHANNEL);
buildQuickStart(CLI_DOCS_CHANNEL);

// Same idea for the get_flcm_reference size cap. A section over the response budget is unreachable
// through the tool — the budget loop always emits the first one — so fail validate here rather than at
// runtime, as a silently-truncated tool result in an agent's context.
const oversized = oversizedReferenceSections([MCP_DOCS_CHANNEL, CLI_DOCS_CHANNEL]);
if (oversized.length) {
  console.error(
    oversized
      .map(
        (s) =>
          `get_flcm_reference section "${s.id}" is ${s.bytes} bytes, over the ${s.limit}B response budget — ` +
          `no agent can read it. Split it or trim it.`,
      )
      .join("\n"),
  );
  process.exit(1);
}

syncArtifact(
  DOC_PATH,
  // The committed doc speaks the MCP channel: it is what the get_flcm_reference tool serves.
  BANNER + buildFullReference(MCP_DOCS_CHANNEL),
  "plugin/docs/authoring/flcm.md is stale — it no longer matches the generated reference.",
);
if (mode === "check") console.log("flcm docs are in sync with the schema.");
