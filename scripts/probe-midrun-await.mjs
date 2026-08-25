// LIVE PROBE for protocol 2's load-bearing runtime assumption (flcm edit surface, Phase 1 step
// zero) — a standing runbook, not a one-shot: re-run it whenever the eval wrapper, the preamble's
// image await, or the plugin's WS dispatch changes shape, since no headless harness can answer this.
//
// The assumption everything in protocol 2 rests on: the QuickJS sandbox can SUSPEND on an await
// while the plugin main thread round-trips the WS bridge (postMessage → ui.html → server) and
// resumes when the reply arrives — including a deliberately SLOW (multi-second) reply. This script
// drives exactly that against the REAL plugin and prints a clear PASS/FAIL. It fetches no network
// images: the server-side image handler is stubbed to wait 4s and answer with an inline 1×1 PNG,
// so the delay itself is the thing under test.
//
// Runbook (minutes, not a rebuild):
//   1. pnpm build:plugin                     (from the checkout under test)
//   2. Figma desktop → Plugins → Development → Import plugin from manifest…
//        → <that checkout>/plugin/manifest.json     (re-import even if already imported —
//          the probe needs the build you just made, not whatever Figma has cached)
//   3. Open the Framelink plugin in any (scratch) file.
//   4. pnpm probe:midrun-await               (this script)
//   5. When the plugin strip shows this session, click Allow.
// The probe renders one small frame with two image fills, verifies the suspension, deletes the
// frame again, and prints PASS/FAIL. Safe to re-run.
//
// First live PASS: 2026-08-07 — 4113ms suspension across a 4000ms-held reply, one execute, one
// image request, no re-execution; a second run then cleaned up (the loop survived). If a future
// run FAILS on the suspension assert, whatever changed the eval wrapper / image await / WS
// dispatch broke the suspension the whole protocol rests on — that change must be revisited.

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";
import { MIN_PROTOCOL_VERSION } from "../src/services/plugin-bridge/version.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";

// These probes drive a REAL plugin, which holds no runtime of its own (ADR-0010) — so they must
// ship the actual std-lib, not a stand-in. Built once here through the same seam the server build
// uses; the contract harness, whose fake plugin never evals anything, uses a stub instead.
const { preamble: PREAMBLE } = await buildSandboxPreamble();


const SLOW_REPLY_MS = 4000;
// A valid 1×1 transparent PNG — figma.createImage validates real image bytes.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const log = (msg) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const t0 = Date.now();

let imagesRequests = 0;
const bridge = new PluginBridge(undefined, {
  imagesRequestHandler: async (urls) => {
    imagesRequests++;
    log(`plugin asked for ${urls.length} image url(s) MID-RUN — holding the reply ${SLOW_REPLY_MS}ms…`);
    await new Promise((r) => setTimeout(r, SLOW_REPLY_MS));
    log("releasing the image reply");
    return Object.fromEntries(urls.map((u) => [u, TINY_PNG_B64]));
  },
});

const PROBE_CODE = `
const t0 = Date.now();
const built = await flcm.render(
  flcm.frame({ key: "flcm-probe", width: 120, height: 60, layout: { mode: "row", gap: 8, padding: 8 } }, [
    flcm.rect({ width: 40, height: 40, fill: flcm.image("https://probe.invalid/a.png") }),
    flcm.rect({ width: 40, height: 40, fill: flcm.image("https://probe.invalid/b.png") }),
  ]),
);
return { elapsedMs: Date.now() - t0, rootId: built.root.id };
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
    // Gate on the server's own minimum rather than a literal, so a protocol bump doesn't silently
    // leave this probe asserting a version nobody speaks anymore.
    if (version.protocolVersion !== MIN_PROTOCOL_VERSION) {
      fail(
        `the connected plugin reports protocol ${version.protocolVersion ?? "(none)"}, not ` +
          `${MIN_PROTOCOL_VERSION} — it was imported from an old build. Run \`pnpm build:plugin\` in ` +
          `THIS worktree and re-import plugin/manifest.json from here, then re-run the probe.`,
      );
    }
    log(`plugin speaks protocol ${version.protocolVersion} (v${version.pluginVersion}) ✓`);
    log(`sending the probe render — if the strip asks, click Allow (pairing code ${bridge.getPairingCode()})`);

    const runStart = Date.now();
    const reply = await requestUntilApproved(() =>
      bridge.request({ type: "EXECUTE_CODE", code: PROBE_CODE, preamble: PREAMBLE }),
    );
    if (reply?.type === "PENDING_APPROVAL") {
      fail("the session was never approved — click Allow on the Framelink strip and re-run the probe.");
    }
    if (reply?.errors) {
      fail(`the probe script errored in the sandbox:\n${reply.errors}`);
    }
    const { elapsedMs, rootId } = reply?.result ?? {};
    const wallMs = Date.now() - runStart;

    log(`run completed: sandbox-side elapsed ${elapsedMs}ms, wall ${wallMs}ms, image requests: ${imagesRequests}`);

    const suspended = typeof elapsedMs === "number" && elapsedMs >= SLOW_REPLY_MS;
    const oneExecuteOneFetch = imagesRequests === 1;
    if (!suspended) {
      fail(
        `the sandbox did NOT suspend across the slow reply (elapsed ${elapsedMs}ms < ${SLOW_REPLY_MS}ms) — ` +
          `the render resolved without waiting for the server, which should be impossible.`,
      );
    }
    if (!oneExecuteOneFetch) {
      fail(`expected exactly 1 mid-run image request, saw ${imagesRequests} — check the bridge logs above.`);
    }

    // The loop must survive the suspension: run a second script that cleans the probe frame up.
    const cleanup = await bridge.request({
      type: "EXECUTE_CODE",
      code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(rootId)}); if (n) n.remove(); return "cleaned";`,
      preamble: PREAMBLE,
    });
    if (cleanup?.result !== "cleaned") {
      log(`⚠️ cleanup run returned ${JSON.stringify(cleanup?.result)} — delete the small "flcm-probe" frame by hand.`);
    } else {
      log("second run cleaned the probe frame — the loop survived the suspension ✓");
    }

    console.log(
      `\n✅ PASS — the sandbox suspended ${elapsedMs}ms on a mid-run await across a real WS round-trip ` +
        `(one execute, one image request, no re-execution), and kept working afterwards.\n` +
        `Protocol 2's load-bearing assumption is CONFIRMED live.`,
    );
    process.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function fail(reason) {
  console.error(`\n❌ FAIL — ${reason}`);
  process.exit(1);
}

console.log(
  "Framelink step-zero probe: mid-run await across the live WS bridge.\n" +
    "Waiting for the Figma plugin to connect… (import it from THIS worktree's plugin/manifest.json,\n" +
    "open it in a scratch file, and approve this session when asked; Ctrl-C to abort)\n",
);
bridge.start(WS_PORT_BLOCK, () => void runProbe());
