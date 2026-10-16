/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// LIVE BENCHMARK of flcm against the real plugin — how long each verb holds Figma's main thread on a
// page as heavy as a real marketing file. The mock harness (plugin/harness) can't answer this: the
// cost lives in Figma's native tree walks, which only a live document has.
//
// It builds a reproducible heavy fixture on the bench page (a section of instances of a ~130-node
// component, each holding a nested variant instance and hidden layers), then runs scenarios that each
// time every verb from inside the sandbox. While a verb runs synchronously, Figma is frozen, so a
// verb's time IS the freeze it causes. Results print as a table and are saved under logs/ to compare
// before and after a fix.
//
// Runbook:
//   1. pnpm build:plugin, and import plugin/manifest.json from this checkout if the plugin is stale.
//   2. Open the plugin in a file with a page the bench may fill (BENCH_PAGE).
//   3. FIGMA_DOCUMENT=<document id> pnpm bench:live [scenario…] — Allow this project once in the plugin.
// Env: BENCH_PAGE (page name, required), BENCH_INSTANCES (fixture size, default 200).
// `pnpm bench:live fixture-reset` deletes the fixture; the next run rebuilds it at the new size.

import { mkdirSync, writeFileSync } from "node:fs";
import { PluginBridge } from "../src/commercial/plugin-bridge/bridge.ts";
import { RequestTrace } from "../src/commercial/plugin-bridge/request-trace.ts";
import { WS_PORT_BLOCK } from "../plugin/src/protocol.ts";
import { LATE_CHANGE_WINDOW_MS } from "../src/commercial/entitlement/write-meter.ts";
import { executeOnProbeTarget, targetForProbe } from "./probe-link.mjs";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";
import { mintSessionHandle } from "../src/commercial/plugin-bridge/session-handle.ts";

const PREAMBLE = await buildSandboxPreamble();
const PAGE = process.env.BENCH_PAGE;
const INSTANCES = Number(process.env.BENCH_INSTANCES ?? 200);
// Raw createInstance is cheap, but a batch must still finish inside the server's inactivity deadline.
const INSTANCES_PER_CALL = 40;
const FIXTURE_SECTION = "bench-fixture";

if (!PAGE) {
  console.error("Set BENCH_PAGE to the name of a page the bench may fill.");
  process.exit(1);
}

const t0 = Date.now();
const log = (msg) => console.log(`[bench +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// Prepended to every run: switch to the bench page, and `step` times one awaited operation. A run
// that throws still reports the steps it finished, which is what locates a slow or stuck verb.
const PRELUDE = `
const __steps = [];
async function step(label, run) {
  const started = Date.now();
  try { return await run(); } finally { __steps.push([label, Date.now() - started]); }
}
const __page = figma.root.children.find((p) => p.name === ${JSON.stringify(PAGE)});
if (!__page) throw new Error("no page named " + ${JSON.stringify(JSON.stringify(PAGE))});
await figma.setCurrentPageAsync(__page);
`;

function benchCode(body) {
  return `${PRELUDE}
try {
  const value = await (async () => { ${body}\n })();
  return { steps: __steps, value };
} catch (error) {
  return { steps: __steps, error: String(error && error.message || error) };
}`;
}

// Raw figma for the fixture: it is scenery, not the thing under test.
const FIXTURE_DEFINITIONS = `
let section = figma.currentPage.children.find((n) => n.type === "SECTION" && n.name === ${JSON.stringify(FIXTURE_SECTION)});
if (!section) {
  section = figma.createSection();
  section.name = ${JSON.stringify(FIXTURE_SECTION)};
  section.x = 0; section.y = 0;
}
let toggle = section.children.find((n) => n.type === "COMPONENT_SET" && n.name === "bench/Toggle");
let heavy = section.children.find((n) => n.type === "COMPONENT" && n.name === "bench/Heavy");
if (!toggle || !heavy) {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  const states = ["On", "Off"].map((state) => {
    const c = figma.createComponent();
    c.name = "State=" + state;
    c.layoutMode = "HORIZONTAL"; c.itemSpacing = 4; c.paddingLeft = c.paddingRight = 4;
    c.primaryAxisSizingMode = "AUTO"; c.counterAxisSizingMode = "AUTO";
    const knob = figma.createEllipse(); knob.resize(16, 16); c.appendChild(knob);
    const label = figma.createText(); label.characters = state; c.appendChild(label);
    return c;
  });
  toggle = figma.combineAsVariants(states, section);
  toggle.name = "bench/Toggle";
  heavy = figma.createComponent();
  heavy.name = "bench/Heavy";
  heavy.layoutMode = "VERTICAL"; heavy.itemSpacing = 4;
  heavy.primaryAxisSizingMode = "AUTO"; heavy.counterAxisSizingMode = "AUTO";
  for (let r = 0; r < 12; r++) {
    const row = figma.createFrame();
    row.name = "bench-row"; row.layoutMode = "HORIZONTAL"; row.itemSpacing = 4;
    row.primaryAxisSizingMode = "AUTO"; row.counterAxisSizingMode = "AUTO";
    const text = figma.createText(); text.characters = "Row " + r; row.appendChild(text);
    for (let i = 0; i < 3; i++) { const rect = figma.createRectangle(); rect.resize(12, 12); row.appendChild(rect); }
    const dot = figma.createEllipse(); dot.resize(8, 8); row.appendChild(dot);
    row.appendChild(toggle.defaultVariant.createInstance());
    const hidden = figma.createRectangle(); hidden.visible = false; row.appendChild(hidden);
    heavy.appendChild(row);
  }
  section.appendChild(heavy);
  heavy.x = 0; heavy.y = 200;
}
`;

const FIXTURE_FILL = (target) =>
  benchCode(`
${FIXTURE_DEFINITIONS}
const have = section.children.filter((n) => n.type === "INSTANCE").length;
const add = Math.min(${INSTANCES_PER_CALL}, ${target} - have);
for (let i = 0; i < add; i++) {
  const instance = heavy.createInstance();
  section.appendChild(instance);
  const n = have + i;
  instance.x = 400 + (n % 20) * 260; instance.y = 200 + Math.floor(n / 20) * 700;
}
section.resizeWithoutConstraints(400 + 20 * 260, 200 + Math.ceil(${target} / 20) * 700 + 200);
const instances = section.children.filter((n) => n.type === "INSTANCE");
return {
  instances: instances.length,
  heavyId: heavy.id,
  toggleId: toggle.id,
  sampleInstanceId: instances[0]?.id ?? null,
  deepRowId: instances[0]?.children[5]?.id ?? null,
};`);

// The shape of the build that wedged: components holding nested variant instances, then sets.
function buildScenario(fx) {
  return `
const made = [];
try {
  for (let s = 0; s < 3; s++) {
    const members = [];
    for (const kind of ["A", "B"]) {
      const c = await step("component " + s + kind, () => flcm.component({
        type: "FRAME", name: "Kind=" + kind, left: 60000 + s * 400, top: 0,
        layout: { mode: "row", gap: 8, padding: 8 },
        children: [
          { type: "TEXT", text: "Set " + s + " " + kind },
          { type: "INSTANCE", componentId: ${JSON.stringify(fx.toggleId)}, componentProperties: { State: "Off" } },
          { type: "INSTANCE", componentId: ${JSON.stringify(fx.heavyId)}, rotation: 45 },
        ],
      }));
      made.push(c.id);
      members.push({ component: c.id, variant: { Kind: kind } });
    }
    const set = await step("variants " + s, () => flcm.variants(members, { name: "bench-set-" + s }));
    made.push(set.id);
  }
} finally {
  for (const id of made.reverse()) (await figma.getNodeByIdAsync(id))?.remove();
}`;
}

// Scenarios: each body runs in one call and times its verbs with `step`. `fx` is the fixture's ids.
const SCENARIOS = {
  // Target lookups by id and by key: neither may cost a walk of the page.
  lookup: (fx) => `
const id = ${JSON.stringify(fx.sampleInstanceId)};
for (let i = 0; i < 5; i++) await step("measure(id)", () => flcm.measure(id));
for (let i = 0; i < 5; i++) await step("measure(missing key)", () => flcm.measure("bench-no-such-key").catch(() => null));`,

  build: buildScenario,

  // One component per variation, adding one ingredient at a time, to find what a component costs.
  "component-parts": (fx) => `
const made = [];
const variations = {
  "frame + text": [{ type: "TEXT", text: "Label" }],
  "+ small instance": [{ type: "TEXT", text: "Label" }, { type: "INSTANCE", componentId: ${JSON.stringify(fx.toggleId)} }],
  "+ heavy instance": [{ type: "TEXT", text: "Label" }, { type: "INSTANCE", componentId: ${JSON.stringify(fx.heavyId)} }],
  "+ heavy rotated": [{ type: "TEXT", text: "Label" }, { type: "INSTANCE", componentId: ${JSON.stringify(fx.heavyId)}, rotation: 45 }],
};
try {
  let n = 0;
  for (const [label, children] of Object.entries(variations)) {
    for (let i = 0; i < 3; i++) {
      const spec = { type: "FRAME", left: 70000 + n++ * 400, top: 0, layout: { mode: "row", gap: 8 }, children };
      made.push((await step("render " + label, () => flcm.render(spec))).id);
      made.push((await step("component " + label, () => flcm.component({ ...spec, left: 70000 + n++ * 400 }))).id);
    }
  }
} finally {
  for (const id of made.reverse()) (await figma.getNodeByIdAsync(id))?.remove();
}`,

  // Edits deep inside the fixture section: the post-write layout checks climb to the section.
  "edit-deep": (fx) => `
const id = ${JSON.stringify(fx.deepRowId)};
for (let i = 0; i < 3; i++) await step("edit deep row", () => flcm.edit(id, { opacity: i % 2 ? 1 : 0.99 }));`,

  find: () => `
await step("find name=bench-row", () => flcm.find({ name: "bench-row" }));
await step("findOne key", () => flcm.find({ key: "no-such-key" }));`,

  tokens: () => `await step("designTokens()", () => flcm.designTokens());`,
};

const FIXTURE_RESET = benchCode(`
const section = figma.currentPage.children.find((n) => n.type === "SECTION" && n.name === ${JSON.stringify(FIXTURE_SECTION)});
section?.remove();
return { removed: !!section };`);

function printSteps(name, wallMs, result) {
  console.log(`\n── ${name}: ${wallMs}ms wall`);
  for (const [label, ms] of result?.steps ?? [])
    console.log(`   ${String(ms).padStart(7)}ms  ${label}`);
  // The plugin's live step reports, so a run that hangs still shows the step it stopped at.
  for (const e of result?.trace ?? [])
    console.log(
      `   ${String(e.hostElapsedMs).padStart(7)}ms  · ${e.hostStage}${e.operation ? " " + e.operation : ""}`,
    );
  if (result?.error) console.log(`   ERROR: ${result.error}`);
}

// One session for the whole bench, so the plugin's activity feed reads as one agent's work.
const SESSION_HANDLE = mintSessionHandle();
let sessionCreated = false;

async function run(target, code) {
  const started = Date.now();
  try {
    const session = { handle: SESSION_HANDLE, create: !sessionCreated };
    traced.length = 0;
    const reply = await executeOnProbeTarget(bridge, target, {
      code,
      preamble: PREAMBLE,
      lateChangeWindowMs: LATE_CHANGE_WINDOW_MS,
      session,
    });
    sessionCreated = true;
    const wallMs = Date.now() - started;
    const trace = [...traced];
    if (reply.errors) return { wallMs, result: { steps: [], error: reply.errors, trace } };
    return { wallMs, result: { ...reply.result, trace } };
  } catch (error) {
    return {
      wallMs: Date.now() - started,
      result: {
        steps: [],
        error: error instanceof Error ? error.message : String(error),
        trace: [...traced],
      },
    };
  }
}

// Runs are sequential, so every host step reported since a run was submitted is that run's.
const traced = [];
const bridge = new PluginBridge({
  capabilities: new Map(),
  trace: new RequestTrace((event) => {
    if (event.stage === "host") traced.push(event);
  }),
});
let started = false;
async function main() {
  if (started) return; // a reconnect must not start a second bench
  started = true;
  const requested = process.argv.slice(2);
  const target = await targetForProbe(bridge, log);
  log(`session ${SESSION_HANDLE}`);

  if (requested.includes("fixture-reset")) {
    const { result } = await run(target, FIXTURE_RESET);
    log(
      result?.error
        ? `reset failed: ${result.error}`
        : `fixture removed: ${result?.value?.removed}`,
    );
    process.exit(0);
  }

  let fixture;
  for (;;) {
    const { wallMs, result } = await run(target, FIXTURE_FILL(INSTANCES));
    if (result?.error) throw new Error(`fixture build failed: ${result.error}`);
    fixture = result.value;
    log(`fixture: ${fixture.instances}/${INSTANCES} instances (${wallMs}ms)`);
    if (fixture.instances >= INSTANCES) break;
  }

  const names = requested.length ? requested : Object.keys(SCENARIOS);
  const report = { at: new Date().toISOString(), page: PAGE, instances: INSTANCES, scenarios: {} };
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario)
      throw new Error(`no scenario "${name}" — choose from ${Object.keys(SCENARIOS).join(", ")}`);
    const { wallMs, result } = await run(target, benchCode(scenario(fixture)));
    printSteps(name, wallMs, result);
    report.scenarios[name] = { wallMs, ...result };
  }
  mkdirSync("logs", { recursive: true });
  const path = `logs/bench-live-${report.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  log(`saved ${path}`);
  process.exit(0);
}

console.log("Framelink live bench. Waiting for the Figma plugin to connect…");
bridge.start(
  WS_PORT_BLOCK,
  () =>
    void main().catch((error) => {
      console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }),
);
