// STEP-ZERO LIVE PROBE for the mid-run image protocol (flcm edit surface, Phase 1).
//
// The one load-bearing assumption everything in protocol 2 rests on: the QuickJS sandbox can
// SUSPEND on an await while the plugin main thread round-trips the WS bridge (postMessage →
// ui.html → server) and resumes when the reply arrives — including a deliberately SLOW
// (multi-second) reply. This script drives exactly that against the REAL plugin and prints a
// clear PASS/FAIL. It fetches no network images: the server-side image handler is stubbed to
// wait 4s and answer with an inline 1×1 PNG, so the delay is the thing under test.
//
// Morning checklist (minutes, not a rebuild):
//   1. pnpm build:plugin                     (from this worktree)
//   2. Figma desktop → Plugins → Development → Import plugin from manifest…
//        → <this worktree>/plugin/manifest.json      (re-import even if already imported —
//          the probe needs THIS worktree's protocol-2 build, not the main checkout's)
//   3. Open the Framelink plugin in any (scratch) file.
//   4. pnpm probe:midrun-await               (this script)
//   5. When the plugin strip shows this worktree's session, click Allow.
// The probe renders one small frame with two image fills, verifies the suspension, deletes the
// frame again, and prints PASS/FAIL. Safe to re-run.

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";

const SLOW_REPLY_MS = 4000;
// A valid 1×1 transparent PNG — figma.createImage validates real image bytes.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const log = (msg) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const t0 = Date.now();

let imagesRequests = 0;
const bridge = new PluginBridge();
bridge.onImagesRequest(async (urls) => {
  imagesRequests++;
  log(`plugin asked for ${urls.length} image url(s) MID-RUN — holding the reply ${SLOW_REPLY_MS}ms…`);
  await new Promise((r) => setTimeout(r, SLOW_REPLY_MS));
  log("releasing the image reply");
  return Object.fromEntries(urls.map((u) => [u, TINY_PNG_B64]));
});

const PROBE_CODE = `
const t0 = Date.now();
const built = await flcm.render(
  flcm.frame({ key: "flcm-probe", w: 120, h: 60, layout: { mode: "row", gap: 8, pad: 8 } }, [
    flcm.rect({ w: 40, h: 40, fill: flcm.image("https://probe.invalid/a.png") }),
    flcm.rect({ w: 40, h: 40, fill: flcm.image("https://probe.invalid/b.png") }),
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
    if (version.protocolVersion !== 2) {
      fail(
        `the connected plugin reports protocol ${version.protocolVersion ?? "(none)"}, not 2 — it was ` +
          `imported from an old build. Run \`pnpm build:plugin\` in THIS worktree and re-import ` +
          `plugin/manifest.json from here, then re-run the probe.`,
      );
    }
    log(`plugin speaks protocol 2 (v${version.pluginVersion}) ✓`);
    log(`sending the probe render — if the strip asks, click Allow (pairing code ${bridge.getPairingCode()})`);

    const runStart = Date.now();
    const reply = await requestUntilApproved(() =>
      bridge.request({ type: "EXECUTE_CODE", code: PROBE_CODE }),
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
