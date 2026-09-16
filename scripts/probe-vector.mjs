// Live VECTOR authoring probe. Run `pnpm probe:vector`, open Framelink in a scratch Figma file,
// then approve the pairing code. Import plugin/manifest.json after `pnpm build:plugin` if needed.
// The preamble is built from this checkout, so preamble changes need no plugin re-import.
// Set FRAMELINK_STATE_DIR to a writable, isolated directory to keep approval/session state
// separate from your normal server. This script creates probe nodes and removes them in finally.
//
// It verifies the two vector forms against live Figma: that a `d` path takes its geometry's bounding
// box (and that `width`/`height` beside it are ignored with a warning, while `scale` multiplies it),
// and that an `svg` import is a canvas whose art both themes through fill/stroke and SCALES when the
// frame is resized. The mock can only assert what we told it; these are the facts Figma owns.
//
// It also OBSERVES what raw figma.createNodeFromSvg leaves on the vectors it parses. The plugin
// typings say nothing about this (the whole entry is `createNodeFromSvg(svg: string): FrameNode`),
// so flcm sets SCALE itself — the observation records whether that is belt-and-braces or load-bearing.

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";
import { MIN_PROTOCOL_VERSION } from "../src/services/plugin-bridge/version.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";

// The real plugin holds no runtime of its own (ADR-0010), so the probe ships the actual std-lib
// through the same seam the server build uses — which is why a preamble fix needs no re-import.
const PREAMBLE = await buildSandboxPreamble();

const EXPECTED_CHECKS = 8;

const t0 = Date.now();
const log = (msg) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const PROBE_CODE = `
const roots = [];
const checks = [];
const observations = [];
function check(name, actual, expected) {
  checks.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
}
// A chevron whose own coordinates span 6 wide by 12 tall — the canonical "icon on a 24 grid" path.
const CHEVRON = "M15 18 L9 12 L15 6";
const MARKUP = '<svg viewBox="0 0 24 24" width="24" height="24"><g><path d="' + CHEVRON + '" fill="none" stroke="#0B1020" stroke-width="2"/></g></svg>';
const artOf = (node) => node.type === "VECTOR" ? [node] : (node.children || []).flatMap(artOf);
try {
  // --- OBSERVATION: what does Figma's own importer leave on the parsed vectors?
  const raw = figma.createNodeFromSvg(MARKUP);
  figma.currentPage.appendChild(raw);
  roots.push(raw.id);
  observations.push({
    name: "raw createNodeFromSvg descendant constraints (before flcm touches them)",
    // A GROUP has no constraints and Figma's getter throws rather than returning undefined; capture that
    // as a fact of its own instead of letting the observation kill the checks.
    value: (raw.children || []).flatMap(function walk(n) {
      let constraints; try { constraints = n.constraints; } catch (error) { constraints = "throws: " + String(error); }
      return [[n.type, constraints]].concat((n.children || []).flatMap(walk));
    }),
  });

  // --- The path form is bare geometry.
  const bare = await flcm.render({ type: "VECTOR", name: "path probe", d: CHEVRON, stroke: "#0B1020", strokeWidth: 2, left: 0, top: 100 });
  roots.push(bare.id);
  const bareBox = await flcm.measure(bare);
  check("a path's box is its geometry's bounding box", [Math.round(bareBox.width), Math.round(bareBox.height)], [6, 12]);

  // width/height are the canvas instinct — ignored, with a warning the driver checks in the reply.
  const sized = await flcm.render({ type: "VECTOR", name: "ignored size probe", d: CHEVRON, stroke: "#0B1020", width: 24, height: 24, left: 40, top: 100 });
  roots.push(sized.id);
  const sizedBox = await flcm.measure(sized);
  check("width/height beside d leave the natural box", [Math.round(sizedBox.width), Math.round(sizedBox.height)], [6, 12]);

  const scaled = await flcm.render({ type: "VECTOR", name: "scale probe", d: CHEVRON, stroke: "#0B1020", scale: 3, left: 80, top: 100 });
  roots.push(scaled.id);
  const scaledBox = await flcm.measure(scaled);
  check("scale multiplies the natural box uniformly", [Math.round(scaledBox.width), Math.round(scaledBox.height)], [18, 36]);

  // --- The svg form is a canvas of themeable art.
  const icon = await flcm.render({ type: "VECTOR", name: "svg probe", svg: MARKUP, fill: "#FF0000", width: 24, height: 24, left: 140, top: 100 });
  roots.push(icon.id);
  const native = await figma.getNodeByIdAsync(icon.id);
  check("an svg import renders a FRAME sized like a canvas", [native.type, Math.round(native.width), Math.round(native.height)], ["FRAME", 24, 24]);
  // Live Figma turns <g> into a GROUP, which has no constraints at all; only constraint-bearing
  // descendants are asked, and there must be at least one.
  const constrained = (native.children || []).flatMap(function walk(n) { return ("constraints" in n ? [n.constraints.horizontal + "/" + n.constraints.vertical] : []).concat((n.children || []).flatMap(walk)); });
  check("flcm sets SCALE on every constraint-bearing descendant of the import", [constrained.length > 0, constrained.every(c => c === "SCALE/SCALE")], [true, true]);
  check("fill beside svg repaints the vectors inside",
    artOf(native).map(v => v.fills.length && v.fills[0].type === "SOLID" ? [Math.round(v.fills[0].color.r * 255), Math.round(v.fills[0].color.g * 255), Math.round(v.fills[0].color.b * 255)] : v.fills),
    artOf(native).map(() => [255, 0, 0]));

  // The payoff of the SCALE constraints: resizing the canvas has to scale the drawing, not strand it.
  const artBefore = artOf(native).map(v => Math.round(v.width));
  await flcm.edit(icon, { width: 48, height: 48 });
  const artAfter = artOf(native).map(v => Math.round(v.width));
  check("resizing the import scales the art (not a 24px glyph in a 48px box)", artAfter, artBefore.map(w => w * 2));

  const cleared = await flcm.render({ type: "VECTOR", name: "svg stroke-none probe", svg: MARKUP, stroke: "none", left: 200, top: 100 });
  roots.push(cleared.id);
  const clearedNative = await figma.getNodeByIdAsync(cleared.id);
  check('stroke "none" beside svg clears the markup\\'s strokes', artOf(clearedNative).map(v => v.strokes.length), artOf(clearedNative).map(() => 0));

  return { checks, observations };
} finally {
  for (const root of roots) { const node = await figma.getNodeByIdAsync(root); if (node) node.remove(); }
}
`;

let started = false;
async function runProbe() {
  if (started) return; // reconnects must not restart a probe already in flight
  started = true;
  try {
    log("plugin connected — introducing the session");
    await bridge.request({
      type: "SESSION_INFO",
      identity: SESSION_IDENTITY,
      pairingCode: bridge.getPairingCode(),
      sessionToken: bridge.getSessionToken(),
    });

    const version = await bridge.request({ type: "GET_VERSION" }).catch(() => ({}));
    if (version.protocolVersion !== MIN_PROTOCOL_VERSION) {
      fail(
        `the connected plugin reports protocol ${version.protocolVersion ?? "(none)"}, not ` +
          `${MIN_PROTOCOL_VERSION} — it was imported from an old build. Run \`pnpm build:plugin\` in ` +
          `THIS worktree and re-import plugin/manifest.json from here, then re-run the probe.`,
      );
    }
    log(`plugin speaks protocol ${version.protocolVersion} (v${version.pluginVersion}) ✓`);
    log(
      `sending the probe render — if the strip asks, click Allow (pairing code ${bridge.getPairingCode()})`,
    );

    // Poll status separately so approval retries cannot execute the probe more than once.
    const reply = await requestUntilApproved(
      (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
      () => bridge.request({ type: "EXECUTE_CODE", code: PROBE_CODE, preamble: PREAMBLE }),
    );
    if (reply?.type === "PENDING_APPROVAL") {
      fail(
        "the session was never approved — click Allow on the Framelink strip and re-run the probe.",
      );
    }
    if (reply?.errors) fail(`the probe script errored in the sandbox:\n${reply.errors}`);

    for (const observation of reply?.result?.observations ?? []) {
      console.log(`OBSERVED ${observation.name}: ${JSON.stringify(observation.value)}`);
    }

    const results = reply?.result?.checks;
    if (!Array.isArray(results) || results.length !== EXPECTED_CHECKS)
      fail(`expected ${EXPECTED_CHECKS} checks, got ${JSON.stringify(reply?.result)}`);
    for (const result of results) {
      console.log(
        `${result.pass ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result.actual)} (expected ${JSON.stringify(result.expected)})`,
      );
    }

    // The ignored width/height must SAY so: a silent drop is the failure mode this word set replaced.
    const warned = String(reply?.console ?? "").includes("bare geometry");
    console.log(
      `${warned ? "PASS" : "FAIL"} width/height beside d warns: ${JSON.stringify(reply?.console ?? "")}`,
    );

    if (results.some((result) => !result.pass) || !warned) fail("VECTOR probe checks failed.");
    log("all VECTOR checks passed; probe nodes deleted");
    process.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function fail(reason) {
  console.error(`\n❌ FAIL — ${reason}`);
  process.exit(1);
}

const bridge = new PluginBridge();

console.log(
  "Framelink VECTOR probe: waiting for the plugin in a scratch file. Approve this session when asked; Ctrl-C to abort.",
);
bridge.start(WS_PORT_BLOCK, () => void runProbe());
