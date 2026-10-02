/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "13-image-ref-reuse", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
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
  const page = figma.createPage(); page.name = "FLCM scenario / " + "13-image-ref-reuse" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  const board = figma.createFrame(); board.name = "Existing imageRef reuse"; board.resize(500, 180);
  const image = figma.createImage(figma.base64Decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAIAAAD4YuoOAAAAIklEQVR4nGNg2HKHJPT/EgNJiGHUglELRi0YtWDUgqFgAQCyWGEuTF7ltAAAAABJRU5ErkJggg=="));
  const source = figma.createRectangle(); board.appendChild(source); source.name = "Native source"; source.x = 20; source.y = 30; source.resize(64, 64);
  source.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FIT" }];
  check(source.fills[0].imageHash === image.hash, "Source uses known image");
  report.setup = { verified: true }; phase = "imageRef reuse"; report.status = "observations_recorded";
  const operation = await capture("render existing imageRef", () => flcm.append(flcm.id(board.id), flcm.frame({ name: "Dialect imageRef copy", left: 200, top: 30, width: 230, height: 120, layout: { mode: "column", gap: 8 } }, [
    flcm.rect({ key: "copy", name: "ImageRef copy", width: 64, height: 64, fill: { type: "IMAGE", imageRef: image.hash, scaleMode: "FIT" } }),
    flcm.text("Reused imageRef"),
  ])));
  const observation = { item: 24, operation, sourceFills: source.fills };
  if (operation.outcome === "returned") {
    const node = await live(operation.value.keyed.copy.id); observation.copyFills = node.fills;
    observation.sameImageHash = node.fills[0].imageHash === source.fills[0].imageHash;
  }
  report.observations.push(observation);
  shot("imageref-board", board, "Source and dialect copy should show the same cyan/yellow image with identical letterboxing. Compare actual image hashes in the report.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
