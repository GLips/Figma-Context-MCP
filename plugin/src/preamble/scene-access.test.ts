import { test } from "node:test";
import assert from "node:assert/strict";
import { createSceneAccess } from "./scene-access.js";

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
    appendChild(node: unknown) { assert.equal(this, root); assert.equal(node, text); },
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
  root.appendChild(leaf);
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
  await assert.rejects(f.api.getNodeByIdAsync(f.textAlias.id), /complete indexed scene access/);
});


test("a prior page query does not enlarge a subsequent explicit target lookup", async () => {
  const f = fixture();
  const all = f.api.currentPage.findAll();
  assert.equal(all.length, 4);
  assert.equal(f.pageCalls, 1);
  f.invalidate();
  const [leaf, root] = await Promise.all([
    f.api.getNodeByIdAsync(f.textAlias.id), f.api.getNodeByIdAsync("400:1"),
  ]);
  assert.equal(f.pageCalls, 1);
  assert.equal(leaf, all[2]);
  assert.equal(root, all[0]);
  assert.equal((root as InstanceNode).findAll()[1], leaf);
  f.text.characters = "Raw mutation";
  f.invalidate();
  assert.equal((await f.api.getNodeByIdAsync(f.textAlias.id) as TextNode).characters, "Raw mutation");
  assert.equal(f.pageCalls, 1);
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
