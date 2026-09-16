// Live GRID authoring probe. Run `pnpm probe:grid`, open Framelink in a scratch Figma file,
// then approve the pairing code. Import plugin/manifest.json after `pnpm build:plugin` if needed.
// The preamble is built from this checkout, so preamble changes need no plugin re-import.
// Set FRAMELINK_STATE_DIR to a writable, isolated directory to keep approval/session state
// separate from your normal server. This script creates probe frames and removes them in finally.
// It verifies native track setters, placement/spans, cell sizing, read words, edits, and stacking.
// Live Figma uses pre-removal insertion indices: insertChild(2, A) on [A,B,C] gives [B,A,C].
// Appending past a full manual grid adds FIXED rows: this probe’s one 40px row became two
// FIXED 40px rows while vertical sizing stayed HUG. Automatic growth is unmodeled in the mock, and
// a grid whose rows nobody named now opens its own HUG row before the child lands, so that FIXED
// growth is a fallback nothing here relies on.

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";
import { MIN_PROTOCOL_VERSION } from "../src/services/plugin-bridge/version.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";

// The real plugin holds no runtime of its own (ADR-0010), so the probe ships the actual std-lib
// through the same seam the server build uses — which is why a preamble fix needs no re-import.
const PREAMBLE = await buildSandboxPreamble();

const t0 = Date.now();
const log = (msg) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const PROBE_CODE = `
const roots = [];
const checks = [];
function check(name, actual, expected) {
  checks.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
}
try {
  const built = await flcm.render({ type: "FRAME", name: "GRID probe", width: 300, height: 160,
    layout: { mode: "grid", gridTemplateColumns: "80px 1fr", gridTemplateRows: "60px 90px", gap: "10px 12px" },
    children: [
      { type: "RECTANGLE", width: "fill", height: "fill" },
      { type: "RECTANGLE", width: 20, height: 30, layout: { justifySelf: "center", alignSelf: "end" } },
    ] });
  roots.push(built.id);
  const read = (await flcm.get(built)).node;
  check("container read words", [read.layout.mode, read.layout.gridTemplateColumns, read.layout.gridTemplateRows, read.layout.gap], ["grid", "80px 1fr", "60px 90px", "10px 12px"]);
  const box = await flcm.measure(built.children[0]);
  check("cell fill", [box.width, box.height], [80, 60]);
  check("cell alignment", [read.children[1].layout.justifySelf, read.children[1].layout.alignSelf], ["center", "end"]);
  await flcm.editMany([{ id: built.children[0].id, width: "fill" }, { id: built.id, layout: { gridTemplateColumns: "100px 1fr" } }]);
  check("editMany cell resize", (await flcm.measure(built.children[0])).width, 100);
  const span = await flcm.render({ type: "FRAME", name: "GRID span probe", left: 350,
    layout: { mode: "grid", gridTemplateColumns: "40px 40px 40px", gridTemplateRows: "30px 30px 30px" },
    children: [{ type: "RECTANGLE", width: "fill", height: "fill", layout: { gridColumn: "2 / span 2", gridRow: "2 / span 2" } }] });
  roots.push(span.id);
  const spanRead = (await flcm.get(span)).node.children[0].layout;
  check("anchor and span", [spanRead.gridColumn, spanRead.gridRow], ["2 / span 2", "2 / span 2"]);
  const stack = await flcm.render({ type: "FRAME", name: "GRID stacking probe", left: 550,
    layout: { mode: "grid", gridTemplateColumns: "40px 40px", gridTemplateRows: "40px" },
    children: [
      { type: "RECTANGLE", name: "first", width: 80, height: 40, layout: { zIndex: 1 } },
      { type: "RECTANGLE", name: "second", width: 80, height: 40 },
    ] });
  roots.push(stack.id);
  const native = await figma.getNodeByIdAsync(stack.id);
  check("native stacking and anchors", native.children.map(c => [c.name, c.gridColumnAnchorIndex]), [["second", 1], ["first", 0]]);
  const stackRead = (await flcm.get(stack)).node.children;
  check("read zIndex", stackRead.map(c => [c.name, c.layout.zIndex]).sort((a, b) => a[0].localeCompare(b[0])), [["first", 1], ["second", 0]]);
  await flcm.edit(stack.children[0], { layout: { zIndex: 0 } });
  check("same-parent reorder backward", native.children.map(c => [c.name, c.gridColumnAnchorIndex]), [["first", 0], ["second", 1]]);
  await flcm.edit(stack.children[0], { layout: { zIndex: 1 } });
  check("same-parent reorder forward", native.children.map(c => [c.name, c.gridColumnAnchorIndex]), [["second", 1], ["first", 0]]);
  await flcm.editMany([{ id: stack.children[0].id, layout: { zIndex: 0 } }, { id: stack.children[1].id, layout: { zIndex: 1 } }]);
  check("batch sibling slots", native.children.map(c => c.name), ["first", "second"]);
  const flow = await flcm.render({ type: "FRAME", width: 120, height: 70, layout: { mode: "row" }, children: [{ type: "RECTANGLE", width: 20, layout: { alignSelf: "stretch" } }] });
  roots.push(flow.id);
  check("flow stretch aliases cross-axis fill", (await flcm.measure(flow.children[0])).height, 70);
  // Rows nobody named: hug tracks, one per row the children need, growing as children arrive.
  const implicit = await flcm.render({ type: "FRAME", name: "GRID implicit rows probe", left: 750, width: 240,
    layout: { mode: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },
    children: [
      { type: "RECTANGLE", width: "fill", height: 30, layout: { gridColumn: "span 2" } },
      { type: "RECTANGLE", width: "fill", height: 30 },
      { type: "RECTANGLE", width: "fill", height: 30 },
    ] });
  roots.push(implicit.id);
  const implicitNative = await figma.getNodeByIdAsync(implicit.id);
  check("implicit rows are hug tracks", [(await flcm.get(implicit)).node.layout.gridTemplateRows, implicitNative.layoutSizingVertical], ["fit-content(100%) fit-content(100%)", "HUG"]);
  // Four cells fill the first two rows; the fifth append has to open a third.
  for (let i = 0; i < 3; i++) await flcm.append(implicit, { type: "RECTANGLE", width: "fill", height: 30 });
  check("an appended child grows a hug row", [implicitNative.gridRowSizes.map(t => t.type), implicitNative.layoutSizingVertical], [["HUG", "HUG", "HUG"], "HUG"]);

  let alignmentRefusal = "";
  try { await flcm.edit(flow.children[0], { height: 20, layout: { alignSelf: "flex-end" } }); }
  catch (error) { alignmentRefusal = String(error); }
  check("flow alignment refuses and names parent alignItems", alignmentRefusal.includes("alignItems"), true);
  return { checks };
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

    const results = reply?.result?.checks;
    if (!Array.isArray(results) || results.length !== 14)
      fail(`expected 14 checks, got ${JSON.stringify(reply?.result)}`);
    for (const result of results) {
      console.log(
        `${result.pass ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result.actual)} (expected ${JSON.stringify(result.expected)})`,
      );
    }
    if (results.some((result) => !result.pass)) fail("GRID probe checks failed.");
    log("all GRID checks passed; probe frames deleted");
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
  "Framelink GRID probe: waiting for the plugin in a scratch file. Approve this session when asked; Ctrl-C to abort.",
);
bridge.start(WS_PORT_BLOCK, () => void runProbe());
