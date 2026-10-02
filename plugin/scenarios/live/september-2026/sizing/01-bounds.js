/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// One independent case. Set CASE to "same-edit" or "instance-only" and replace MARKER with a UUID.
const CASE = "same-edit";
const MARKER = "REPLACE-WITH-FRESH-UUID";
const page = figma.createPage(); page.name = "FLCM sizing / " + CASE + " / " + MARKER;
await figma.setCurrentPageAsync(page);
const master = figma.createComponent(); master.layoutMode = "HORIZONTAL"; master.primaryAxisSizingMode = "FIXED"; master.counterAxisSizingMode = "FIXED"; master.resize(200, 60);
const node = CASE === "instance-only" ? master.createInstance() : figma.createFrame();
node.layoutMode = "HORIZONTAL"; node.primaryAxisSizingMode = "FIXED"; node.counterAxisSizingMode = "FIXED"; node.resize(200, 60); node.y = 150;
if (CASE === "instance-only") { node.minWidth = 160; node.maxHeight = 80; }
const result = await flcm.edit(flcm.id(node.id), {
  width: 145, height: 95,
  ...(CASE === "same-edit" ? { minWidth: 160, maxWidth: 240, minHeight: 40, maxHeight: 80 } : {}),
});
const bounded = { width: node.width, height: node.height, minWidth: node.minWidth, maxWidth: node.maxWidth, minHeight: node.minHeight, maxHeight: node.maxHeight };
const canonical = await flcm.get(flcm.id(node.id));
if (node.width !== 160 || node.height !== 80 || canonical.node.minWidth !== 160 || canonical.node.maxHeight !== 80) throw new Error("Bounds did not land or read back");
await flcm.edit(flcm.id(node.id), { minWidth: "none", maxWidth: "none", minHeight: "none", maxHeight: "none", width: 145, height: 95 });
const cleared = { width: node.width, height: node.height, minWidth: node.minWidth, maxWidth: node.maxWidth, minHeight: node.minHeight, maxHeight: node.maxHeight };
if (node.width !== 145 || node.height !== 95 || node.minWidth !== null || node.maxHeight !== null) throw new Error("Clear did not land");
page.setPluginData("sizing-marker", MARKER);
return { marker: MARKER, case: CASE, pageId: page.id, nodeId: node.id, masterId: master.id, result, bounded, cleared, status: "passed" };
