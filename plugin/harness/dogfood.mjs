// Port-free dogfood runner: executes a DSL file against the in-memory figma mock, exercising the
// SAME plugin/src/preamble/ fragments the live sandbox uses (bundled fresh each run via esbuild — NOT
// forked), then prints a compact tree of what got built. Usage:
//
//   node plugin/harness/dogfood.mjs <file.js>
//   pnpm --filter @framelink/plugin dogfood harness/scenarios/settings-panel.js
//
// A green run validates the real DSL logic (helpers, guards, reconcile, overrides, composite ids, hex,
// errors). It does NOT validate pixel-exact layout or fonts — see harness/README.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFigmaMock } from "./figma-mock.mjs";
import { buildSandboxPreamble } from "../src/preamble/index.mjs";

const fileArg = process.argv[2];
if (!fileArg) { console.error("usage: node harness/dogfood.mjs <file.js>"); process.exit(2); }

// 1. Generate SANDBOX_PREAMBLE through the one seam (same string the plugin ships) — the generator
//    owns fragment layout, order, and the esbuild flatten; this consumer just asks for the string.
const SANDBOX_PREAMBLE = await buildSandboxPreamble();

// 2. Mock figma + capture console (mirrors code.ts's console capture for parity).
createFigmaMock();
// Mid-run image channel (protocol 2): the live sandbox awaits the server over the WS bridge; the
// harness answers instantly with stand-in bytes so image scenarios run headless. Installed on
// globalThis because the indirect eval below runs in global scope (the live path resolves the same
// free identifier to executeCode's direct-eval local instead).
globalThis.__flcmRequestImages = async (urls) =>
  Object.fromEntries(urls.map((u) => [u, Buffer.from("harness-image-bytes").toString("base64")]));
const userCode = readFileSync(resolve(process.cwd(), fileArg), "utf8");
const log = [];
const real = { ...console };
for (const lvl of ["log", "info", "warn", "error"]) console[lvl] = (...a) => log.push(`[${lvl}] ${a.join(" ")}`);

// 3. Run in the same async-IIFE shape as executeCode in code.ts (indirect eval -> global scope, so
//    the preamble's `figma`/`console`/`Promise` references resolve to globals).
let result, error = null;
try {
  result = await (0, eval)("(async function(){ " + SANDBOX_PREAMBLE + "\n;\n" + userCode + "\n })()");
} catch (e) {
  error = e && e.stack ? e.stack : String(e);
} finally {
  Object.assign(console, real);
}

// 4. Report.
const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
function paintStr(f) {
  if (f.type === "SOLID") {
    let s = "#" + toHex(f.color.r) + toHex(f.color.g) + toHex(f.color.b);
    if (f.opacity != null && f.opacity < 0.999) s += toHex(f.opacity);
    return s;
  }
  if (typeof f.type === "string" && f.type.startsWith("GRADIENT_")) {
    const stops = (f.gradientStops || []).map((g) => "#" + toHex(g.color.r) + toHex(g.color.g) + toHex(g.color.b)).join("→");
    return `${f.type.replace("GRADIENT_", "").toLowerCase()}-gradient(${stops})`;
  }
  if (f.type === "IMAGE") return `image(${f.scaleMode})`;
  return f.type;
}
function effectsStr(n) {
  if (!n.effects || !n.effects.length) return "";
  return n.effects.map((e) => {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") return `${e.type === "INNER_SHADOW" ? "inner" : "drop"}-shadow(${e.offset.x},${e.offset.y},r${e.radius})`;
    if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") return `${e.type === "BACKGROUND_BLUR" ? "bg" : "layer"}-blur(${e.radius})`;
    return e.type;
  }).join(" ");
}
function printTree(n, depth, out) {
  const pad = "  ".repeat(depth);
  let s = `${pad}${n.type} "${n.name}"`;
  if (n.type !== "PAGE") s += `  ${Math.round(n.width)}x${Math.round(n.height)}`;
  if (n._isAuto) s += `  [${n.layoutMode.toLowerCase()}${n.itemSpacing ? " gap=" + n.itemSpacing : ""}]`;
  if (n.layoutPositioning === "ABSOLUTE") s += `  @abs(${n.x},${n.y})`;
  else if (n.x || n.y) s += `  @(${n.x},${n.y})`;
  if (n.rotation) s += `  rot=${n.rotation}`;
  if (n.type === "TEXT" && n.characters) s += `  ${JSON.stringify(n.characters)}`;
  if (n.fills && n.fills.length) s += `  fill=${paintStr(n.fills[0])}`;
  if (n.strokes && n.strokes.length) s += `  stroke=${paintStr(n.strokes[0])}`;
  const fx = effectsStr(n);
  if (fx) s += `  ${fx}`;
  if (n.clipsContent) s += `  clip`;
  if (n.opacity < 1) s += `  opacity=${n.opacity}`;
  out.push(s);
  for (const c of n.children) printTree(c, depth + 1, out);
}

const out = [];
for (const root of figma.currentPage.children) printTree(root, 0, out);
console.log(out.join("\n") || "(nothing built)");
if (log.length) console.log("\n— console —\n" + log.join("\n"));
if (result !== undefined) console.log("\n— returned —\n" + JSON.stringify(result, null, 2));
if (error) { console.error("\n— ERROR —\n" + error); process.exit(1); }
