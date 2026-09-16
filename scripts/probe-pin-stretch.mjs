// LIVE PROBE for AGENT-DX-NOTES-component-surgery §6 — `pin: "stretch"` resizing the node the
// author just sized. A standing runbook: re-run it whenever attachBuiltChild / buildFrame change
// the order in which a child is constrained and its parent is sized, because no mock can settle
// what Figma really does when a constrained child's parent grows.
//
// What it asks: author a 200×100 absolute child inside a 200×100 frame, four ways (pin stretch or
// not, padding 8 or not), and measure the child. The authored size is the expected size in ALL
// FOUR — a constraint says how a child reflows when the parent's box changes LATER; it is never
// part of the size the child is created at. Before the fix the stretch cases came back 300 wide
// (and 84 tall under padding), because the STRETCH mark was written while the frame was still at
// its provisional creation size and Figma then reflowed the child by the frame's growth.
//
// Runbook (minutes, not a rebuild):
//   1. pnpm build:plugin                     (from the checkout under test)
//   2. Figma desktop → Plugins → Development → Import plugin from manifest…
//        → <that checkout>/plugin/manifest.json
//      Only needed when plugin/src/code.ts or the plugin shell changed: the preamble (bridge.ts
//      included) is built from SOURCE below and shipped with the execute, so a preamble-side fix
//      needs no re-import at all.
//   3. Open the Framelink plugin in any (scratch) file.
//   4. pnpm probe:pin-stretch                (this script)
//   5. When the plugin strip shows this session, click Allow.
// The probe renders four small frames, measures, deletes them again, and prints PASS/FAIL per case.
// Safe to re-run.

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";
import { MIN_PROTOCOL_VERSION } from "../src/services/plugin-bridge/version.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";

// The real plugin holds no runtime of its own (ADR-0010), so the probe ships the actual std-lib
// through the same seam the server build uses — which is why a preamble fix needs no re-import.
const PREAMBLE = await buildSandboxPreamble();

const EXPECTED = { width: 200, height: 100 };
const CASES = [
  { name: "no pin, no padding", pin: null, padding: null },
  { name: "pin stretch/stretch", pin: { x: "stretch", y: "stretch" }, padding: null },
  { name: "no pin, padding 8", pin: null, padding: 8 },
  { name: "pin stretch + padding 8", pin: { x: "stretch", y: "stretch" }, padding: 8 },
];

const t0 = Date.now();
const log = (msg) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const PROBE_CODE = `
const cases = ${JSON.stringify(CASES)};
const out = [];
const roots = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const spec = {
    type: "FRAME",
    name: "flcm-pin-probe " + c.name,
    width: 200,
    height: 100,
    left: 0,
    top: i * 160,
    children: [{
      type: "RECTANGLE",
      key: "child",
      width: 200,
      height: 100,
      position: "absolute",
      left: 0,
      top: 0,
      fill: "#cccccc",
      ...(c.pin ? { pin: c.pin } : {}),
    }],
  };
  if (c.padding !== null) spec.layout = { mode: "column", padding: c.padding };
  const built = await flcm.render(spec);
  roots.push(built.id);
  const child = built.children[0];
  out.push({ name: c.name, box: await flcm.measure(child.id) });
}
for (const id of roots) { const n = await figma.getNodeByIdAsync(id); if (n) n.remove(); }
return out;
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
    log(`sending the probe render — if the strip asks, click Allow (pairing code ${bridge.getPairingCode()})`);

    // Poll APPROVAL_STATUS, submit the code once — the same two-callback shape the real tool uses
    // (code-mode-tools.ts). Handing this ONE callback polls by re-sending EXECUTE_CODE, and the
    // granted run's own reply then reads as an unexpected approval status.
    const reply = await requestUntilApproved(
      (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
      () => bridge.request({ type: "EXECUTE_CODE", code: PROBE_CODE, preamble: PREAMBLE }),
    );
    if (reply?.type === "PENDING_APPROVAL") {
      fail("the session was never approved — click Allow on the Framelink strip and re-run the probe.");
    }
    if (reply?.errors) fail(`the probe script errored in the sandbox:\n${reply.errors}`);

    const results = reply?.result;
    if (!Array.isArray(results) || results.length !== CASES.length) {
      fail(`expected ${CASES.length} measurements, got ${JSON.stringify(results)}`);
    }

    let failures = 0;
    console.log(`\nauthored 200×100 absolute child inside a 200×100 frame — expected ${EXPECTED.width}×${EXPECTED.height} in every case\n`);
    for (const { name, box } of results) {
      const ok = box.width === EXPECTED.width && box.height === EXPECTED.height;
      if (!ok) failures++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(24)} got ${box.width}×${box.height}`);
    }
    log("probe frames deleted");

    if (failures) {
      fail(`${failures} of ${CASES.length} cases came back at a size the author never wrote (§6).`);
    }
    console.log("\n✅ PASS — a constraint no longer changes the size a child is authored at.");
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
  "Framelink probe: does `pin: \"stretch\"` resize an authored absolute child?\n" +
    "Waiting for the Figma plugin to connect… (open it in a scratch file and approve this session\n" +
    "when asked; Ctrl-C to abort)\n",
);
bridge.start(WS_PORT_BLOCK, () => void runProbe());
