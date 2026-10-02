/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Run live once on 2026-09-13; see README.md for scoped results and limitations.
// Async sandbox body; flcm and figma are supplied by execution.
// See README.md for source observations, interpretation, screenshots, and cleanup.
const report = {
  scenario: "08-operation-boundaries",
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
  page.name = "FLCM scenario / " + "08-operation-boundaries" + " / " + page.id;
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
  const host = await fixture.populated("Single slot append", [], 620, 0);
  report.setup = { verified: true, hostId: host.node.id, sourceId: host.source.id };
  screenshot("slot-host", host.node, "Source should contain a white frame with APPENDED and a magenta swatch after successful flcm.append; Destination remains empty.");
  phase = "slot append"; report.status = "observations_recorded";
  report.observations.push({ item: 13, before: await inspect(host.source, 1),
    operation: await capture("flcm.append SLOT", () => flcm.append(flcm.id(host.source.id),
      flcm.frame({ name: "Appended slot content", width: 200, height: 90, fill: "#FFFFFF", layout: { mode: "column", padding: 8, gap: 8 } }, [
        flcm.text("APPENDED"), flcm.rect({ width: 32, height: 16, fill: "#D000FF" }),
      ]))), after: await inspect(host.source, 4) });
  const marker = figma.createRectangle(); marker.name = "Before first edit"; marker.x = 1100; marker.resize(100, 100);
  const baseline = marker.name;
  const sequence = await capture("successful edit then rejected edit", async () => {
    await flcm.edit(flcm.id(marker.id), { name: "Earlier edit survived" });
    await flcm.edit(flcm.id(marker.id), { inventedUnknownProp: true });
    return { unexpectedCompletion: true };
  });
  report.observations.push({ item: 14, baseline, sequence, afterName: marker.name,
    interpretation: "A rejected later call does not imply earlier calls in this script rolled back. The second call is intentionally invalid caller input." });
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "scenario_incomplete"; report.failure = { phase, error: errorText(error) }; }
return report;
