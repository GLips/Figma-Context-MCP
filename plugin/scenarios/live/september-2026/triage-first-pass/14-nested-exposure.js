/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "14-nested-exposure", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
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
  const page = figma.createPage(); page.name = "FLCM scenario / " + "14-nested-exposure" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  const board = figma.createFrame(); board.name = "Nested property exposure"; board.resize(650, 220);
  const result = await flcm.component(flcm.frame({ name: "Exposable component", width: 220, height: 90, fill: "#DBEAFE" }, [
    flcm.text("Exposable label", { left: 10, top: 10, componentPropertyReferences: { text: "Label" } }),
  ]), { name: "Fixture / exposable label", propertyDefinitions: { Label: { type: "text" } } });
  const component = await live(result.node.id);
  check(typeof component.children[0].componentPropertyReferences.characters === "string", "Bound property required for exposure");
  const parent = figma.createComponent(); parent.name = "Fixture / enclosing exposure parent"; parent.resize(280, 140); board.appendChild(parent); parent.x = 330; parent.y = 20;
  const outside = component.createInstance(); board.appendChild(outside); outside.x = 20; outside.y = 20;
  const inside = component.createInstance(); parent.appendChild(inside);
  report.setup = { verified: true, boundPropertyCount: Object.keys(component.componentPropertyDefinitions).length }; phase = "exposure"; report.status = "observations_recorded";
  report.observations.push({ item: 27,
    outside: await capture("expose outside component", () => { outside.isExposedInstance = true; return outside.isExposedInstance; }),
    inside: await capture("expose nested instance with bound property", () => { inside.isExposedInstance = true; return inside.isExposedInstance; }),
  });
  shot("exposure-board", board, "Two identical labels; successful nested exposure is established by metadata, not a pixel difference.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
