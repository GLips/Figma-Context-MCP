// Live LINE-fill probe. Run `pnpm probe:line-fill`, open Framelink in a scratch Figma file,
// then approve the pairing code. Import plugin/manifest.json after `pnpm build:plugin` if needed.
// The preamble is built from this checkout, so preamble changes need no plugin re-import.
// Set FRAMELINK_STATE_DIR to a writable, isolated directory to keep approval/session state
// separate from your normal server. This script creates probe frames and removes them in finally.
// The question: a divider is a LINE that should span its column, which flcm now authors as
// width: "fill" (layoutSizingHorizontal = "FILL" on the LineNode). This measures that the length
// Figma gives it really is the parent's content width, that a row gives it the leftover space,
// that the read says "fill", that a numeric width takes the fill back, and that a free-form
// parent — where no flow supplies a length — still refuses, as does a rotation (the fill resolves
// along the parent's own axis first, so a rotated line is a length across it that nobody asked for).

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
  // A divider in a column: 200 wide, 16 padding each side, so the content width is 168.
  const column = await flcm.render({ type: "FRAME", name: "LINE fill probe", width: 200, height: 120,
    layout: { mode: "column", padding: 16, gap: 12 },
    children: [
      { type: "TEXT", text: "Section", width: "hug" },
      { type: "LINE", name: "divider", width: "fill", stroke: "#D4D4D8" },
      { type: "TEXT", text: "Body", width: "hug" },
    ] });
  roots.push(column.id);
  const divider = await flcm.measure(column.children[1]);
  check("column divider spans the content width", [divider.width, divider.height], [168, 0]);
  check("read words say fill", (await flcm.get(column)).node.children[1].width, "fill");
  const native = await figma.getNodeByIdAsync(column.children[1].id);
  check("native sizing is FILL", native.layoutSizingHorizontal, "FILL");

  // A row hands the line the space its siblings leave: 200 - 40 - 10 gap.
  const row = await flcm.render({ type: "FRAME", name: "LINE fill row probe", left: 240, width: 200, height: 40,
    layout: { mode: "row", gap: 10, alignItems: "center" },
    children: [
      { type: "RECTANGLE", width: 40, height: 10 },
      { type: "LINE", width: "fill", stroke: "#D4D4D8" },
    ] });
  roots.push(row.id);
  check("row divider takes the remaining length", (await flcm.measure(row.children[1])).width, 150);

  // A numeric width takes the fill back.
  await flcm.edit(column.children[1], { width: 40 });
  check("numeric width un-fills", [(await flcm.measure(column.children[1])).width, native.layoutSizingHorizontal], [40, "FIXED"]);
  await flcm.edit(column.children[1], { width: "fill" });
  check("fill returns", (await flcm.measure(column.children[1])).width, 168);

  // Out of the flow nothing supplies a length, so the refusal stands.
  let looseRefusal = "";
  try {
    await flcm.render({ type: "FRAME", name: "LINE loose probe", left: 480, width: 200, height: 60,
      children: [{ type: "LINE", width: "fill", stroke: "#D4D4D8" }] });
  } catch (error) { looseRefusal = String(error); }
  check("a free-form parent refuses fill", looseRefusal.includes("in-flow child of a row or column"), true);
  let hugRefusal = "";
  try { await flcm.edit(column.children[1], { width: "hug" }); }
  catch (error) { hugRefusal = String(error); }
  check("hug still has no meaning on a line", hugRefusal.includes("no meaning on a line"), true);

  // A rotation composes AFTER the fill, so the two together give a line as long as the parent's own
  // axis, standing across it — refused now, with the construction that does work named in its place.
  let rotatedRefusal = "";
  try {
    await flcm.render({ type: "FRAME", name: "LINE rotated probe", left: 720, width: 200, height: 60,
      layout: { mode: "row" }, children: [{ type: "LINE", width: "fill", rotation: 90, stroke: "#D4D4D8" }] });
  } catch (error) { rotatedRefusal = String(error); }
  check("a rotated fill is refused at create", rotatedRefusal.includes('a rotated LINE cannot use width: "fill"'), true);
  let liveRotationRefusal = "";
  try { await flcm.edit(column.children[1], { rotation: 90 }); }
  catch (error) { liveRotationRefusal = String(error); }
  check("rotating a line that already fills is refused", liveRotationRefusal.includes('a rotated LINE cannot use width: "fill"'), true);
  // The construction the refusal names, measured: a 1px rule standing across a row.
  const rule = await flcm.render({ type: "FRAME", name: "LINE rule construction probe", left: 960, width: 200, height: 60,
    layout: { mode: "row", padding: 10 },
    children: [{ type: "RECTANGLE", width: 1, height: "fill", fill: "#D4D4D8" }] });
  roots.push(rule.id);
  check("a 1px rectangle is the rule that stands", [(await flcm.measure(rule.children[0])).width, (await flcm.measure(rule.children[0])).height], [1, 40]);
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
    if (!Array.isArray(results) || results.length !== 11)
      fail(`expected 11 checks, got ${JSON.stringify(reply?.result)}`);
    for (const result of results) {
      console.log(
        `${result.pass ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result.actual)} (expected ${JSON.stringify(result.expected)})`,
      );
    }
    if (results.some((result) => !result.pass)) fail("LINE fill probe checks failed.");
    log("all LINE fill checks passed; probe frames deleted");
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
  "Framelink LINE fill probe: waiting for the plugin in a scratch file. Approve this session when asked; Ctrl-C to abort.",
);
bridge.start(WS_PORT_BLOCK, () => void runProbe());
