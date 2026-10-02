/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Run live once on 2026-09-13. See README.md for observed results and limitations.
// Async sandbox body; flcm and figma are supplied by execution.
// See README.md for source observations, interpretation, screenshots, and cleanup.
const report = {
  scenario: "04-image-audit",
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
  page.name = "FLCM scenario / " + "04-image-audit" + " / " + page.id;
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

// The intentionally lossy conclusion is recorded alongside explicit skipped-node evidence.
// It is never used as this scenario's success criterion.
async function paintAudit(root, expectedNodes, expectedFit) {
  const entries = [];
  async function walk(node, path) {
    let fits = 0;
    try {
      const name = node.name;
      const fills = "fills" in node ? node.fills : [];
      requireFixture(Array.isArray(fills), "Mixed fills in this single-paint fixture");
      fits = fills.filter((paint) => paint.type === "IMAGE" && paint.scaleMode === "FIT").length;
      entries.push({ path, outcome: "read", name, fitCount: fits });
    } catch (error) {
      entries.push({ path, outcome: "skipped", error: errorText(error) });
    }
    // Continue enumeration separately, so one unreadable field cannot hide subtree loss.
    try {
      const count = "children" in node ? node.children.length : 0;
      for (let index = 0; index < count; index++) await walk(node.children[index], path + "/" + index);
    } catch (error) {
      entries.push({ path, outcome: "enumeration_failed", error: errorText(error) });
    }
  }
  await walk(root, "root");
  const fitCount = entries.reduce((sum, entry) => sum + (entry.fitCount || 0), 0);
  const skipped = entries.filter((entry) => entry.outcome !== "read");
  return { expectedNodes, expectedFit, visitedEntries: entries.length, fitCount,
    skippedCount: skipped.length, entries,
    lossyAuditWouldClaimZeroFit: fitCount === 0,
    coverageAwareConclusion: skipped.length || entries.length !== expectedNodes ? "incomplete" :
      fitCount === expectedFit ? "expected_fit_found" : "fit_count_mismatch" };
}
try {
  const fixture = await setup();
  const image = figma.createImage(figma.base64Decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAIAAAD4YuoOAAAAIklEQVR4nGNg2HKHJPT/EgNJiGHUglELRi0YtWDUgqFgAQCyWGEuTF7ltAAAAABJRU5ErkJggg=="));
  const master = await nodeById(fixture.item.node.id, "COMPONENT");
  master.resize(104, 92);
  const imageRect = master.children[0];
  imageRect.resize(48, 48);
  imageRect.name = "FIT image sentinel";
  imageRect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FIT" }];
  await flcm.edit(flcm.id(master.children[1].id), { text: "FIT" });
  requireFixture(imageRect.fills.length === 1 && imageRect.fills[0].type === "IMAGE" &&
    imageRect.fills[0].scaleMode === "FIT" && imageRect.fills[0].imageHash === image.hash,
    "Master must carry the known FIT image before instances are created");
  const hostMaster = await nodeById(fixture.host.node.id, "COMPONENT");
  hostMaster.resize(393, 500);
  for (const slot of hostMaster.children) {
    slot.resize(353, 220);
    slot.layoutMode = "HORIZONTAL";
    slot.layoutWrap = "WRAP";
    slot.itemSpacing = 8; slot.counterAxisSpacing = 8;
  }
  const fills = () => ({
    [fixture.paths.source]: { children: Array.from({ length: 6 }, (_, i) =>
      flcm.instance(fixture.item.node.id, { name: "Source tile " + i })) },
    [fixture.paths.destination]: { children: Array.from({ length: 6 }, (_, i) =>
      flcm.instance(fixture.item.node.id, { name: "Destination tile " + i })) },
  });
  const directResult = await flcm.render(flcm.instance(fixture.host.node.id, {
    name: "FIT audit / direct host", left: 620, top: 0, overrides: fills(),
  }));
  // Inherit filled slots through an enclosing component instance, as a composed section would.
  const enclosing = await flcm.component(flcm.frame({ name: "FIT audit / enclosing definition",
    left: 1060, top: 600, width: 393, height: 500 }, [
    flcm.instance(fixture.host.node.id, { name: "Nested filled host", overrides: fills() }),
  ]), { name: "Fixture / enclosing filled section" });
  const nestedResult = await flcm.render(flcm.instance(enclosing.node.id, {
    name: "FIT audit / nested host", left: 1060, top: 0,
  }));
  const controlResult = await flcm.render(flcm.frame({ name: "FIT audit / plain control", left: 1500,
    top: 0, width: 140, height: 130, fill: "#E0FFE0", layout: { mode: "column", padding: 8 } }, [
    flcm.instance(fixture.item.node.id, { key: "control", name: "Control FIT tile" }),
  ]));
  const direct = await nodeById(directResult.node.id, "INSTANCE");
  const nested = await nodeById(nestedResult.node.id, "INSTANCE");
  const control = await nodeById(controlResult.keyed.control.id, "INSTANCE");
  requireFixture(nested.children.length === 1 && nested.children[0].type === "INSTANCE",
    "Enclosing instance must contain the nested host");
  for (const host of [direct, nested.children[0]]) {
    requireFixture(host.children.length === 2, "Expected two slots in each host");
    for (const slot of host.children) {
      requireFixture(slot.type === "SLOT" && slot.children.length === 6,
        "Each slot must contain exactly six tiles before audit");
      for (const tile of slot.children) requireFixture(tile.type === "INSTANCE", "Expected donated tile instances");
    }
  }
  report.setup = { verified: true, directId: direct.id, nestedId: nested.id, controlId: control.id,
    imageDimensions: { width: 32, height: 16 }, expectedFitPerHost: 12, expectedControlFit: 1,
    expectedContent: "A cyan/yellow 2:1 image letterboxed inside each square with FIT underneath" };
  screenshot("direct-host", direct, "Twelve tiles in two slots, six per slot; each has a cyan/yellow band letterboxed in a square and FIT underneath.");
  screenshot("nested-host", nested, "Same twelve FIT tiles as direct-host, inside a composed section instance; no tile missing.");
  report.screenshotTargets.push({ key: "plain-control", nodeId: controlResult.node.id,
    expectedVisualCheck: "One tile matching the cyan/yellow FIT image and label of each slot tile." });
  phase = "image and sublayer audits before moves";
  report.status = "observations_recorded";
  for (const [label, node, count, fits] of [["plain control", control, 3, 1],
    ["direct filled host", direct, 39, 12], ["nested inherited filled host", nested, 40, 12]]) {
    report.observations.push({ label, readability: await inspect(node, count),
      paints: await paintAudit(node, count, fits),
      dialectRead: await capture("flcm.get", () => flcm.get(flcm.id(node.id))) });
  }
} catch (error) {
  report.status = phase === "setup" ? "setup_failed" : "scenario_incomplete";
  report.failure = { phase, error: errorText(error) };
}
return report;
