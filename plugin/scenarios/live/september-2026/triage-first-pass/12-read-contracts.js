/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "12-read-contracts", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
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
  const page = figma.createPage(); page.name = "FLCM scenario / " + "12-read-contracts" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  const board = figma.createFrame(); board.name = "Read and screenshot contracts"; board.resize(1100, 500);
  const place = (node, x, y) => { board.appendChild(node); node.x = x; node.y = y; };
  const source = await flcm.render(flcm.frame({ name: "Read-shape frame", width: 240, height: 100, fill: "#F1F5F9" }, [
    flcm.text("Child handle", { key: "child", name: "Child", left: 10, top: 10 }),
  ]));
  const frame = await live(source.node.id); place(frame, 20, 20); check(frame.children.length === 1, "Frame contains keyed text");
  report.setup = { verified: true }; phase = "read contracts"; report.status = "observations_recorded";
  const summarizeRead = (value) => ({ rootKeys: Object.keys(value.node), inlineChildren: Array.isArray(value.node.children) ? value.node.children.length : null,
    components: Object.values(value.components || {}).map(component => ({ type: component.type, name: component.name, childCount: Array.isArray(component.children) ? component.children.length : null })) });
  const frameRead = await capture("frame get", async () => summarizeRead(await flcm.get(flcm.id(frame.id))));
  const promoted = await flcm.component(flcm.id(frame.id), { name: "Fixture / read-shape component" });
  const component = await live(promoted.node.id);
  const componentRead = await capture("component get", async () => summarizeRead(await flcm.get(flcm.id(component.id))));
  report.observations.push({ item: 28, renderHandle: { keys: Object.keys(source.node), hasChildren: Object.prototype.hasOwnProperty.call(source.node, "children"), keyedNames: Object.keys(source.keyed) }, frameRead, componentRead });
  const outside = component.createInstance(); place(outside, 300, 20);
  const exposeOutside = await capture("expose outside component", () => { outside.isExposedInstance = true; return outside.isExposedInstance; });
  const enclosing = figma.createComponent(); enclosing.name = "Fixture / exposure parent"; enclosing.resize(260, 130); place(enclosing, 600, 20);
  const inside = component.createInstance(); enclosing.appendChild(inside);
  const exposeInside = await capture("expose inside component", () => { inside.isExposedInstance = true; return inside.isExposedInstance; });
  report.observations.push({ item: 27, exposeOutside, exposeInside });
  const rich = await flcm.render(flcm.text([["Large", { fontSize: 24 }], [" small", { fontSize: 12 }]], { name: "Mixed-size text" }));
  const mixed = await live(rich.node.id); place(mixed, 20, 200); check(mixed.fontSize === figma.mixed, "Mixed-size sentinel");
  report.observations.push({ item: 33, isMixed: mixed.fontSize === figma.mixed,
    naiveConcatenation: await capture("concatenate mixed value", () => "size=" + mixed.fontSize),
    naiveJson: await capture("JSON mixed value", () => JSON.stringify({ fontSize: mixed.fontSize })) });
  const contextResult = await flcm.render(flcm.frame({ name: "Screenshot context", width: 340, height: 130, fill: "#1E3A8A" }, [
    flcm.frame({ key: "transparent", name: "Transparent crop", width: 300, height: 90, left: 20, top: 20, fill: "none" }, [
      flcm.text("WHITE ON CONTEXT", { left: 10, top: 30, fill: "#FFFFFF" }),
    ]),
  ]));
  const context = await live(contextResult.node.id); place(context, 500, 200);
  const transparent = await live(contextResult.keyed.transparent.id); check(transparent.fills.length === 0, "Transparent child has no background paint");
  report.observations.push({ item: 19, childFills: transparent.fills, parentFills: context.fills, childId: transparent.id, parentId: context.id });
  shot("read-board", board, "Components and mixed-size text illustrate read contracts; blue context makes white text legible. Metadata determines exposure and handle behavior.");
  shot("transparent-child", transparent, "White text should export on transparency, without the blue parent's background; compare to read-board.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
