/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "11-responsive-queries", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
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
  const page = figma.createPage(); page.name = "FLCM scenario / " + "11-responsive-queries" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  const board = figma.createFrame(); board.name = "Responsive and query observations"; board.resize(1400, 760); board.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  const place = (node, x, y) => { board.appendChild(node); node.x = x; node.y = y; };
  const frame = await flcm.render(flcm.frame({ name: "Text flow fixture", width: 400, height: 190, clip: false,
    fill: "#DBEAFE", layout: { mode: "column", padding: 8, gap: 10 } }, [
    flcm.text("needle: a deliberately long sentence whose fixed width must be reconsidered when the containing frame narrows.", { key: "copy", width: 380, name: "Copy" }),
  ]));
  const parent = await live(frame.node.id); const text = await live(frame.keyed.copy.id); place(parent, 20, 20);
  check(text.width === 380, "Fixed-width text baseline");
  report.setup = { verified: true }; phase = "responsive and query observations"; report.status = "observations_recorded";
  const wide = parent.clone(); place(wide, 460, 20);
  const before = await snapshot(text); parent.resize(220, 190); const afterParentResize = await snapshot(text);
  const fillEdit = await capture("text width fill", () => flcm.edit(flcm.id(text.id), { width: "fill" }));
  report.observations.push({ item: 16, before, afterParentResize, fillEdit, afterFill: await snapshot(text), parent: await snapshot(parent) });
  const overlayResult = await flcm.render(flcm.frame({ name: "Free-form fixed overlay", width: 400, height: 170, fill: "#FEF3C7", clip: false }, [
    flcm.rect({ name: "Fixed overlay", left: 20, top: 30, width: 350, height: 60, fill: "#FCA5A5" }),
  ]));
  const overlay = await live(overlayResult.node.id); place(overlay, 20, 270); const overlayBefore = await snapshot(overlay.children[0]);
  overlay.resize(220, 170);
  report.observations.push({ item: 17, before: overlayBefore, after: await snapshot(overlay.children[0]), parent: await snapshot(overlay) });
  report.observations.push({ item: 30,
    textKey: await capture("find text key", () => flcm.find({ within: parent.id, text: "needle" })),
    rawWordPredicate: await capture("predicate characters", () => flcm.find({ within: parent.id, type: "TEXT" }, node => node.characters.includes("needle"))),
    readWordPredicate: await capture("predicate text", () => flcm.find({ within: parent.id, type: "TEXT" }, node => node.text.includes("needle"))),
    regexName: await capture("regex name", () => flcm.find({ within: parent.id, name: /Copy/ })),
    componentQuery: await capture("componentId query", () => flcm.find({ within: parent.id, componentId: "fixture-component" })),
  });
  report.observations.push({ item: 15,
    flexWrap: await capture("constructor flexWrap", () => flcm.frame({ layout: { mode: "row", flexWrap: "wrap" } })),
    rowGap: await capture("constructor rowGap", () => flcm.frame({ layout: { mode: "row", rowGap: 12 } })),
    minWidth: await capture("constructor minWidth", () => flcm.frame({ minWidth: 160 })),
  });
  report.observations.push({ item: 23, replaceType: typeof flcm.replace });
  report.observations.push({ item: 24, imageRef: await capture("imageRef fill", () => flcm.rect({ width: 20, height: 20, fill: { type: "IMAGE", imageRef: "fixture-ref", scaleMode: "FIT" } })) });
  report.observations.push({ item: 32, rawClipWord: await capture("clipsContent alias", () => flcm.frame({ clipsContent: false })),
    canonicalClipWord: await capture("clip", () => flcm.frame({ clip: false })) });
  const beforeLayout = { mode: parent.layoutMode, paddingLeft: parent.paddingLeft, paddingTop: parent.paddingTop, gap: parent.itemSpacing };
  const gapEdit = await capture("edit gap only", () => flcm.edit(flcm.id(parent.id), { layout: { gap: 22 } }));
  report.observations.push({ item: 35, before: beforeLayout, operation: gapEdit,
    after: { mode: parent.layoutMode, paddingLeft: parent.paddingLeft, paddingTop: parent.paddingTop, gap: parent.itemSpacing } });
  shot("responsive-board", board, "Left text wraps after explicit fill sizing; right control remains wide. Lower free-form overlay extends beyond its narrowed parent. Constructor/query errors are checked in JSON, not inferred from pixels.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
