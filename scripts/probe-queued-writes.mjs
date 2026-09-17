// LIVE PROBE for two runtime holes no headless harness can close on its own — the reply outrunning
// the verb queue, and a runtime the agent kept past its own reply. A standing runbook: re-run it
// whenever executeCode's finally, the mutation lock's chain, or the FlcmHost surface changes shape.
//
// What it drives against the REAL plugin:
//   1. Queued write — `Promise.all([flcm.edit(<bad>), flcm.render(<good>)])`. The batch rejects on
//      the edit, but the render's slot was reserved synchronously, so the write is still coming.
//      The reply must not go out over a canvas that is still moving: it has to drain first and say
//      so. Pre-fix this FAILS — the reply arrives with no warning and the frame appears afterwards.
//   2. Stale runtime — call A stashes `flcm` on globalThis; call B writes through it. Its host
//      answers for a run nobody is waiting on (cancellation permanently false, a dead egress, its
//      own second mutation queue), so it must refuse. Pre-fix this FAILS — the write lands.
//
// Runbook (minutes, not a rebuild):
//   1. pnpm build:plugin                     (from the checkout under test)
//   2. Figma desktop → Plugins → Development → Import plugin from manifest…
//        → <that checkout>/plugin/manifest.json     (re-import even if already imported —
//          the probe needs the build you just made, not whatever Figma has cached)
//   3. Open the Framelink plugin in any (scratch) file.
//   4. pnpm probe:queued-writes              (this script)
//   5. When the plugin strip shows this session, click Allow.
// The probe creates one small frame, reads it back, and deletes it again. Safe to re-run.

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";
import { MIN_PROTOCOL_VERSION } from "../src/services/plugin-bridge/version.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";

// The plugin holds no runtime of its own (ADR-0010), so the probe ships the real std-lib — the same
// string the server build injects, through the same seam.
const PREAMBLE = await buildSandboxPreamble();

const SURVIVOR = "flcm-probe-queued-survivor";
const STALE_MARK = "flcm-probe-stale-write";

const t0 = Date.now();
const log = (msg) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const bridge = new PluginBridge(undefined, {
  capabilities: new Map([["images.fetch", async () => ({})]]),
});

const run = (code) => bridge.request({ type: "EXECUTE_CODE", code, preamble: PREAMBLE });

// The agent's shape from the DX notes, verbatim in spirit: a batch that rejects fast while its
// sibling's slot is already reserved. `0:0` is the document node, which no edit can touch.
const QUEUED_WRITE = `
let caught = null;
try {
  await Promise.all([
    flcm.edit(flcm.id("0:0"), { name: "nope" }),
    flcm.render({ type: "FRAME", name: ${JSON.stringify(SURVIVOR)}, width: 40, height: 40 }),
  ]);
} catch (e) { caught = String(e.message || e); }
return { caught };
`;

const STASH_AND_FIND = `
globalThis.__flcmProbeStale = flcm;
return { found: await flcm.find({ name: ${JSON.stringify(SURVIVOR)} }) };
`;

const STALE_WRITE = `
try {
  await __flcmProbeStale.edit(flcm.id(${JSON.stringify("__ID__")}), { name: ${JSON.stringify(STALE_MARK)} });
  return { wrote: true };
} catch (e) { return { refusal: String(e.message || e) }; }
`;

let started = false;
async function runProbe() {
  if (started) return; // reconnects must not restart a probe already in flight
  started = true;
  let survivorId = null;
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
    log(`sending the queued-write batch — if the strip asks, click Allow (pairing code ${bridge.getPairingCode()})`);

    // ---- 1. The reply must not outrun the queued render. ----
    // Poll APPROVAL_STATUS, submit the code once — the same two-callback shape the real tool uses
    // (code-mode-tools.ts). Handing this ONE callback polls by re-sending EXECUTE_CODE, and the
    // granted run's own reply then reads as an unexpected approval status.
    const first = await requestUntilApproved(
      (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
      () => run(QUEUED_WRITE),
    );
    if (first?.type === "PENDING_APPROVAL") {
      fail("the session was never approved — click Allow on the Framelink strip and re-run the probe.");
    }
    if (first?.errors) fail(`the probe script errored in the sandbox:\n${first.errors}`);
    if (!first?.result?.caught) {
      fail("the batch did NOT reject — this probe needs the edit to fail; check that `0:0` is still unwritable.");
    }
    log(`batch rejected as designed: ${first.result.caught}`);

    const warning = (first.console ?? []).find((line) => line.includes("finished after your code returned"));
    if (!warning) {
      fail(
        `the reply carried no settled-after-return warning, so the run replied without draining its ` +
          `verb queue — the queued render is landing AFTER the agent was told the call was done ` +
          `(console: ${JSON.stringify(first.console ?? [])}).`,
      );
    }
    log(`reply names the late write: ${warning}`);

    // The write must already be on the canvas at reply time — a follow-up read is only allowed to
    // confirm what the first reply already accounted for.
    const found = await run(STASH_AND_FIND);
    if (found?.errors) fail(`the follow-up read errored in the sandbox:\n${found.errors}`);
    const ids = found?.result?.found ?? [];
    if (ids.length !== 1) {
      fail(`expected exactly one ${SURVIVOR} on the canvas after the drain, saw ${JSON.stringify(ids)}.`);
    }
    survivorId = typeof ids[0] === "string" ? ids[0] : ids[0]?.id;
    log(`the queued render is on the canvas and accounted for (${survivorId}) ✓`);

    // ---- 2. The stashed runtime must refuse. ----
    const stale = await run(STALE_WRITE.replace("__ID__", survivorId));
    if (stale?.errors) fail(`the stale-runtime script errored in the sandbox:\n${stale.errors}`);
    if (stale?.result?.wrote) {
      fail(
        `a runtime stored on globalThis in an EARLIER call still wrote — it renamed the probe frame ` +
          `to ${STALE_MARK}. Its run is settled, so nothing can cancel or wait for that write.`,
      );
    }
    if (!/already finished and replied/.test(stale?.result?.refusal ?? "")) {
      fail(`the stale runtime refused, but not as a finished run: ${JSON.stringify(stale?.result?.refusal)}`);
    }
    log(`stale runtime refused: ${stale.result.refusal}`);

    await cleanup(survivorId);
    console.log(
      `\n✅ PASS — the reply waited for a write queued behind a rejected batch (and named it), and a ` +
        `runtime kept past its own reply refused to write.\n` +
        `Both holes from AGENT-DX-NOTES §4 and §8 are CLOSED live.`,
    );
    process.exit(0);
  } catch (err) {
    await cleanup(survivorId);
    fail(err instanceof Error ? err.message : String(err));
  }
}

// Best effort by design: a probe that leaves nodes behind is worse than one that says it could not
// tidy up, but neither is worth masking the finding it just produced.
async function cleanup(id) {
  const names = JSON.stringify([SURVIVOR, STALE_MARK]);
  const code = `
    const doomed = [];
    for (const name of ${names}) for (const n of await flcm.find({ name })) doomed.push(n.id || n);
    ${id ? `doomed.push(${JSON.stringify(id)});` : ""}
    let removed = 0;
    for (const target of doomed) {
      const node = await figma.getNodeByIdAsync(target);
      if (node && !node.removed) { node.remove(); removed++; }
    }
    return removed;
  `;
  const reply = await run(code).catch(() => null);
  if (reply?.result) log(`cleaned ${reply.result} probe node(s)`);
  else if (id) log(`⚠️ could not clean up — delete the "${SURVIVOR}" frame by hand.`);
}

function fail(reason) {
  console.error(`\n❌ FAIL — ${reason}`);
  process.exit(1);
}

console.log(
  "Framelink probe: a reply outrunning its own writes, and a runtime kept past its reply.\n" +
    "Waiting for the Figma plugin to connect… (import it from THIS worktree's plugin/manifest.json,\n" +
    "open it in a scratch file, and approve this session when asked; Ctrl-C to abort)\n",
);
bridge.start(WS_PORT_BLOCK, () => void runProbe());
