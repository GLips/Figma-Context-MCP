/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// One isolated overflow batch. Replace MARKER with a fresh UUID before submission.
const MARKER = "REPLACE-WITH-FRESH-UUID";
const page = figma.createPage(); page.name = "FLCM sizing / overflow / " + MARKER;
await figma.setCurrentPageAsync(page);
function container(name, x, clipped) {
  const node = figma.createFrame(); node.name = name; node.resize(120, 100); node.x = x; node.clipsContent = clipped;
  const child = figma.createRectangle(); child.resize(150, 20); node.appendChild(child); return node;
}
const clipped = container("Clipped", 0, true);
const unclipped = container("Unclipped", 200, false);
const nested = container("Nested", 0, false); unclipped.appendChild(nested); nested.resize(100, 70);
const unaffected = container("Unaffected", 400, false);
await flcm.editMany([
  { target: flcm.id(clipped.id), changes: { width: 90 } },
  { target: flcm.id(unclipped.id), changes: { width: 110 } },
  { target: flcm.id(nested.id), changes: { height: 60 } },
]);
page.setPluginData("sizing-marker", MARKER);
return { marker: MARKER, pageId: page.id, clippedIds: [clipped.id], unclippedIds: [unclipped.id, nested.id], unaffectedId: unaffected.id, status: "passed" };
