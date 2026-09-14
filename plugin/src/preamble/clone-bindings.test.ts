import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { clone } from "./structure.js";
import { id } from "./flcm.js";
let figma: any;
beforeEach(() => { figma = createFigmaMock(); });
function fixture() {
  const source = figma.createComponent();
  const text = figma.createText(); text.characters = "Default"; text.name = "duplicate";
  const visible = figma.createRectangle(); visible.name = "duplicate";
  source.appendChild(text); source.appendChild(visible);
  const set = figma.combineAsVariants([source], figma.currentPage);
  const t = set.addComponentProperty("Same", "TEXT", "Default");
  const b = set.addComponentProperty("Same", "BOOLEAN", true);
  text.componentPropertyReferences = { characters: t };
  visible.componentPropertyReferences = { visible: b };
  // Reproduce the native boundary observed live: member clone first lands on PAGE without refs.
  const nativeClone = source.clone.bind(source);
  source.clone = () => {
    const copy = nativeClone(); copy.componentPropertyDefinitions = {};
    for (const layer of copy.findAll()) layer.componentPropertyReferences = {};
    return copy;
  };
  return { source, set };
}
for (const context of ["same-set", "standalone", "different-set"]) {
  test("variant bindings survive " + context + " clone and control actual instance children", async () => {
    const { source, set } = fixture();
    const before = JSON.stringify(source.children.map(n => n.componentPropertyReferences));
    let destination = set;
    if (context === "standalone") destination = figma.currentPage;
    if (context === "different-set") {
      destination = figma.combineAsVariants([figma.createComponent()], figma.currentPage);
      destination.addComponentProperty("Same", "TEXT", "Unrelated");
    }
    const result = await clone(id(source.id), id(destination.id));
    const copy = await figma.getNodeByIdAsync(result.node.id);
    const owner = context === "standalone" ? copy : destination;
    const refs = copy.children.map(n => n.componentPropertyReferences);
    assert.notEqual(refs[0].characters, refs[1].visible);
    const instance = copy.createInstance();
    instance.setProperties({ [refs[0].characters]: "Changed", [refs[1].visible]: false });
    assert.equal(instance.children[0].characters, "Changed"); assert.equal(instance.children[1].visible, false);
    assert.equal(owner.componentPropertyDefinitions[refs[0].characters].defaultValue, "Default");
    assert.equal(JSON.stringify(source.children.map(n => n.componentPropertyReferences)), before);
    if (context === "different-set") assert.equal(Object.values(owner.componentPropertyDefinitions).filter((d: any) => d.type === "TEXT").length, 2);
  });
}
test("unsupported property definitions reject before native clone", async () => {
  const source = figma.createComponent(); figma.currentPage.appendChild(source); source.addComponentProperty("Content", "SLOT", "");
  let called = false; source.clone = () => { called = true; throw new Error("unexpected clone"); };
  await assert.rejects(clone(id(source.id)), /unsupported component property type SLOT/);
  assert.equal(called, false);
});
test("restoration refusal compensates its copy before sealing the failed span", async () => {
  const { source } = fixture();
  const destination = figma.combineAsVariants([figma.createComponent()], figma.currentPage);
  destination.addComponentProperty = () => { throw new Error("injected restoration refusal"); };
  figma.undoLog.length = 0;
  await assert.rejects(clone(id(source.id), id(destination.id)), /restoration refusal/);
  // Completed compensation seals its span without undoing the cleanup.
  assert.deepEqual(figma.undoLog, ["commit", "commit"]);
});

test("nested component owners retain independent controls and instance-swap references", async () => {
  const outer = figma.createComponent(); figma.currentPage.appendChild(outer);
  const inner = figma.createComponent(); outer.appendChild(inner);
  const label = figma.createText(); label.characters = "Inner"; inner.appendChild(label);
  const innerId = inner.addComponentProperty("Label", "TEXT", "Inner"); label.componentPropertyReferences = { characters: innerId };
  const a = figma.createComponent(); const b = figma.createComponent(); figma.currentPage.appendChild(a); figma.currentPage.appendChild(b);
  const nested = a.createInstance(); outer.appendChild(nested);
  const swapId = outer.addComponentProperty("Choice", "INSTANCE_SWAP", a.id); nested.componentPropertyReferences = { mainComponent: swapId };
  const copied = await clone(id(outer.id)); const root = await figma.getNodeByIdAsync(copied.node.id);
  const copiedInner = root.children[0]; const copiedLabelId = copiedInner.children[0].componentPropertyReferences.characters;
  const innerInstance = copiedInner.createInstance(); innerInstance.setProperties({ [copiedLabelId]: "Independent" });
  assert.equal(innerInstance.children[0].characters, "Independent");
  assert.equal(label.characters, "Inner");
  const instance = root.createInstance(); const copiedSwapId = root.children[1].componentPropertyReferences.mainComponent;
  instance.setProperties({ [copiedSwapId]: b.id });
  assert.equal(instance.children[1].mainComponent.id, b.id);
  assert.equal(nested.mainComponent.id, a.id);
});

test("same-set restoration does not reread definitions while the duplicate variant exists", async () => {
  const { source, set } = fixture();
  const definitions = set.componentPropertyDefinitions;
  Object.defineProperty(set, "componentPropertyDefinitions", { configurable: true, get() {
    if (set.children.length > 1) throw Error("Component set has existing errors");
    return definitions;
  } });
  const result = await clone(id(source.id), id(set.id));
  const copy = await figma.getNodeByIdAsync(result.node.id);
  assert.deepEqual(copy.children.map(n => n.componentPropertyReferences), source.children.map(n => n.componentPropertyReferences));
});

for (const preservesIdentity of [true, false]) test("native collision-adjusted binding names " + (preservesIdentity ? "retain identity" : "reject changed identity"), async () => {
  const { source } = fixture();
  const destination = figma.combineAsVariants([figma.createComponent()], figma.currentPage);
  const nativeClone = source.clone;
  source.clone = () => {
    const copy = nativeClone();
    for (const layer of copy.children) {
      let refs = {};
      Object.defineProperty(layer, "componentPropertyReferences", { configurable: true,
        get() { return refs; },
        set(value) { refs = Object.fromEntries(Object.entries(value).map(([field, property]: [string, any]) => [field, property.replace(/#[^#]*$/, (suffix: string) => "#display2" + suffix + (preservesIdentity ? "" : "-different"))])); },
      });
    }
    return copy;
  };
  if (!preservesIdentity) {
    const beforeChildren = destination.children.map(n => n.id);
    const beforeDefinitions = JSON.stringify(destination.componentPropertyDefinitions);
    await assert.rejects(clone(id(source.id), id(destination.id)), /native binding restoration did not persist/);
    assert.deepEqual(destination.children.map(n => n.id), beforeChildren);
    assert.equal(JSON.stringify(destination.componentPropertyDefinitions), beforeDefinitions);
    return;
  }
  const result = await clone(id(source.id), id(destination.id));
  const copy = await figma.getNodeByIdAsync(result.node.id);
  assert.ok(copy.children.every(n => Object.values(n.componentPropertyReferences).every((value: any) => value.includes("#display2#"))));
});

test("unknown native clone effects and incomplete compensation retain ordinary rollback", async () => {
  const { source } = fixture();
  source.clone = () => { throw Error("native clone refused before returning"); };
  figma.undoLog.length = 0;
  await assert.rejects(clone(id(source.id)), /native clone refused/);
  assert.deepEqual(figma.undoLog, ["commit", "commit", "trigger"]);
  const next = fixture();
  const destination = figma.combineAsVariants([figma.createComponent()], figma.currentPage);
  const add = destination.addComponentProperty.bind(destination);
  let count = 0;
  destination.addComponentProperty = (...args: any[]) => { if (++count > 1) throw Error("second definition refused"); return add(...args); };
  destination.deleteComponentProperty = () => { throw Error("cleanup refused"); };
  figma.undoLog.length = 0;
  await assert.rejects(clone(id(next.source.id), id(destination.id)), /second definition refused.*Cleanup also failed.*cleanup refused/);
  assert.deepEqual(figma.undoLog, ["commit", "commit", "trigger"]);
});
