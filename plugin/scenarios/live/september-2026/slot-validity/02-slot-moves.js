/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Run live once on 2026-09-13. See README.md for observed results and limitations.
// See README.md for source observations, interpretation, screenshots, and cleanup.
const report = {
  scenario: "02-slot-moves",
  status: "setup_pending",
  setup: { verified: false },
  observations: [],
  screenshotTargets: [],
  cleanup: { policy: "Retain this run's page, including failed fixtures, until reviewed." },
};
let phase = "setup";
const errorText = (error) => String(error && error.message ? error.message : error);
const requireFixture = (condition, message) => {
  if (!condition) throw new Error("Fixture verification: " + message);
};
async function capture(label, read) {
  try {
    const value = await read();
    return { label, outcome: "read", value: JSON.parse(JSON.stringify(value)) };
  } catch (error) {
    return { label, outcome: "error", error: errorText(error) };
  }
}
async function nodeById(id, type) {
  const node = await figma.getNodeByIdAsync(id);
  requireFixture(node !== null, "ID did not resolve: " + id);
  requireFixture(node.type === type, "Expected " + type + " at " + id);
  return node;
}
function screenshot(key, node, expectedVisualCheck) {
  report.screenshotTargets.push({ key, nodeId: node.id, expectedVisualCheck });
}
// Each field is independent: an unreadable name cannot hide a readable type or width.
// The walk accounts for failed child enumeration and failed/null ID resolution.
async function inspect(root, expectedNodes) {
  const nodes = [];
  let fieldErrors = 0;
  let unresolvedIds = 0;
  async function visit(node, path) {
    const fields = {};
    for (const field of ["id", "type", "name", "removed", "x", "y", "width", "height",
      "layoutMode", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "characters"]) {
      fields[field] = await capture(field, () => {
        const value = node[field];
        return value === undefined ? null : value;
      });
      if (fields[field].outcome === "error") fieldErrors++;
    }
    fields.parentId = await capture("parentId", () => node.parent ? node.parent.id : null);
    if (fields.parentId.outcome === "error") fieldErrors++;
    const id = fields.id.outcome === "read" ? fields.id.value : null;
    const lookup = await capture("lookup", async () => {
      if (!id) return { found: false, reason: "ID unreadable" };
      const fresh = await figma.getNodeByIdAsync(id);
      return fresh ? { found: true, id: fresh.id, name: fresh.name, type: fresh.type,
        width: fresh.width, height: fresh.height } : { found: false };
    });
    if (lookup.outcome === "error" || !lookup.value.found) unresolvedIds++;
    const children = await capture("children", () => "children" in node ? node.children.length : 0);
    if (children.outcome === "error") fieldErrors++;
    nodes.push({ path, fields, lookup, children });
    if (children.outcome === "read") {
      for (let index = 0; index < children.value; index++) {
        // Retain inaccessible entries too; do not silently skip a child handle.
        try { await visit(node.children[index], path + "/" + index); }
        catch (error) { fieldErrors++; nodes.push({ path: path + "/" + index, error: errorText(error) }); }
      }
    }
  }
  await visit(root, "root");
  return { expectedNodes, visitedNodes: nodes.length, fieldErrors, unresolvedIds,
    coverage: nodes.length === expectedNodes && fieldErrors === 0 && unresolvedIds === 0
      ? "complete" : "incomplete", nodes };
}
async function setup() {
  const previousPageId = figma.currentPage.id;
  const page = figma.createPage();
  page.name = "FLCM scenario / " + "02-slot-moves" + " / " + page.id;
  report.cleanup.pageId = page.id;
  report.cleanup.pageName = page.name;
  report.cleanup.previousPageId = previousPageId;
  await figma.setCurrentPageAsync(page);
  requireFixture(figma.currentPage.id === page.id, "New run page is not current");
  const item = await flcm.component(flcm.frame({ name: "Audit tile", width: 144, height: 80,
    fill: "#FFFFFF", layout: { mode: "column", gap: 8, padding: 8 } }, [
    flcm.rect({ name: "Audit magenta sentinel", width: 32, height: 16, fill: "#D000FF" }),
    flcm.text("SLOT SENTINEL", { name: "Audit text sentinel" }),
  ]), { name: "Fixture / Audit tile" });
  const slot = (key, name, fill) => flcm.frame({ key, name, width: 353, height: 180, fill,
    layout: { mode: "column", padding: 8 }, componentPropertyReferences: { slot: name } });
  const host = await flcm.component(flcm.frame({ name: "Two-slot host", width: 393, height: 420,
    fill: "#E8E8E8", layout: { mode: "column", padding: 20, gap: 12 } }, [
    slot("sourceSlot", "Source", "#FFF0E0"), slot("destinationSlot", "Destination", "#E0F0FF"),
  ]), { name: "Fixture / Two-slot host", propertyDefinitions: {
    Source: { type: "slot" }, Destination: { type: "slot" },
  } });
  const itemNode = await nodeById(item.node.id, "COMPONENT");
  const hostNode = await nodeById(host.node.id, "COMPONENT");
  itemNode.x = 0; itemNode.y = 0; hostNode.x = 180; hostNode.y = 0;
  requireFixture(itemNode.children.length === 2, "Audit tile must have two sublayers");
  requireFixture(itemNode.children[0].name === "Audit magenta sentinel" &&
    itemNode.children[1].characters === "SLOT SENTINEL", "Master sentinels differ");
  const paths = { source: host.keyed.sourceSlot.id, destination: host.keyed.destinationSlot.id };
  async function populated(name, children, x, y) {
    const result = await flcm.render(flcm.instance(host.node.id, { name, left: x, top: y,
      overrides: { [paths.source]: { children }, [paths.destination]: { children: [] } },
    }));
    const node = await nodeById(result.node.id, "INSTANCE");
    requireFixture(node.children.length === 2, "Host must expose exactly two children");
    const source = node.children[0];
    const destination = node.children[1];
    requireFixture(source.type === "SLOT" && source.name === "Source", "Source slot missing");
    requireFixture(destination.type === "SLOT" && destination.name === "Destination", "Destination slot missing");
    requireFixture(source.children.length === children.length && destination.children.length === 0,
      "Slot fill did not match declared fixture");
    return { result, node, source, destination };
  }
  return { page, item, host, paths, populated };
}
try {
  const fixture = await setup();
  // Four independent subjects. A damaged raw move cannot contaminate a dialect comparison.
  const cases = [];
  for (const [index, mode] of ["raw-to-slot", "raw-to-frame", "flcm-to-slot", "flcm-to-frame"].entries()) {
    const resident = await fixture.populated(mode, [flcm.instance(fixture.item.node.id,
      { key: "subject", name: mode + " tile" })], 620 + index * 440, 0);
    const targetResult = await flcm.render(flcm.frame({ name: mode + " / frame destination",
      left: 620 + index * 440, top: 480, width: 393, height: 140, fill: "#E0FFE0",
      layout: { mode: "column", padding: 8 } }));
    const frame = await nodeById(targetResult.node.id, "FRAME");
    const subject = resident.source.children[0];
    requireFixture(subject.type === "INSTANCE" && subject.id === resident.result.keyed.subject.id,
      mode + ": returned key does not identify donated instance");
    requireFixture(frame.children.length === 0, mode + ": frame destination not empty");
    cases.push({ mode, resident, frame, subject, originalId: subject.id });
    screenshot(mode + "-host", resident.node, "After success, Source empty. For a slot move, Destination has one intact tile; for a frame move, both slots empty. After refusal, check original Source tile remains intact.");
    screenshot(mode + "-frame", frame, "After successful frame move, exactly one swatch and SLOT SENTINEL. Otherwise empty. Check against operation outcome and baseline.");
  }
  report.setup = { verified: true, cases: cases.map((entry) => ({ mode: entry.mode,
    hostId: entry.resident.node.id, originalId: entry.originalId, sourceId: entry.resident.source.id,
    slotDestinationId: entry.resident.destination.id, frameDestinationId: entry.frame.id })) };
  phase = "move observations";
  report.status = "observations_recorded";
  for (const entry of cases) {
    const destination = entry.mode.endsWith("to-slot") ? entry.resident.destination : entry.frame;
    const observation = { mode: entry.mode, originalId: entry.originalId, destinationId: destination.id,
      before: await inspect(entry.subject, 3) };
    // Store before executing so an unexpected later failure cannot erase this evidence.
    report.observations.push(observation);
    observation.operation = await capture(entry.mode, async () => {
      if (entry.mode.startsWith("raw")) {
        destination.appendChild(entry.subject);
        return { returnedNormally: true };
      }
      return await flcm.move(flcm.id(entry.originalId), flcm.id(destination.id));
    });
    observation.retainedHandleAfter = await inspect(entry.subject, 3);
    observation.originalIdAfter = await capture("original ID lookup", async () => {
      const fresh = await figma.getNodeByIdAsync(entry.originalId);
      return fresh ? await inspect(fresh, 3) : { found: false };
    });
    // Reacquire both parents, enumerate actual destination children, and inspect new handles.
    // Do not infer identity or liveness from an ID spelling or from appendChild returning.
    for (const [label, id, expectedNodes] of [["sourceAfter", entry.resident.source.id, 1],
      ["destinationAfter", destination.id, 4]]) {
      observation[label] = await capture(label, async () => {
        const parent = await figma.getNodeByIdAsync(id);
        return parent ? await inspect(parent, expectedNodes) : { found: false };
      });
    }
    observation.dialectReadAfter = await capture("flcm.get host", () => flcm.get(flcm.id(entry.resident.node.id)));
    observation.expectedAfterSuccessfulMove = { sourceChildren: 0, destinationChildren: 1,
      subjectType: "INSTANCE", text: "SLOT SENTINEL", subjectTreeNodes: 3 };
  }
} catch (error) {
  report.status = phase === "setup" ? "setup_failed" : "scenario_incomplete";
  report.failure = { phase, error: errorText(error) };
}
// A returned object is evidence, never an implicit pass. Review coverage and operation outcomes.
return report;
