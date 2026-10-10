/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Run live once on 2026-09-13. See README.md for observed results and limitations.
// See README.md for source observations, interpretation, screenshots, and cleanup.
const report = {
  scenario: "03-clone-geometry",
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
  page.name = "FLCM scenario / " + "03-clone-geometry" + " / " + page.id;
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
    const node = await nodeById(result.id, "INSTANCE");
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
  const resident = await fixture.populated("Clone geometry / live host", [
    flcm.frame({ key: "wrap", name: "Wrapped grid", width: 1170, height: 176,
      layout: { mode: "row", gap: 12 }, fill: "#FFFFFF" },
      [0, 1, 2, 3].map((index) => flcm.instance(fixture.item.node.id,
        { name: "Grid tile " + index, width: 144, height: 80 }))),
  ], 620, 0);
  const grid = resident.source.children[0];
  requireFixture(grid.type === "FRAME" && grid.id === resident.result.keyed.wrap.id,
    "Returned wrap key must identify the donated frame");
  // Current dialect omits wrapping words. Use raw API for the fixture, then verify every write.
  await flcm.edit(flcm.id(resident.source.id), { layout: { padding: 0 } });
  requireFixture(resident.source.paddingLeft === 0 && resident.source.paddingRight === 0,
    "Source slot must provide the full 353px grid width");
  grid.layoutWrap = "WRAP";
  grid.counterAxisSpacing = 16;
  grid.resize(353, 176);
  requireFixture(grid.layoutMode === "HORIZONTAL" && grid.layoutWrap === "WRAP" &&
    grid.counterAxisSpacing === 16 && grid.width === 353 && grid.children.length === 4,
    "Wrapped geometry fixture was not applied");
  for (const child of grid.children) requireFixture(child.type === "INSTANCE" && child.width === 144,
    "Each grid tile must be a 144px instance");
  const positions = grid.children.map((child) => ({ x: child.x, y: child.y }));
  requireFixture(Math.abs(positions[0].y - positions[1].y) < 0.5 &&
    Math.abs(positions[2].y - positions[3].y) < 0.5 && positions[2].y > positions[0].y &&
    Math.abs(positions[0].x - positions[2].x) < 0.5,
    "Live grid must actually wrap into two aligned rows before cloning");
  report.setup = { verified: true, hostId: resident.node.id, gridId: grid.id, positions,
    requestedGrid: { initialWidth: 1170, width: 353, layoutWrap: "WRAP", gap: 12, rowGap: 16, tileCount: 4, tileWidth: 144 } };
  screenshot("live-host", resident.node, "Four intact tiles in two rows of two. Check source-slot bounds and any clipping/overflow in the whole host.");
  phase = "clone observations";
  report.status = "observations_recorded";
  report.observations.push({ label: "live grid before cloning", audit: await inspect(grid, 13) });
  const liveId = grid.id;
  // Raw clone-out is the reported escape hatch; flcm.clone of the enclosing host is a second path.
  const rawCopy = await capture("raw grid clone to page", async () => {
    const copy = grid.clone();
    // Register immediately: a later placement failure must leave a cleanup/screenshot pointer.
    screenshot("raw-grid-clone", copy, "Compare row count, tile dimensions, text and spacing with the live grid. Detached page context may affect geometry.");
    fixture.page.appendChild(copy);
    copy.name = "Clone geometry / raw grid copy"; copy.x = 1060; copy.y = 0;
    return { id: copy.id, immediate: await inspect(copy, 13) };
  });
  report.observations.push(rawCopy);
  const hostCopy = await capture("flcm host clone", async () => {
    const result = await flcm.clone(flcm.id(resident.node.id));
    const copy = await nodeById(result.id, "INSTANCE");
    screenshot("host-clone", copy, "Compare intact host, slot bounds and wrapped grid with live-host; placement is the only intended visual difference.");
    copy.name = "Clone geometry / enclosing host copy"; copy.x = 1500; copy.y = 0;
    return { id: copy.id, immediate: await inspect(copy, 16) };
  });
  report.observations.push(hostCopy);
  // A second lookup is a separate sample, not proof that auto-layout has settled.
  for (const [label, id, expectedNodes] of [["live grid after clones", liveId, 13],
    ...(rawCopy.outcome === "read" ? [["raw clone second sample", rawCopy.value.id, 13]] : []),
    ...(hostCopy.outcome === "read" ? [["host clone second sample", hostCopy.value.id, 16]] : [])]) {
    report.observations.push(await capture(label, async () => {
      const node = await figma.getNodeByIdAsync(id);
      return node ? await inspect(node, expectedNodes) : { found: false };
    }));
  }
  // Compare only available measurements. Missing fields produce unavailable evidence.
  const liveAudit = report.observations[0].audit;
  report.geometryComparisons = [];
  for (const [label, sample, prefix] of [["raw grid clone", rawCopy, "root"],
    ["enclosing host clone", hostCopy, "root/0/0"]]) {
    if (sample.outcome !== "read") {
      report.geometryComparisons.push({ label, outcome: "unavailable", error: sample.error });
      continue;
    }
    for (const live of liveAudit.nodes) {
      const copyPath = prefix + live.path.slice(4);
      const copy = sample.value.immediate.nodes.find((entry) => entry.path === copyPath);
      const fields = {};
      for (const field of live.path === "root" ? ["width", "height"] : ["x", "y", "width", "height"]) {
        const a = live.fields && live.fields[field];
        const b = copy && copy.fields && copy.fields[field];
        fields[field] = a && b && a.outcome === "read" && b.outcome === "read" &&
          typeof a.value === "number" && typeof b.value === "number"
          ? { live: a.value, clone: b.value, delta: b.value - a.value,
              withinTolerance: Math.abs(b.value - a.value) <= 0.5 }
          : { outcome: "unavailable" };
      }
      report.geometryComparisons.push({ label, livePath: live.path, copyPath, fields });
    }
  }
  report.comparison = { method: "Compare matching relative paths in live-grid and raw-clone audits; host clone grid is root/0/0. Compare width/height and child-local x/y, not page offsets.",
    geometryTolerancePx: 0.5,
    conclusion: "Review required. Unreadable live geometry cannot be replaced with clone geometry. Clones and second samples do not establish settled layout." };
} catch (error) {
  report.status = phase === "setup" ? "setup_failed" : "scenario_incomplete";
  report.failure = { phase, error: errorText(error) };
}
// A returned object is evidence, never an implicit pass. Review coverage and operation outcomes.
return report;
