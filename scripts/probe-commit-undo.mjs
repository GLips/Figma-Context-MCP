// LIVE PROBE for the undo contract behind plan invariants 2 and 4 (flcm edit surface, Phase 2 step
// zero) — a standing runbook, not a one-shot: re-run whenever the verbs' seal placement (commitUndo
// at entry/success), the rollback path (triggerUndo), or the eval wrapper changes shape. No
// headless harness can answer this; the mock has no undo history.
//
// What it grounds (the plan marks the contract [directional] until this passes):
//   1. ROLLBACK — semantics hand-verified 2026-08-07: figma.triggerUndo() reverts the last
//      COMMITTED step, swallowing any uncommitted trailing writes with it. So the BARE shape
//      (scenario 1: triggerUndo over the failed verb's uncommitted writes) is expected to
//      OVERREACH into the foreign step, and COMMIT-THEN-UNDO (scenario 1b: seal the partial
//      writes into their own step, then pop exactly it) is the shape slice 2.3 builds. 1b also
//      counts the undos back past a PREVIOUS verb after the rollback — invariant 4's interaction:
//      a rolled-back verb must not leave the user an empty residue step to press through.
//   2. CHUNKING — two verbs each emitting [entry seal → writes → success commit] cost the user ONE
//      undo step each: adjacent commits don't mint empty steps (scenario 2), and the per-verb
//      steps hold ACROSS runs in one plugin session (scenario 3).
//
// Each scenario proves its own setup (a `pre` liveness sample) before asserting anything about
// undo — a creation failure and a broken rollback otherwise both read as "everything false", and
// the first live run returned exactly that uniform nothing. "PRECONDITION NOT MET" is a distinct
// verdict from "rollback is broken".
//
// Runbook (no plugin rebuild needed — the probe speaks raw figma.*):
//   1. Open the Framelink plugin in a SCRATCH Figma file (the probe drives real undo history).
//   2. pnpm probe:commit-undo
//   3. When the plugin strip shows this session, click Allow.
//
// Run it in a SCRATCH file, really: the probe triggers at most 15 undos (1 in scenario 1; 1 + a
// capped walk of 3 in 1b; the counting loops in 2/3 walk up to 5 each), every one after a
// probe-owned commitUndo seal — but seal semantics are exactly the thing under test, so a FAIL
// verdict means that bound may not have held and an undo may have reached the file's own history.
// On a normal exit (PASS or FAIL) every probe node is removed and the removal committed; a probe
// that dies mid-scenario leaves nodes named "flcm-undo-probe-*" to delete by hand.
//
// If it FAILS: invariant 2 names the fallback — the prior honest contract (a failed verb reports
// the canvas may be partially applied; re-read before reasoning). Record the verdict below and the
// observed matrix in the plan; slice 2.3's seal placement is built from it.
//
// Live verdict (2026-08-07):
//   CHUNKING CONFIRMED — probe run 1: s2 {undosForB:1, aSurvivedB:true, undosForA:1};
//     s3 {undosForY:1, xSurvivedY:true, undosForX:1}.
//   BARE ROLLBACK OVERREACHES — hand repro, precondition verified live: seal → writes →
//     triggerUndo with NO closing commit gave afterUndo {foreign:false, own1:false, own2:false};
//     the identical sequence WITH a closing commitUndo() before triggerUndo gave {foreign:true,
//     own1:false, own2:false}. triggerUndo reverts the last COMMITTED step.
//   PENDING — full probe re-run with both shapes + the 1b residue count (undosForPrev).

import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { requestUntilApproved } from "../src/services/plugin-bridge/await-approval.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";

// These probes drive a REAL plugin, which holds no runtime of its own (ADR-0010) — so they must
// ship the actual std-lib, not a stand-in. Built once here through the same seam the server build
// uses; the contract harness, whose fake plugin never evals anything, uses a stub instead.
const PREAMBLE = await buildSandboxPreamble();


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

// Scenario 1 — bare rollback to the entry seal, with foreign writes sealed before the verb.
// `foreign` stands in for anything the verb didn't write (a human's edit, raw figma.* between
// verbs, or a first verb's empty history): rollback must never erase it. Hand-verified 2026-08-07
// to OVERREACH (the undo eats the foreign step too) — kept, expected to fail, because the
// bare-vs-1b difference IS the finding and a future Figma semantics change here should be noticed.
const SCENARIO_1 = HELPERS + `
const ids = {};
ids.foreign = mk("flcm-undo-probe-foreign");
const foreignBorn = await alive(ids.foreign);
figma.commitUndo();                       // the verb's ENTRY seal
ids.own1 = mk("flcm-undo-probe-own1");    // the verb's own writes
ids.own2 = mk("flcm-undo-probe-own2");
const pre = await sample(ids);            // prove the setup, or return a distinct verdict
if (!foreignBorn || !pre.foreign || !pre.own1 || !pre.own2) return { precondition: { foreignBorn, pre } };
figma.triggerUndo();                      // the failure path: roll back to the entry seal
const now = await sample(ids);
await tick(100);
const later = await sample(ids);
return { pre, now, later };
`;

// Scenario 1b — commit-then-undo rollback, hand-verified clean 2026-08-07: the failure path SEALS
// the partial writes into their own step, then pops exactly it. A full previous verb (seal →
// write → commit) stands before the failed one so the scenario also answers invariant 4's
// interaction: after the rollback, how many undos take the user back past the PREVIOUS verb?
// 1 = the rolled-back verb left no residue step; 2 = it minted an empty step slice 2.3's seal
// placement must avoid.
const SCENARIO_1B = HELPERS + `
const ids = {};
figma.commitUndo();                       // previous verb: entry seal
ids.prev = mk("flcm-undo-probe-1b-prev");
figma.commitUndo();                       // previous verb: success commit
figma.commitUndo();                       // failed verb: entry seal
ids.own1 = mk("flcm-undo-probe-1b-own1");
ids.own2 = mk("flcm-undo-probe-1b-own2");
const pre = await sample(ids);
if (!pre.prev || !pre.own1 || !pre.own2) return { precondition: { pre } };
figma.commitUndo();                       // failure path: seal the partial writes into their own step
figma.triggerUndo();                      // pop exactly that step
await tick(100);
const afterRollback = await sample(ids);
const clean = afterRollback.prev && !afterRollback.own1 && !afterRollback.own2;
const undosForPrev = clean ? await undosToRemove(ids.prev, 3) : null;
return { pre, afterRollback, undosForPrev };
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
    () => bridge.request({ type: "EXECUTE_CODE", code, preamble: PREAMBLE }),
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
    // Which rollback shape holds: "bare" (triggerUndo over uncommitted writes), "commit-then-undo"
    // (seal first, then trigger), or null. Invariant 2 needs SOME shape; slice 2.3 builds the one
    // that measured true.
    let rollbackShape = null;

    // Scenario 1: bare rollback.
    const s1 = await exec(SCENARIO_1);
    log(`scenario 1 (bare rollback): ${JSON.stringify(s1)}`);
    let setupBroken = false;
    let undoInert = false;
    if (s1.precondition) {
      // A distinct verdict from "rollback is broken": the setup writes never became observable,
      // so this scenario measured nothing about undo.
      pass = false;
      setupBroken = true;
      findings.push(
        `scenario 1 PRECONDITION NOT MET (${JSON.stringify(s1.precondition)}) — creation/readback failed before any undo was triggered; rollback is UNVERDICTED. Fix the probe or the figma.* path first.`,
      );
    } else if (s1.later.foreign === true && s1.later.own1 === false && s1.later.own2 === false) {
      rollbackShape = "bare";
      const syncApply = s1.now.own1 === false && s1.now.own2 === false;
      findings.push(
        `rollback (bare triggerUndo): reverted exactly the verb's own writes; applies ${syncApply ? "synchronously in-run" : "only after a tick — rollback paths must await one"}.`,
      );
    } else {
      undoInert = s1.later.foreign === true && s1.later.own1 === true && s1.later.own2 === true;
      findings.push(
        `rollback (bare triggerUndo) FAILED: later=${JSON.stringify(s1.later)} — ` +
          (undoInert
            ? "triggerUndo did not apply in-run at all."
            : "the undo reached past the entry seal (matches the hand-verified semantics: triggerUndo reverts the last COMMITTED step and swallows uncommitted trailing writes with it)."),
      );
    }

    if (setupBroken || undoInert) {
      pass = false;
      findings.push("scenarios 1b/2/3 skipped — their counting loops would walk blind without working in-run creation + undo.");
    } else {
      // Scenario 1b: commit-then-undo rollback — the implementable shape when bare overreaches.
      const s1b = await exec(SCENARIO_1B);
      log(`scenario 1b (commit-then-undo): ${JSON.stringify(s1b)}`);
      if (s1b.precondition) {
        pass = false;
        findings.push(`scenario 1b PRECONDITION NOT MET (${JSON.stringify(s1b.precondition)}) — unverdicted.`);
      } else if (s1b.afterRollback.prev === true && s1b.afterRollback.own1 === false && s1b.afterRollback.own2 === false) {
        if (!rollbackShape) rollbackShape = "commit-then-undo";
        if (s1b.undosForPrev === 1) {
          findings.push(
            "rollback (commit-then-undo): sealing the failed writes then one triggerUndo reverted exactly them, and the PREVIOUS verb still cost one undo — the rolled-back verb left no residue step.",
          );
        } else {
          pass = false;
          findings.push(
            `rollback (commit-then-undo) reverted cleanly BUT left residue: getting back past the previous verb cost ${s1b.undosForPrev} undo(s) — slice 2.3's seal placement must not mint that extra step.`,
          );
        }
      } else {
        findings.push(`rollback (commit-then-undo) FAILED: afterRollback=${JSON.stringify(s1b.afterRollback)}.`);
      }
      if (!rollbackShape) {
        pass = false;
        findings.push(
          "NO rollback shape holds — invariant 2 falls back to the honest partial-state error contract (a failed verb reports the canvas may be partially applied).",
        );
      }
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
        `\nRollback shape: ${rollbackShape}. Invariant 2's rollback (via that shape) and invariant 4's ` +
          "one-undo-step-per-verb are CONFIRMED live — record the [directional] markers as [verified] " +
          "in the plan, naming the shape slice 2.3 must build.",
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
