/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. See README.md for source mapping and live status.
const report = { scenario: "09-sizing-constraints", status: "setup_pending", setup: { verified: false }, observations: [], screenshotTargets: [] };
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
  const page = figma.createPage(); page.name = "FLCM scenario / " + "09-sizing-constraints" + " / " + page.id;
  report.cleanup = { pageId: page.id, pageName: page.name, previousPageId, policy: "Retain exact run page and failure evidence. Never clean by prefix." };
  await figma.setCurrentPageAsync(page);
  check(figma.currentPage.id === page.id, "New run page not selected");
  // Native board setup keeps fixture staging separate from the flcm operations under test.
  const board = figma.createFrame(); board.name = "Sizing observations"; board.resize(1500, 1080);
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
  const minPanel = await panel("Per-instance minWidth", 0, 360);
  const minResult = await flcm.append(flcm.id(minPanel.id), flcm.instance(master.id, { left: 12, top: 50 }));
  const minNode = await live(minResult.node.id); minNode.minWidth = 160;
  check(minNode.minWidth === 160 && master.minWidth === null, "Only the instance has minWidth 160");
  const minBefore = await snapshot(minNode);
  const minResize = await capture("raw resize 145", () => minNode.resize(145, minNode.height));
  report.observations.push({ item: 7, before: minBefore, operation: minResize, after: await snapshot(minNode) });
  const clonePanel = await panel("FILL clone into free-form", 500, 360);
  const source = await flcm.append(flcm.id(clonePanel.id), flcm.frame({ name: "Source column", left: 10, top: 45, width: 180, height: 100, layout: { mode: "column" } }, [
    flcm.frame({ key: "fillSubject", name: "FILL subject", width: "fill", height: "fill", fill: "#FDBA74" }),
  ]));
  const fillNode = await live(source.keyed.fillSubject.id);
  const staging = await flcm.append(flcm.id(clonePanel.id), flcm.frame({ name: "Arbitrary staging bounds", left: 220, top: 45, width: 220, height: 250, fill: "#E2E8F0" }));
  check(fillNode.layoutSizingVertical === "FILL" && fillNode.height === 100, "FILL subject at 100px");
  const cloned = await capture("flcm.clone to staging", () => flcm.clone(flcm.id(fillNode.id), flcm.id(staging.node.id)));
  const cloneObs = { item: 8, before: await snapshot(fillNode), operation: cloned };
  if (cloned.outcome === "returned") {
    const node = await live(cloned.value.id); cloneObs.after = await snapshot(node);
    cloneObs.explicitSize = await capture("edit height 100", () => flcm.edit(flcm.id(node.id), { height: 100 }));
    cloneObs.afterExplicitSize = await snapshot(node);
  }
  report.observations.push(cloneObs);
  const collapsePanel = await panel("Narrow row with fixed sibling", 1000, 360);
  const rowResult = await flcm.append(flcm.id(collapsePanel.id), flcm.frame({ name: "Narrowing row", left: 10, top: 45, width: 440, height: 100, clip: false, layout: { mode: "row" } }, [
    flcm.rect({ key: "fixed", name: "Fixed 300", width: 300, height: 100, fill: "#FCA5A5" }),
    flcm.frame({ key: "fill", name: "Fill remainder", width: "fill", height: 100, fill: "#93C5FD" }),
  ]));
  const row = await live(rowResult.node.id); const remainder = await live(rowResult.keyed.fill.id);
  check(remainder.width === 140 && remainder.layoutSizingHorizontal === "FILL", "Row baseline has 140px fill");
  const collapseBefore = await snapshot(remainder);
  const narrow = await capture("raw row resize 220", () => row.resize(220, 100));
  report.observations.push({ item: 12, case: "fill collapse", before: collapseBefore, operation: narrow, after: await snapshot(remainder), row: await snapshot(row) });
  const overflowPanel = await panel("Fixed height overflow", 0, 720, 470, 330);
  const overResult = await flcm.append(flcm.id(overflowPanel.id), flcm.frame({ name: "Parent stacking", left: 10, top: 45, width: 400, height: 240, layout: { mode: "column" }, clip: false }, [
    flcm.frame({ key: "fixedHeight", name: "Fixed-height inner", width: 380, height: 60, clip: false, layout: { mode: "column", gap: 8 } }, [
      flcm.rect({ name: "First", width: 350, height: 55, fill: "#FCA5A5" }),
      flcm.rect({ name: "Overflowing", width: 350, height: 55, fill: "#93C5FD" }),
    ]),
    flcm.rect({ key: "next", name: "Next section", width: 380, height: 60, fill: "#86EFAC" }),
  ]));
  report.observations.push({ item: 12, case: "fixed height overflow", inner: await snapshot(await live(overResult.keyed.fixedHeight.id)), next: await snapshot(await live(overResult.keyed.next.id)) });
  shot("constraints-board", board, "Inspect the 160px minimum-width clamp, FILL clone sizing, collapsed remainder and fixed-height overlap against the numeric report.");
} catch (error) { report.status = phase === "setup" ? "setup_failed" : "incomplete"; report.failure = { phase, error: message(error) }; }
return report;
