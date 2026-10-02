/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "10-variant-contracts", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
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
  const page = figma.createPage(); page.name = "FLCM scenario / " + "10-variant-contracts" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  const board = figma.createFrame(); board.name = "Variant and component contracts"; board.resize(1500, 700);
  const place = (node, x, y) => { board.appendChild(node); node.x = x; node.y = y; };
  const base = await flcm.component(flcm.frame({ name: "Bound variant candidate", width: 200, height: 90, layout: { mode: "column", padding: 8, gap: 4 }, fill: "#FFF0E0" }, [
    flcm.text("Bound label", { componentPropertyReferences: { text: "Label" } }),
    flcm.rect({ width: 32, height: 16, fill: "#3B82F6", componentPropertyReferences: { visible: "Show" } }),
  ]), { name: "Fixture / variant candidate", propertyDefinitions: { Label: { type: "text" }, Show: { type: "boolean" } } });
  const baseNode = await live(base.node.id); place(baseNode, 20, 20);
  const sibling = baseNode.clone(); sibling.x = 260;
  const setResult = await flcm.variants([{ component: flcm.id(baseNode.id), variant: { Size: "Small" } },
    { component: flcm.id(sibling.id), variant: { Size: "Large" } }], { name: "Fixture / variant set" });
  const set = await live(setResult.id); check(set.type === "COMPONENT_SET" && set.children.length === 2, "Two-member variant set created");
  const refs = (node) => node.children.map(child => ({ name: child.name, refs: child.componentPropertyReferences }));
  const original = refs(baseNode); check(original.every(child => Object.keys(child.refs).length), "Both variant bindings before clone");
  report.setup = { verified: true, setId: set.id }; phase = "variant observations"; report.status = "observations_recorded";
  report.observations.push({ item: 29, variantsReturn: { id: setResult.id, type: setResult.type, hasNode: Object.prototype.hasOwnProperty.call(setResult, "node") } });
  const rawSame = baseNode.clone(); const rawSameRefs = refs(rawSame);
  const rawOut = baseNode.clone(); place(rawOut, 20, 260);
  const clone = await capture("flcm.clone variant to board", () => flcm.clone(flcm.id(baseNode.id), flcm.id(board.id)));
  const observation = { item: 9, original, rawCloneBeforeExplicitReparent: rawSameRefs, rawMovedOut: refs(rawOut), dialectClone: clone };
  if (clone.outcome === "returned") { const node = await live(clone.value.node.id); place(node, 260, 260); observation.flcmMovedOut = refs(node); }
  report.observations.push(observation);
  const fresh = await flcm.component(flcm.frame({ width: 200, height: 90 }, [flcm.text("New member")]), { name: "Fixture / new member" });
  place(await live(fresh.node.id), 500, 260);
  const memberCount = set.children.length;
  const extension = await capture("reuse a set member in variants", () => flcm.variants([
    { component: flcm.id(baseNode.id), variant: { Size: "Small" } },
    { component: fresh.node, variant: { Size: "Medium" } },
  ], { name: "Attempted extension" }));
  report.observations.push({ item: 25, extension, existingMemberCountBefore: memberCount, existingMemberCountAfter: set.children.length });
  const instance = await capture("instance spacing without restating mode", () => flcm.append(flcm.id(board.id), flcm.instance(baseNode.id, {
    left: 20, top: 450, layout: { gap: 22, padding: 8 },
  })));
  report.observations.push({ item: 26, masterMode: baseNode.layoutMode, operation: instance,
    after: instance.outcome === "returned" ? await snapshot(await live(instance.value.node.id)) : null });
  shot("variant-board", board, "Compare the variant members and copies outside the set. Binding metadata determines preservation; visible default labels alone cannot prove bindings survived.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
