/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSceneAccess } from "./scene-access.js";
import type { FlcmError } from "./flcm-error.js";

function fixture() {
  const base = (id: string, type: string) => ({ id, type, parent: null as any, removed: false, name: type, getPluginData() { return ""; } });
  let pageCalls = 0;
  const page = { ...base("9:1", "PAGE"), children: [] as any[],
    findAll() { throw Error("legacy page traversal must not run"); },
    findAllWithCriteria() { pageCalls++; return [root, ...indexed]; },
  };
  const document = { ...base("0:0", "DOCUMENT"), children: [page], findAllWithCriteria() { throw Error("document must not scan"); } };
  page.parent = document;
  const stale = (id: string, type: string) => new Proxy(base(id, type), { get(target, key) {
    if (key === "id" || key === "type") return Reflect.get(target, key);
    if (key === "removed") return true;
    throw Error("stale native alias read: " + String(key));
  } });
  const textAlias = stale("I400:1;10:2", "TEXT");
  const hiddenAlias = stale("I400:1;10:3", "TEXT");
  const frameAlias = stale("I400:1;10:1", "FRAME");
  const text = { ...base("I400:1;20:1;10:2", "TEXT"), characters: "Preserved", visible: true, width: 80, fills: [] as unknown[],
    resize(width: number) { assert.equal(this, text); this.width = width; },
    setRangeFills(_start: number, _end: number, fills: unknown[]) { assert.equal(this, text); this.fills = fills; },
  };
  const hidden = { ...base("I400:1;20:1;10:3", "TEXT"), characters: "Hidden", visible: false };
  const inner = { ...base("I400:1;20:1;10:1", "FRAME"), children: [textAlias, hiddenAlias] };
  for (const node of [inner, text, hidden]) Object.defineProperty(node, "parent", { get() { throw Error("indexed parent resolves stale alias"); } });
  let calls = 0;
  let indexed: any[] = [inner, text, hidden];
  const root = { ...base("400:1", "INSTANCE"), parent: page, children: [frameAlias],
    findAll() { throw Error("legacy traversal must not run"); },
    findOne() { throw Error("legacy traversal must not run"); },
    findAllWithCriteria({ types }: { types: string[] }) { assert.deepEqual(types, []); calls++; return indexed; },
  };
  page.children.push(root);
  const native = { root: document, currentPage: page, skipInvisibleInstanceChildren: true,
    async getNodeByIdAsync(id: string) { return (id === "400:1" || id === root.id) ? root : id === page.id ? page : id === textAlias.id ? textAlias : null; },
    group(nodes: unknown[], parent: unknown) { assert.deepEqual(nodes, [[text]]); assert.equal(parent, root); return root; },
  };
  const access = createSceneAccess(() => native as unknown as PluginAPI);
  return { ...access, native, root, inner, text, hidden, textAlias, get calls() { return calls; }, get pageCalls() { return pageCalls; },
    deleteText() { inner.children.shift(); indexed = [inner, hidden]; access.invalidate(); },
  };
}

test("indexed acquisition preserves public identity, ordering, parents, hidden coverage and method receivers", async () => {
  const f = fixture();
  const root = await f.api.getNodeByIdAsync("400:1") as InstanceNode;
  const leaf = await f.api.getNodeByIdAsync(f.textAlias.id) as TextNode;
  assert.equal(leaf.id, f.textAlias.id);
  assert.equal(leaf.characters, "Preserved");
  assert.equal(leaf.parent, root.children[0]);
  assert.equal(root.children[0].parent, root);
  assert.equal(root.parent, f.api.currentPage);
  assert.deepEqual(root.findAll().map(n => n.id), ["I400:1;10:1", "I400:1;10:2", "I400:1;10:3"]);
  assert.equal(root.findOne(n => n.type === "TEXT" && n.visible), leaf);
  assert.equal(await f.api.getNodeByIdAsync(f.text.id), leaf);
  assert.equal(f.native.skipInvisibleInstanceChildren, true);
  assert.equal(leaf.resize, leaf.resize);
  leaf.resize(123, 20); leaf.characters = "Changed";
  leaf.setRangeFills(0, 2, [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]);
  assert.equal(f.text.width, 123); assert.equal(f.text.characters, "Changed"); assert.equal(f.text.fills.length, 1);
  (f.api.group as any)([[leaf]], root);
  assert.equal(await f.api.getNodeByIdAsync(f.textAlias.id), leaf);
  assert.equal(leaf.characters, "Changed");
  assert.ok(Object.keys(leaf).includes("characters"));
  assert.equal(Object.getOwnPropertyDescriptor(leaf, "characters")?.value, "Changed");
});

test("current scope membership distinguishes deleted aliases from stale native handles", async () => {
  const f = fixture();
  const leaf = await f.api.getNodeByIdAsync(f.textAlias.id);
  f.deleteText();
  assert.equal(await f.api.getNodeByIdAsync(f.textAlias.id), null);
  assert.equal(leaf!.removed, true);
  assert.equal((await f.api.getNodeByIdAsync("400:1") as InstanceNode).findAll().length, 2);
});

test("page and document anchors enumerate without acquiring descendants", () => {
  const f = fixture();
  assert.deepEqual(f.api.root.children.map(n => n.id), ["9:1"]);
  assert.deepEqual(f.api.currentPage.children.map(n => n.id), ["400:1"]);
  assert.equal(f.calls, 0);
});

test("incomplete indexed coverage fails before publishing a partial traversal", async () => {
  const f = fixture();
  f.root.findAllWithCriteria = () => [f.inner];
  await assert.rejects(f.api.getNodeByIdAsync(f.textAlias.id), (err: FlcmError) => err.kind === "figma" && err.node?.type === "INSTANCE" && /left out layers/.test(err.reason));
});


test("a prior page query does not enlarge a subsequent explicit target lookup", async () => {
  const f = fixture();
  const all = f.api.currentPage.findAll();
  assert.equal(all.length, 4);
  // Pages list native children; only the instance below is indexed.
  assert.equal(f.pageCalls, 0);
  f.invalidate();
  const [leaf, root] = await Promise.all([
    f.api.getNodeByIdAsync(f.textAlias.id), f.api.getNodeByIdAsync("400:1"),
  ]);
  assert.equal(f.pageCalls, 0);
  assert.equal(leaf, all[2]);
  assert.equal(root, all[0]);
  assert.equal((root as InstanceNode).findAll()[1], leaf);
  f.text.characters = "Raw mutation";
  f.invalidate();
  assert.equal((await f.api.getNodeByIdAsync(f.textAlias.id) as TextNode).characters, "Raw mutation");
  assert.equal(f.pageCalls, 0);
});


test("an old compound handle follows its native instance anchor after reopen remaps the root ID", async () => {
  const f = fixture();
  f.root.id = "I900:1;20:1";
  f.inner.id = "I900:1;20:1;10:1";
  f.text.id = "I900:1;20:1;10:2";
  f.hidden.id = "I900:1;20:1;10:3";
  f.root.children = [f.inner as any];
  f.inner.children = [f.text as any, f.hidden as any];
  const leaf = await f.api.getNodeByIdAsync("I400:1;10:2") as TextNode;
  assert.equal(leaf.id, f.text.id);
  assert.equal(leaf.characters, "Preserved");
  assert.equal(f.pageCalls, 0);
});


for (const method of ["appendChild", "insertChild"] as const) test(method + " refreshes a remapped root and retained children before subsequent writes", async () => {
  const base = (id: string, type: string) => ({ id, type, removed: false, parent: null as any, getPluginData() { return ""; } });
  const page: any = { ...base("1:1", "PAGE"), children: [] };
  const host: any = { ...base("2:1", "INSTANCE"), parent: page, children: [] };
  const slot: any = { ...base("I2:1;3:1", "SLOT"), parent: host, children: [] };
  const leaf: any = { ...base("I4:1;5:1", "TEXT"), characters: "Kept" };
  const stable: any = { ...base("4:1", "INSTANCE"), parent: slot, children: [leaf], layoutGrow: 0,
    findAllWithCriteria() { return [leaf]; } };
  leaf.parent = stable;
  let retired = false;
  const indexed: any = { ...stable, id: "I2:1;3:1;6:1" };
  Object.defineProperty(indexed, "layoutGrow", { get() { if (retired) throw Error("retired native root"); return 0; }, set() { throw Error("write used retired native root"); } });
  const oldLeaf: any = { ...leaf, id: "I2:1;3:1;6:1;5:1" };
  Object.defineProperty(oldLeaf, "characters", { get() { if (retired) throw Error("retired native child"); return "Kept"; }, set() { throw Error("write used retired native child"); } });
  host.children = [slot];slot.children = [stable];
  host.findAllWithCriteria = () => slot.children.length ? [slot,indexed,oldLeaf] : [slot];
  const destination: any = { ...base("7:1", "FRAME"), parent: page, children: [],
    findAllWithCriteria() { throw Error("transport must not scan the destination subtree"); },
    appendChild(node: any) { assert.equal(node,indexed);retired=true;slot.children=[];this.children=[stable];stable.parent=this; },
    insertChild(index: number,node: any) { assert.equal(index,0);this.appendChild(node); },
  };
  page.children=[host,destination];
  const native: any = { currentPage: page, skipInvisibleInstanceChildren:false, async getNodeByIdAsync(id: string) { return id===host.id?host:id===destination.id?destination:null; } };
  const { api } = createSceneAccess(()=>native);
  const root = await api.getNodeByIdAsync(indexed.id) as InstanceNode;
  const child = root.children[0] as TextNode;
  const dest = await api.getNodeByIdAsync(destination.id) as FrameNode;
  if(method==="appendChild")dest.appendChild(root);else dest.insertChild(0,root);
  root.layoutGrow=1;child.characters="After transport";
  assert.equal(stable.layoutGrow,1);assert.equal(leaf.characters,"After transport");
  assert.equal(root.id,"4:1");assert.equal(root.parent,dest);assert.equal(root.children[0],child);
});

test("inherited slot content moved to a sibling slot reads as Figma's copy, with earlier handles and its old id following it", async () => {
  const base = (id: string, type: string) => ({ id, type, removed: false, parent: null as any, getPluginData() { return ""; } });
  const page: any = { ...base("1:1", "PAGE"), children: [] };
  const outer: any = { ...base("10:1", "INSTANCE"), parent: page };
  const host: any = { ...base("I10:1;11:1", "INSTANCE"), parent: outer };
  const source: any = { ...base("I10:1;11:1;12:1", "SLOT"), parent: host };
  const destination: any = { ...base("I10:1;11:1;12:2", "SLOT"), parent: host, children: [] };
  const tile: any = { ...base("I10:1;11:1;13:1", "INSTANCE"), parent: source, layoutGrow: 0 };
  const label: any = { ...base("I10:1;11:1;13:1;20:1", "TEXT"), parent: tile, characters: "Original" };
  tile.children = [label];
  // Figma's child lists keep naming the original and its descendants, and every read of them throws.
  const dead = (id: string, type: string, children?: unknown[]) => new Proxy({ ...base(id, type), ...(children ? { children } : {}) }, { get(target, key) {
    if (key === "id" || key === "type" || key === "children") return Reflect.get(target, key);
    throw Error("retired native node: " + String(key));
  } });
  const copyLabel: any = { ...base("I10:1;11:1;12:2;14:1;20:1", "TEXT"), characters: "Copied" };
  const copy: any = { ...base("I10:1;11:1;12:2;14:1", "INSTANCE"), parent: destination, layoutGrow: 0, children: [dead(label.id, "TEXT")] };
  outer.children = [host]; host.children = [source, destination]; source.children = [tile];
  outer.findAllWithCriteria = () => [host, source, ...source.children.flatMap((n: any) => [n, ...n.children]), destination, ...(destination.children.length ? [copy, copyLabel] : [])];
  destination.findAllWithCriteria = () => destination.children.length ? [copy, copyLabel] : [];
  destination.appendChild = (node: any) => { assert.equal(node, tile); source.children = []; destination.children = [dead(tile.id, "INSTANCE", copy.children)]; };
  page.children = [outer];
  const native: any = { currentPage: page, skipInvisibleInstanceChildren: false,
    async getNodeByIdAsync(id: string) { return id === outer.id ? outer : null; } };
  const { api } = createSceneAccess(() => native);
  const moved = await api.getNodeByIdAsync(tile.id) as InstanceNode;
  const text = moved.children[0] as TextNode;
  const slot = await api.getNodeByIdAsync(destination.id) as SlotNode;
  slot.appendChild(moved);
  assert.equal(moved.id, copy.id);
  assert.equal(moved.children[0], text);
  assert.equal(text.id, copyLabel.id);
  assert.equal(text.characters, "Copied");
  moved.layoutGrow = 1;
  assert.equal(copy.layoutGrow, 1);
  assert.equal(moved.parent, slot);
  assert.equal((await api.getNodeByIdAsync(copy.id))?.id, copy.id);
  assert.equal((await api.getNodeByIdAsync(tile.id))?.id, copy.id);
});

test("a layer with its own id inside content copied to a sibling slot reads under the copy's path id, and its old id follows it", async () => {
  const base = (id: string, type: string) => ({ id, type, removed: false, parent: null as any, getPluginData() { return ""; } });
  const page: any = { ...base("1:1", "PAGE"), children: [] };
  const outer: any = { ...base("10:1", "INSTANCE"), parent: page };
  const source: any = { ...base("I10:1;12:1", "SLOT"), parent: outer };
  const destination: any = { ...base("I10:1;12:2", "SLOT"), parent: outer, children: [] };
  const tile: any = { ...base("I10:1;12:1;13:1", "INSTANCE"), parent: source };
  const star: any = { ...base("30:1", "STAR"), parent: tile };
  tile.children = [star];
  // Live (2026-10-26): the copy's child list still names the star by its plain id, which Figma no
  // longer resolves; the search lists it under the copy's path.
  const copyStar: any = { ...base("I10:1;12:2;14:1;30:2", "STAR") };
  const copy: any = { ...base("I10:1;12:2;14:1", "INSTANCE"), parent: destination, children: [{ ...base(star.id, "STAR") }] };
  outer.children = [source, destination]; source.children = [tile];
  outer.findAllWithCriteria = () => [source, ...source.children.flatMap((n: any) => [n, ...n.children]), destination, ...(destination.children.length ? [copy, copyStar] : [])];
  destination.findAllWithCriteria = () => destination.children.length ? [copy, copyStar] : [];
  destination.appendChild = (node: any) => { assert.equal(node, tile); source.children = []; destination.children = [{ ...base(tile.id, "INSTANCE"), children: copy.children }]; };
  page.children = [outer];
  const native: any = { currentPage: page, skipInvisibleInstanceChildren: false,
    async getNodeByIdAsync(id: string) { if (id === outer.id) return outer; throw Error("asked Figma about " + id); } };
  const { api } = createSceneAccess(() => native);
  const moved = await api.getNodeByIdAsync(tile.id) as InstanceNode;
  const held = moved.children[0];
  (await api.getNodeByIdAsync(destination.id) as SlotNode).appendChild(moved);
  assert.equal(held.id, copyStar.id);
  assert.equal(moved.children[0].id, copyStar.id);
  assert.equal((await api.getNodeByIdAsync(star.id))?.id, copyStar.id);
});

test("inherited slot content Figma re-paths into a sibling slot reads under its new path, and its old id follows it", async () => {
  const base = (id: string, type: string) => ({ id, type, removed: false, parent: null as any, name: type, getPluginData() { return ""; } });
  const page: any = { ...base("1:1", "PAGE"), children: [] };
  const outer: any = { ...base("10:1", "INSTANCE"), parent: page };
  const source: any = { ...base("I10:1;12:1", "SLOT"), parent: outer };
  const destination: any = { ...base("I10:1;12:2", "SLOT"), parent: outer, children: [] };
  const tile: any = { ...base("I10:1;12:1;13:1", "INSTANCE"), parent: source, children: [] };
  // Live (2026-10-26): same guid on the destination's path, and the entry left behind can't be read.
  const repathed: any = { ...base("I10:1;12:2;13:1", "INSTANCE"), parent: destination, children: [] };
  const dead = new Proxy({ ...base(tile.id, "INSTANCE"), children: [] }, { get(target, key) {
    if (key === "id" || key === "type" || key === "children") return Reflect.get(target, key);
    throw Error("in get_" + String(key) + ": the node does not exist");
  } });
  outer.children = [source, destination]; source.children = [tile];
  outer.findAllWithCriteria = () => [source, ...source.children, destination, ...(destination.children.length ? [repathed] : [])];
  destination.findAllWithCriteria = () => destination.children.length ? [repathed] : [];
  destination.appendChild = (node: any) => { assert.equal(node, tile); source.children = []; destination.children = [dead]; };
  page.children = [outer];
  const native: any = { currentPage: page, skipInvisibleInstanceChildren: false,
    async getNodeByIdAsync(id: string) { if (id === outer.id) return outer; throw Error("asked Figma about " + id); } };
  const { api } = createSceneAccess(() => native);
  const moved = await api.getNodeByIdAsync(tile.id) as InstanceNode;
  (await api.getNodeByIdAsync(destination.id) as SlotNode).appendChild(moved);
  assert.equal(moved.id, repathed.id);
  assert.equal((await api.getNodeByIdAsync(tile.id))?.id, repathed.id);
});

test("a layer Figma re-paths back to its first slot reads under its first id again", async () => {
  const base = (id: string, type: string) => ({ id, type, removed: false, parent: null as any, name: type, getPluginData() { return ""; } });
  const page: any = { ...base("1:1", "PAGE"), children: [] };
  const outer: any = { ...base("10:1", "INSTANCE"), parent: page };
  const left: any = { ...base("I10:1;12:1", "SLOT"), parent: outer, children: [] };
  const right: any = { ...base("I10:1;12:2", "SLOT"), parent: outer, children: [] };
  // Live (2026-10-26): each move re-paths the same guid, and the child list keeps the id it had.
  const at = (slot: any) => ({ ...base(slot.id + ";13:1", "RECTANGLE"), parent: slot });
  let where = left;
  const listed = { ...base("I10:1;12:1;13:1", "RECTANGLE") };
  outer.children = [left, right]; left.children = [listed];
  outer.findAllWithCriteria = () => [left, ...(where === left ? [at(left)] : []), right, ...(where === right ? [at(right)] : [])];
  for (const slot of [left, right]) {
    slot.findAllWithCriteria = () => where === slot ? [at(slot)] : [];
    slot.appendChild = () => { (where === left ? left : right).children = []; where = slot; slot.children = [listed]; };
  }
  page.children = [outer];
  const native: any = { currentPage: page, skipInvisibleInstanceChildren: false,
    async getNodeByIdAsync(id: string) { if (id === outer.id) return outer; throw Error("asked Figma about " + id); } };
  const access = createSceneAccess(() => native);
  const node = await access.api.getNodeByIdAsync(listed.id) as RectangleNode;
  (await access.api.getNodeByIdAsync(right.id) as SlotNode).appendChild(node);
  access.settleMovedIds(true);
  assert.equal(node.id, "I10:1;12:2;13:1");
  (await access.api.getNodeByIdAsync(left.id) as SlotNode).appendChild(node);
  access.settleMovedIds(true);
  assert.equal(node.id, "I10:1;12:1;13:1");
  assert.equal((await access.api.getNodeByIdAsync("I10:1;12:1;13:1"))?.id, "I10:1;12:1;13:1");
  assert.equal((await access.api.getNodeByIdAsync("I10:1;12:2;13:1"))?.id, "I10:1;12:1;13:1");
});
