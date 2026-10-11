/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Live acceptance for A-8: slot moves of direct vs inherited content, and reads surviving an
// unreadable node. Submit this whole file as one figma_execute_code body. Everything is built
// inside one wrapper frame, which is removed at the end. Never move inherited content to the
// page: that zombie cannot be removed through the plugin API.
const nm = (n) => { try { return n.name; } catch (e) { return null; } };
// Unreadable leftovers from earlier runs throw on x/width; place beside the readable content.
const right = (n) => { try { return n.x + n.width; } catch (e) { return 0; } };
const x0 = figma.currentPage.children.reduce((m, n) => Math.max(m, right(n)), 0) + 400;
const wrapper = figma.createFrame();
wrapper.name = "A08 acceptance";
wrapper.x = x0;
wrapper.resize(3000, 1400);
wrapper.fills = [];
const cases = [];
const record = (name, expected, check) => cases.push({ name, expected, ...check });

try {
  const tile = await flcm.component({ type: "FRAME", name: "Tile", width: 144, height: 80, fill: "#FFFFFF",
    layout: { mode: "column", gap: 8, padding: 8 }, children: [
      { type: "RECTANGLE", name: "Swatch", width: 32, height: 16, fill: "#D000FF" },
      { type: "TEXT", name: "Text", text: "SLOT SENTINEL" },
    ] });
  const slot = (name) => ({ type: "FRAME", name, width: 353, height: 140, layout: { mode: "column", padding: 8 },
    componentPropertyReferences: { slot: name } });
  const host = await flcm.component({ type: "FRAME", name: "Host", width: 393, height: 340,
    layout: { mode: "column", padding: 20, gap: 12 }, children: [slot("Source"), slot("Destination")] },
    { propertyDefinitions: { Source: { type: "slot" }, Destination: { type: "slot" } } });
  const [srcPath] = host.children.map((c) => c.id);
  const filled = { type: "INSTANCE", componentId: host.id,
    overrides: { [srcPath]: { children: [{ type: "INSTANCE", componentId: tile.id }] } } };
  const enclosing = await flcm.component({ type: "FRAME", name: "Enclosing", width: 433, height: 380,
    layout: { mode: "column", padding: 20 }, children: [filled] });
  for (const id of [tile.id, host.id, enclosing.id]) wrapper.appendChild(await figma.getNodeByIdAsync(id));

  // Builds one case: a host whose Source slot holds one tile, plus a plain frame destination.
  let column = 0;
  async function fixture(inherited) {
    const x = 600 + column++ * 450;
    const root = await flcm.append({ id: wrapper.id }, inherited
      ? { type: "INSTANCE", componentId: enclosing.id, left: x, top: 0 }
      : { ...filled, left: x, top: 0 });
    const frame = await flcm.append({ id: wrapper.id }, { type: "FRAME", left: x, top: 450, width: 393, height: 140,
      layout: { mode: "column", padding: 8 } });
    const live = await figma.getNodeByIdAsync(root.id);
    const [source, destination] = (inherited ? live.children[0] : live).children;
    return { source: source.id, destination: destination.id, frame: frame.id, subject: source.children[0].id };
  }
  async function readable(id) {
    try { const read = await flcm.get(flcm.id(id)); return read.node.type === "INSTANCE"; } catch (e) { return false; }
  }
  async function childCount(id) { return (await flcm.get(flcm.id(id))).node.children?.length ?? 0; }
  async function move(destination, subject) {
    try { return { returned: await flcm.append(flcm.id(destination), { id: subject }) }; }
    catch (e) { return { error: String(e.message || e) }; }
  }

  for (const [label, toFrame] of [["slot→slot", false], ["slot→frame", true]]) {
    const f = await fixture(false);
    const result = await move(toFrame ? f.frame : f.destination, f.subject);
    record("direct " + label, "moves; keeps its id; readable", {
      pass: !result.error && result.returned.id === f.subject && await readable(f.subject) && await childCount(f.source) === 0,
      detail: result.error ?? { returnedId: result.returned.id, original: f.subject },
    });
  }
  {
    const f = await fixture(true);
    const result = await move(f.destination, f.subject);
    const newId = result.returned?.id;
    record("inherited slot→slot", "moves; returns the copy's new id; old id stops resolving", {
      pass: !result.error && newId !== f.subject && await readable(newId) && !(await readable(f.subject)) &&
        await childCount(f.source) === 0 && await childCount(f.destination) === 1,
      detail: result.error ?? { returnedId: newId, original: f.subject },
    });
  }
  {
    const f = await fixture(true);
    const result = await move(f.frame, f.subject);
    record("inherited slot→frame", "refused by name before writing; source keeps the tile", {
      pass: /is inherited slot content/.test(result.error ?? "") && await childCount(f.source) === 1 && await childCount(f.frame) === 0,
      detail: result.error ?? { returnedId: result.returned.id },
    });
  }
  {
    // Raw code can still create the zombie; flcm reads must survive it and name it.
    const f = await fixture(true);
    const frame = await figma.getNodeByIdAsync(f.frame);
    frame.appendChild((await figma.getNodeByIdAsync(f.source)).children[0]);
    let found, error;
    try { found = await flcm.find({ within: { id: wrapper.id }, type: "INSTANCE" }); } catch (e) { error = String(e.message || e); }
    record("find beside an unreadable node", "returns without throwing", { pass: !error, detail: error ?? { hits: found.length } });
  }
} finally {
  wrapper.remove();
}
return { passed: cases.every((c) => c.pass), cases, wrapperRemoved: !figma.currentPage.children.some((n) => nm(n) === "A08 acceptance") };
