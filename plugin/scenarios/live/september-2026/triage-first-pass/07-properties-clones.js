/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "07-properties-clones", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
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
  const page = figma.createPage(); page.name = "FLCM scenario / " + "07-properties-clones" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  const board = figma.createFrame(); board.name = "Property and clone observations"; board.resize(1300, 550); board.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  const place = (node, x, y) => { board.appendChild(node); node.x = x; node.y = y; };
  const original = await flcm.render(flcm.frame({ name: "Original content", width: 260, height: 90, fill: "#F1F5F9" }, [
    flcm.text("Tattoo machines", { key: "title", name: "Title", left: 10, top: 10 }),
  ]));
  const originalId = original.node.id; const title = await live(original.keyed.title.id);
  check(title.characters === "Tattoo machines", "Original title content");
  report.setup = { verified: true }; phase = "property observations"; report.status = "observations_recorded";
  const beforePromotion = await snapshot(title);
  const promoted = await flcm.component(flcm.id(originalId), { name: "Fixture / invented default", propertyDefinitions: { Title: { type: "text", defaultValue: "Link 1" } } });
  const master = await live(promoted.node.id); place(master, 20, 30);
  const afterPromotion = await snapshot(title);
  const binding = await capture("bind Title", () => flcm.edit(flcm.id(title.id), { componentPropertyReferences: { text: "Title" } }));
  const afterBinding = await snapshot(title);
  const deletion = await capture("delete Title property", () => flcm.edit(flcm.id(master.id), { propertyDefinitions: { Title: null } }));
  report.observations.push({ item: 10, beforePromotion, afterPromotion, binding, afterBinding, deletion, afterDeletion: await snapshot(title),
    promotionIdentity: { originalId, returnedId: master.id, originalResolves: (await figma.getNodeByIdAsync(originalId)) !== null, childId: title.id } });
  const bound = await flcm.component(flcm.frame({ name: "Bound master", width: 240, height: 90, fill: "#FFF0E0" }, [
    flcm.text("Bound title", { name: "Bound text", left: 10, top: 10, componentPropertyReferences: { text: "Label" } }),
    flcm.rect({ name: "Bound visibility", left: 10, top: 40, width: 24, height: 24, fill: "#3B82F6", componentPropertyReferences: { visible: "Show" } }),
  ]), { name: "Fixture / bound component", propertyDefinitions: { Label: { type: "text" }, Show: { type: "boolean" } } });
  const boundNode = await live(bound.node.id); place(boundNode, 320, 30);
  const bindings = (node) => ({ definitions: node.componentPropertyDefinitions, children: node.children.map(child => ({ name: child.name, refs: child.componentPropertyReferences })) });
  const bindingBefore = bindings(boundNode); check(bindingBefore.children.every(child => Object.keys(child.refs).length === 1), "Both bindings exist before cloning");
  const rawClone = boundNode.clone(); place(rawClone, 590, 30);
  const dialectClone = await capture("flcm.clone bound component", () => flcm.clone(flcm.id(boundNode.id), flcm.id(board.id)));
  const cloneObservation = { item: 9, original: bindingBefore, rawClone: bindings(rawClone), dialectClone };
  if (dialectClone.outcome === "returned") { const node = await live(dialectClone.value.node.id); place(node, 860, 30); cloneObservation.flcmCloneBindings = bindings(node); }
  report.observations.push(cloneObservation);
  const rich = await flcm.component(flcm.frame({ name: "Rich price", width: 360, height: 100, fill: "#F1F5F9" }, [
    flcm.text([["$49.99", { fontSize: 24 }], ["  $149.99", { fontSize: 14, textDecoration: "line-through" }]], { key: "price", name: "Price", left: 10, top: 10 }),
  ]), { name: "Fixture / rich price", propertyDefinitions: { Price: { type: "text", defaultValue: "$49.99  $149.99" } } });
  const richNode = await live(rich.node.id); place(richNode, 20, 230); const price = await live(rich.keyed.price.id);
  const segments = (node) => node.getStyledTextSegments(["fontSize", "textDecoration"]);
  const beforeSegments = segments(price); check(beforeSegments.length === 2, "Two rich price runs before binding");
  const priceBinding = await capture("bind rich price", () => flcm.edit(flcm.id(price.id), { componentPropertyReferences: { text: "Price" } }));
  const richInstance = await flcm.append(flcm.id(board.id), flcm.instance(richNode.id, { left: 420, top: 230, componentProperties: { Price: "$39.99  $129.99" } }));
  const liveInstance = await live(richInstance.node.id);
  report.observations.push({ item: 11, beforeSegments, binding: priceBinding, masterAfterSegments: segments(price), instanceAfterSegments: segments(liveInstance.children[0]), instance: await snapshot(liveInstance.children[0]) });
  shot("property-board", board, "Top row compares invented-default title and original/raw/flcm cloned bound components. Bottom compares rich price master and instance property override; inspect price emphasis and strike styling against returned ranges.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
