// LIVE PROBE for the undo contract behind plan invariants 2 and 4 (flcm edit surface, Phase 2 step
// zero) — a standing runbook, not a one-shot: re-run whenever the verbs' seal placement (commitUndo
// at entry/success), the rollback path (triggerUndo), or the eval wrapper changes shape. No
// headless harness can answer this; the mock has no undo history.
//
// What it grounds (the plan marks the contract [directional] until this passes):
//   1. ROLLBACK — figma.triggerUndo() reverts to the LAST figma.commitUndo() state, so a failed
//      verb erases exactly its own writes: foreign raw writes made BEFORE the verb's entry seal
//      survive, including on a session's first verb (scenario 1).
//   2. CHUNKING — two verbs each emitting [entry seal → writes → success commit] cost the user ONE
//      undo step each: adjacent commits don't mint empty steps (scenario 2), and the per-verb
//      steps hold ACROSS runs in one plugin session (scenario 3).
//
// Runbook (no plugin rebuild needed — the probe speaks raw figma.*):
//   1. Open the Framelink plugin in a SCRATCH Figma file (the probe drives real undo history).
//   2. pnpm probe:commit-undo
//   3. When the plugin strip shows this session, click Allow.
//
// Run it in a SCRATCH file, really: the probe triggers at most 4 undos, each only after a
// probe-owned commitUndo seal — but seal semantics are exactly the thing under test, so a FAIL
// verdict means that bound may not have held and an undo may have reached the file's own history.
// On a normal exit (PASS or FAIL) every probe node is removed and the removal committed; a probe
// that dies mid-scenario leaves nodes named "flcm-undo-probe-*" to delete by hand.
//
// If it FAILS: invariant 2 names the fallback — the prior honest contract (a failed verb reports
// the canvas may be partially applied; re-read before reasoning). Record the verdict below and the
// observed matrix in the plan; slice 2.3's seal placement is built from it.
//
// Live verdict: (pending — record PASS/FAIL + date + the observed matrix here after each run)

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";

const log = (msg) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const t0 = Date.now();

const bridge = new PluginBridge(undefined, {});

// Shared in-sandbox helpers, prepended to every scenario script. `sample` re-reads liveness after a
// tick too, because whether triggerUndo applies synchronously within a run is itself part of what
// this probe measures.
const HELPERS = `
const mk = (name) => { const r = figma.createRectangle(); r.name = name; r.resize(24, 24); figma.currentPage.appendChild(r); return r.id; };
const alive = async (id) => { const n = await figma.getNodeByIdAsync(id); return !!n && !n.removed; };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = async (ids) => { const out = {}; for (const k of Object.keys(ids)) out[k] = await alive(ids[k]); return out; };
// Count triggerUndos until \`id\` is gone (an empty step between verbs would surface as a count of
// 2, which a single before/after sample structurally cannot see). Capped so broken undo semantics
// can't walk into the file's own history; -1 = never died within the cap.
const undosToRemove = async (id, cap) => {
  for (let n = 1; n <= cap; n++) { figma.triggerUndo(); await tick(100); if (!(await alive(id))) return n; }
  return -1;
};
`;

// Scenario 1 — rollback to the entry seal, with foreign writes sealed before the verb. `foreign`
// stands in for anything the verb didn't write (a human's edit, raw figma.* between verbs, or a
// first verb's empty history): rollback must never erase it.
const SCENARIO_1 = HELPERS + `
const ids = {};
ids.foreign = mk("flcm-undo-probe-foreign");
figma.commitUndo();                       // the verb's ENTRY seal
ids.own1 = mk("flcm-undo-probe-own1");    // the verb's own writes
ids.own2 = mk("flcm-undo-probe-own2");
figma.triggerUndo();                      // the failure path: roll back to the entry seal
const now = await sample(ids);
await tick(100);
const later = await sample(ids);
return { now, later };
`;

// Scenario 2 — per-verb chunking within one run: two verbs exactly as the contract will emit them,
// then COUNT the undos each verb costs. One sample after one undo cannot rule out an empty step
// hiding between verb A's success commit and verb B's entry seal — it would only surface when
// removing A takes 2 undos — so both counts are measured. Caps bound the walk (B: its commit is
// the newest step, so 2 is already generous; A: content + a possible empty neighbor).
const SCENARIO_2 = HELPERS + `
const ids = {};
figma.commitUndo();                       // verb A entry seal
ids.a = mk("flcm-undo-probe-a");
figma.commitUndo();                       // verb A success commit
figma.commitUndo();                       // verb B entry seal — adjacent to A's close
ids.b = mk("flcm-undo-probe-b");
figma.commitUndo();                       // verb B success commit
const undosForB = await undosToRemove(ids.b, 2);
const aSurvivedB = await alive(ids.a);
const undosForA = undosForB === -1 ? null : await undosToRemove(ids.a, 3);
return { undosForB, aSurvivedB, undosForA };
`;

// Scenario 3 — chunking across runs in one plugin session (real usage: many execute_code runs).
// Two verb-shaped runs mint their steps; a third run counts undos per verb, same logic as
// scenario 2.
const scenarioVerbRun = (name) => HELPERS + `
figma.commitUndo();
const id = mk(${JSON.stringify("flcm-undo-probe-" + name)});
figma.commitUndo();
return { id };
`;
const scenarioCrossRunUndo = (ids) => HELPERS + `
const undosForY = await undosToRemove(${JSON.stringify(ids.y)}, 2);
const xSurvivedY = await alive(${JSON.stringify(ids.x)});
const undosForX = undosForY === -1 ? null : await undosToRemove(${JSON.stringify(ids.x)}, 3);
return { undosForY, xSurvivedY, undosForX };
`;

const CLEANUP = `
const nodes = figma.currentPage.findAll((n) => n.name && n.name.indexOf("flcm-undo-probe-") === 0);
for (const n of nodes) n.remove();
figma.commitUndo(); // seal the removals so the user's next undo can't resurrect probe debris
return nodes.length;
`;

// The probe is interactive tooling, not an MCP tool call, so it isn't bound by a client's 60s
// budget — give the human a long window to notice the strip and click Allow.
const APPROVAL_WINDOW_MS = 10 * 60_000;

// Set once the first script has actually run — gates the best-effort cleanup on the failure path
// (an unapproved session can't run cleanup either, and must not hang another approval window).
let approvedOnce = false;

async function exec(code) {
  const reply = await requestUntilApproved(
    () => bridge.request({ type: "EXECUTE_CODE", code }),
    { waitMs: APPROVAL_WINDOW_MS },
  );
  if (reply?.type === "PENDING_APPROVAL") {
    throw new Error("the session was never approved — click Allow on the Framelink strip and re-run the probe.");
  }
  // Any execution reply proves the session ran code — set BEFORE the errors check, so a scenario
  // that created nodes and then threw still gets the failure-path cleanup.
  approvedOnce = true;
  if (reply?.errors) throw new Error(`a probe script errored in the sandbox:\n${reply.errors}`);
  return reply?.result;
}

// Re-introduce the session on EVERY connect: the plugin binds identity/pairing per connection, so
// a mid-wait reconnect (Figma reload, plugin reopen) without a fresh SESSION_INFO would leave an
// unidentifiable, unapprovable row on the strip. Scenarios still start only once.
async function introduceSession() {
  log("plugin connected — introducing the session");
  await bridge.request({
    type: "SESSION_INFO",
    identity: SESSION_IDENTITY,
    pairingCode: bridge.getPairingCode(),
    sessionToken: bridge.getSessionToken(),
  });
  log(`if the strip asks, click Allow (pairing code ${bridge.getPairingCode()})`);
}

let started = false;
async function runProbe() {
  try {
    await introduceSession();
  } catch (err) {
    log(`session introduction failed (${err instanceof Error ? err.message : err}) — will retry on the next reconnect`);
    return;
  }
  if (started) return; // reconnects must not restart a probe already in flight
  started = true;
  try {
    const findings = [];
    let pass = true;

    // Scenario 1: rollback.
    const s1 = await exec(SCENARIO_1);
    const rollback = s1.later.foreign === true && s1.later.own1 === false && s1.later.own2 === false;
    const syncApply = s1.now.own1 === false && s1.now.own2 === false;
    log(`scenario 1 (rollback): now=${JSON.stringify(s1.now)} later=${JSON.stringify(s1.later)}`);
    if (rollback) {
      findings.push(
        `rollback: triggerUndo reverted exactly the verb's own writes (foreign write survived); ` +
          `applies ${syncApply ? "synchronously in-run" : "only after a tick — rollback paths must await one"}.`,
      );
    } else {
      pass = false;
      findings.push(`rollback FAILED: observed ${JSON.stringify(s1.later)} — a failed verb cannot cleanly revert. Fall back to invariant 2's honest partial-state error contract.`);
    }

    if (!rollback && s1.later.own1 === true) {
      // triggerUndo never applied in-run at all — the counting loops below would walk blind into
      // real history. Bail to cleanup with the one finding that matters.
      pass = false;
      findings.push(
        "triggerUndo did not apply within the run — scenarios 2/3 skipped; the whole in-run rollback design needs rethinking (multi-run probing next).",
      );
    } else {
      // Scenario 2: per-verb chunking in one run, counted (1 undo per verb = clean; 2 for the
      // older verb = an empty step hides between adjacent commits).
      const s2 = await exec(SCENARIO_2);
      log(`scenario 2 (chunking): ${JSON.stringify(s2)}`);
      if (s2.undosForB === 1 && s2.aSurvivedB && s2.undosForA === 1) {
        findings.push("chunking: one undo = one verb, both verbs; adjacent entry/success commits mint NO empty step.");
      } else if (s2.undosForB === 1 && s2.aSurvivedB && s2.undosForA === 2) {
        pass = false;
        findings.push(
          "chunking FINDING: an empty step hides between verbs (removing the older verb cost 2 undos). Slice 2.3 must not commit twice at a quiet boundary — e.g. skip the entry seal when nothing preceded it.",
        );
      } else {
        pass = false;
        findings.push(`chunking FAILED: ${JSON.stringify(s2)} — per-verb undo steps don't hold in-run.`);
      }

      // Scenario 3: chunking across runs, same counting.
      const runX = await exec(scenarioVerbRun("x"));
      const runY = await exec(scenarioVerbRun("y"));
      const s3 = await exec(scenarioCrossRunUndo({ x: runX.id, y: runY.id }));
      log(`scenario 3 (cross-run): ${JSON.stringify(s3)}`);
      if (s3.undosForY === 1 && s3.xSurvivedY && s3.undosForX === 1) {
        findings.push("cross-run: one undo per verb across separate runs; earlier runs' work stood until its own undo.");
      } else {
        pass = false;
        findings.push(`cross-run FAILED: ${JSON.stringify(s3)} — per-verb steps don't hold across runs.`);
      }
    }

    const removed = await exec(CLEANUP);
    log(`cleanup removed ${removed} probe node(s)`);

    console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — commitUndo/triggerUndo contract:`);
    for (const f of findings) console.log(`  • ${f}`);
    if (pass) {
      console.log(
        "\nInvariant 2's rollback and invariant 4's one-undo-step-per-verb are CONFIRMED live — " +
          "record the [directional] markers as [verified] in the plan.",
      );
    } else {
      console.log("\nRecord the observed matrix in the plan and shape slice 2.3's seal placement from it.");
    }
    process.exit(pass ? 0 : 1);
  } catch (err) {
    // Best-effort cleanup before dying — a mid-scenario error must not strand probe nodes. Only
    // once a script has run (an unapproved session would just hang a second approval window).
    if (approvedOnce) {
      log("probe errored — attempting cleanup of probe nodes");
      await exec(CLEANUP).catch(() => {});
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

function fail(reason) {
  console.error(`\n❌ FAIL — ${reason}`);
  process.exit(1);
}

console.log(
  "Framelink undo-contract probe: commitUndo chunking + triggerUndo rollback, live.\n" +
    "Waiting for the Figma plugin to connect… (open it in a SCRATCH file and approve this session\n" +
    "when asked; Ctrl-C to abort)\n",
);
bridge.start(WS_PORT_BLOCK, () => void runProbe());
