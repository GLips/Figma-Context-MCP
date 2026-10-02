/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body. Run with the CLI built from the direction-gate fix.
const page = figma.createPage();
page.name = "FLCM scenario / instance direction / " + page.id;
await figma.setCurrentPageAsync(page);
const report = { pageId: page.id, status: "running", observations: [], screenshotTargets: [] };
function component(name, mode, x) {
  const node = figma.createComponent(); node.name = name; node.x = x; node.layoutMode = mode;
  node.resize(240, 120); node.primaryAxisSizingMode = "FIXED"; node.counterAxisSizingMode = "FIXED";
  node.itemSpacing = 12;
  for (const color of [{ r: 1, g: 0.2, b: 0.3 }, { r: 0.2, g: 0.4, b: 1 }]) {
    const child = figma.createRectangle(); child.resize(40, 40); child.fills = [{ type: "SOLID", color }]; node.appendChild(child);
  }
  return node;
}
const row = component("Direction=Row", "HORIZONTAL", 0);
const column = component("Direction=Column", "VERTICAL", 300);
const set = figma.combineAsVariants([row, column], page); set.name = "Direction fixture";
let count = 0;
function stamp(master) { const node = master.createInstance(); node.x = count++ * 270; node.y = 350; return node; }
async function snapshot(node) {
  return { id: node.id, name: node.name, main: (await node.getMainComponentAsync()).id, mode: node.layoutMode,
    gap: node.itemSpacing, opacity: node.opacity, width: node.width, height: node.height,
    children: node.children.map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height })) };
}
async function reject(label, node, action, extras = []) {
  const before = await snapshot(node); const extraBefore = extras.map(n => n.name);
  let error = null; try { await action(); } catch (e) { error = String(e.message || e); }
  const after = await snapshot(node);
  const passed = !!error && error.includes("instance root inherits its layout direction") && JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(extraBefore) === JSON.stringify(extras.map(n => n.name));
  report.observations.push({ label, passed, error, before, after });
  if (!passed) throw new Error(label + " did not reject without writes");
}
try {
  const direct = stamp(row);
  await reject("edit column+gap+opacity", direct, () => flcm.edit(flcm.id(direct.id), { layout: { mode: "column", gap: 6 }, opacity: 0.5 }));
  await flcm.edit(flcm.id(direct.id), { layout: { mode: "row", gap: 6 } });
  report.observations.push({ label: "matching direction", passed: direct.layoutMode === "HORIZONTAL" && direct.itemSpacing === 6, after: await snapshot(direct) });
  const batch = stamp(row);
  await reject("batch zero writes", batch, () => flcm.editMany([
    { target: flcm.id(row.id), changes: { name: "Changed" } },
    { target: flcm.id(batch.id), changes: { layout: { mode: "column", gap: 6 }, opacity: 0.5 } },
  ]), [row]);
  for (const kind of ["swap", "variant"]) {
    const node = stamp(row);
    const changes = kind === "swap" ? { componentId: column.id } : { componentProperties: { Direction: "Column" } };
    await reject(kind + " rejects outgoing direction", node, () => flcm.edit(flcm.id(node.id), { ...changes, layout: { mode: "row", gap: 6 }, opacity: 0.5 }));
    await flcm.editMany([{ target: flcm.id(node.id), changes: { ...changes, layout: { mode: "column", gap: 6 } } }]);
    report.observations.push({ label: kind + " accepts incoming direction", passed: node.layoutMode === "VERTICAL" && node.itemSpacing === 6 && (await node.getMainComponentAsync()).id === column.id, after: await snapshot(node) });
  }
  const outer = figma.createComponent(); outer.name = "Nested fixture"; outer.x = 650;
  const nested = row.createInstance(); outer.appendChild(nested);
  const live = stamp(outer);
  await reject("live nested override", live, () => flcm.edit(flcm.id(live.id), { opacity: 0.5, overrides: { [nested.id]: { layout: { mode: "column", gap: 6 } } } }));
  const incoming = stamp(row);
  await reject("incoming nested override", incoming, () => flcm.edit(flcm.id(incoming.id), { componentId: outer.id, opacity: 0.5, overrides: { [nested.id]: { layout: { mode: "column", gap: 6 } } } }));
  report.status = report.observations.every(o => o.passed) ? "passed" : "failed";
  report.screenshotTargets.push({ key: "matching-row", nodeId: direct.id }, { key: "rejected-batch-row", nodeId: batch.id });
} catch (e) { report.status = "failed"; report.error = String(e.message || e); }
return report;
