/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Run against the item 6 runtime. Every invocation owns a new isolated page.
// Return a unique caller-visible marker so a delayed reply from another run cannot pass validation.
const CASE = "direct-width";
const marker = "instance-dimensions-" + CASE + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
const page = figma.createPage();
page.name = "FLCM scenario / instance dimensions gate / " + page.id;
await figma.setCurrentPageAsync(page);
const master = figma.createComponent();
master.name = "Rectangle host";
master.layoutMode = "HORIZONTAL";
master.resize(240, 100);
master.primaryAxisSizingMode = "FIXED";
master.counterAxisSizingMode = "FIXED";
const rectangle = figma.createRectangle();
rectangle.resize(40, 40);
rectangle.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
master.appendChild(rectangle);
const host = master.createInstance();
host.y = 150;
const child = host.children[0];
const report = { marker, pageId: page.id, hostId: host.id, childId: child.id, observations: [] };
page.setPluginData("instance-dimensions-case", marker);
function snapshot() {
  return JSON.stringify({ masterName: master.name, root: [host.width, host.height, host.opacity], child: [child.width, child.height, child.fills], pageChildren: page.children.map(n => n.id) });
}
async function reject(label, action) {
  const before = snapshot();
  let error;
  try { await action(); } catch (e) { error = String(e.message || e); }
  const passed = !!error && error.includes("cannot resize an inherited rectangle") && before === snapshot();
  report.observations.push({ label, passed, error });
  if (!passed) throw new Error(label + " failed zero-write rejection");
}
try {
  if (CASE === "direct-width") await reject("direct width and fill", () => flcm.edit(flcm.id(child.id), { width: 72, fill: "#00ff00" }));
  if (CASE === "direct-height") await reject("direct height and fill", () => flcm.edit(flcm.id(child.id), { height: 72, fill: "#00ff00" }));
  if (CASE === "batch") await reject("batch", () => flcm.editMany([
    { target: flcm.id(master.id), changes: { name: "Changed" } },
    { target: flcm.id(child.id), changes: { width: 72, fill: "#00ff00" } },
  ]));
  if (CASE === "live-override") await reject("live override", () => flcm.edit(flcm.id(host.id), { opacity: 0.5, overrides: { [rectangle.id]: { width: 72 } } }));
  if (CASE === "creation-override") await reject("creation override", () => flcm.render(flcm.instance(master.id, { overrides: { [rectangle.id]: { width: 72 } } })));
  if (CASE === "root-resize") {
  await flcm.edit(flcm.id(host.id), { width: 300, height: 120 });
  report.observations.push({ label: "root resize", passed: host.width === 300 && host.height === 120, width: host.width, height: host.height });
  }
  if (CASE === "fill") {
  await flcm.edit(flcm.id(child.id), { width: "fill", fill: "#00ff00" });
  report.observations.push({ label: "fill", passed: child.layoutSizingHorizontal === "FILL" && child.width === host.width, width: child.width, sizing: child.layoutSizingHorizontal });
  }
  report.status = report.observations.every(o => o.passed) ? "passed" : "failed";
  report.screenshotNodeId = host.id;
} catch (e) { report.status = "failed"; report.error = String(e.message || e); }
return report;
