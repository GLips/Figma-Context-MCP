/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "06-sizing-layout", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
let phase = "setup";
const check = (condition, message) => { if (!condition) throw new Error("Fixture: " + message); };
const message = (error) => String(error && error.message ? error.message : error);
async function capture(label, action) {
  try { const value = await action(); return { label, outcome: "returned", value: JSON.parse(JSON.stringify(value === undefined ? null : value)) }; }
  catch (error) { return { label, outcome: "threw", error: message(error) }; }
}
async function live(id) { const node = await figma.getNodeByIdAsync(id); check(node !== null, "Missing " + id); return node; }
async function snapshot(node) {
  const values = {};
  for (const field of ["id", "type", "name", "width", "height", "x", "y", "layoutMode", "itemSpacing", "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "visible", "characters", "textAutoResize", "clipsContent", "componentPropertyReferences"]) {
    values[field] = await capture(field, () => node[field]);
  }
  values.fills = await capture("fills", () => "fills" in node ? node.fills : null);
  values.children = await capture("children", () => "children" in node ? node.children.map(child => ({ id: child.id, name: child.name, type: child.type, x: child.x, y: child.y, width: child.width, height: child.height })) : []);
  return values;
}
function shot(key, node, expectedVisualCheck) { report.screenshotTargets.push({ key, nodeId: node.id, expectedVisualCheck }); }
try {
  const previousPageId = figma.currentPage.id;
  const page = figma.createPage(); page.name = "FLCM scenario / " + "06-sizing-layout" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  // Native board setup keeps fixture staging separate from the flcm operations under test.
  const board = figma.createFrame(); board.name = "Sizing observations"; board.resize(1500, 350);
  board.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  async function panel(name, x, y, width = 470, height = 330) {
    const result = await flcm.append(flcm.id(board.id), flcm.frame({ name, left: x, top: y, width, height, fill: "#F1F5F9", clip: false }, [
      flcm.text(name, { left: 12, top: 8 }),
    ])); return await live(result.node.id);
  }
  const masterResult = await flcm.component(flcm.frame({ name: "Row master", left: 1700, top: 0, width: 280, height: 100,
    layout: { mode: "row", gap: 12, padding: 8 }, fill: "#FFFFFF" }, [
    flcm.rect({ name: "Red", width: 40, height: 40, fill: "#F04A5C" }),
    flcm.rect({ name: "Blue", width: 40, height: 40, fill: "#4477EE" }),
    flcm.text("Row", { name: "Master label" }),
  ]), { name: "Fixture / row master" });
  const master = await live(masterResult.node.id);
  check(master.layoutMode === "HORIZONTAL" && master.children[0].width === 40, "Row master layout");
  report.setup = { verified: true, masterId: master.id }; phase = "layout observations"; report.status = "observations_recorded";
  for (const [index, kind] of ["raw", "flcm"].entries()) {
    const parent = await panel(kind + " instance direction", index * 500, 0);
    const result = await flcm.append(flcm.id(parent.id), flcm.instance(master.id, { left: 12, top: 50 }));
    const node = await live(result.node.id); const before = await snapshot(node);
    const operation = await capture("set column and gap 6", async () => {
      if (kind === "raw") { node.layoutMode = "VERTICAL"; node.itemSpacing = 6; }
      else return await flcm.edit(flcm.id(node.id), { layout: { mode: "column", gap: 6 } });
    });
    report.observations.push({ item: 5, kind, before, operation, after: await snapshot(node) });
  }
  const subPanel = await panel("Instance sublayer resize/style", 1000, 0);
  for (const [index, kind] of ["raw", "flcm"].entries()) {
    const result = await flcm.append(flcm.id(subPanel.id), flcm.instance(master.id, { left: 12, top: 50 + index * 125 }));
    const node = (await live(result.node.id)).children[0];
    check(node.width === 40 && node.height === 40, "Sublayer starts at 40 square");
    const before = await snapshot(node);
    const operation = await capture("resize/style", async () => {
      if (kind === "raw") { node.resize(72, 72); node.fills = [{ type: "SOLID", color: { r: 0, g: 0.7, b: 0.3 } }]; }
      else return await flcm.edit(flcm.id(node.id), { width: 72, height: 72, fill: "#00B34D" });
    });
    const position = await capture("raw x = 20", () => { node.x = 20; });
    report.observations.push({ item: 6, kind, before, operation, position, after: await snapshot(node) });
  }
  shot("instance-layout-board", board, "Top row compares raw/flcm direction edits and sublayer resize/style outcomes with the returned before/after measurements.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
