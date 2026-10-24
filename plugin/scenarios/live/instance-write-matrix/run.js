/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Async production Figma body, raw Plugin API only: no flcm, so each row is Figma's own answer.
// Each row names the instance-write-policy.ts rule it is evidence for (null: an "allowed" verdict);
// probes are recorded, never asserted. The page is removed in `finally`, so a failed run leaves the
// file as it found it.
const original = figma.currentPage;
const page = figma.createPage();
page.name = "FLCM scenario / instance write matrix / " + page.id;
const report = { status: "running", rows: [], probes: [] };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const size = (n) => [Math.round(n.width), Math.round(n.height)];
function attempt(write) {
  try { write(); return { threw: false }; } catch (e) { return { threw: true, message: String((e && e.message) || e) }; }
}
function ignored(rule, layer, label, node, write, read) {
  const before = read(node); const r = attempt(() => write(node)); const after = read(node);
  const got = r.threw ? "throws" : same(before, after) ? "ignored" : "lands";
  report.rows.push({ rule, layer, label, expect: "ignored", got, passed: got === "ignored", before, after, message: r.message });
}
function throws(rule, layer, label, node, write, pattern) {
  const r = attempt(() => write(node));
  report.rows.push({ rule, layer, label, expect: "throws", got: r.threw ? "throws" : "lands",
    passed: r.threw && (!pattern || pattern.test(r.message)), message: r.message });
}
function lands(layer, label, node, write, read, expected) {
  const r = attempt(() => write(node)); const after = r.threw ? undefined : read(node);
  const ok = !r.threw && same(after, expected);
  report.rows.push({ rule: null, layer, label, expect: "lands", got: r.threw ? "throws" : ok ? "lands" : "ignored", passed: ok, after, message: r.message });
}
function probe(layer, label, node, write, read) {
  const before = read(node); const r = attempt(() => write(node)); const after = read(node);
  report.probes.push({ layer, label, got: r.threw ? "throws" : same(before, after) ? "unchanged" : "changed", before, after, message: r.message });
}
// Mirrors component-edit.ts declareSlotProperty: the API may leave a placeholder beside the hole.
function declareSlot(owner, name) {
  const ids = (n) => [n, ...n.findAll(() => true)].map((x) => x.id);
  const before = new Set(ids(owner));
  const full = owner.addComponentProperty(name, "SLOT", "");
  for (const n of owner.findAll(() => true)) if (!before.has(n.id) && n.parent && before.has(n.parent.id)) n.remove();
  return full;
}
try {
  // Inside the try: a rejected switch still reaches the `finally` that removes the page.
  await figma.setCurrentPageAsync(page);
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  const autoFrame = (name, mode, w, h) => {
    const f = figma.createFrame(); f.name = name; f.layoutMode = mode;
    f.primaryAxisSizingMode = "FIXED"; f.counterAxisSizingMode = "FIXED"; f.resize(w, h); f.fills = []; return f;
  };
  const rect = (name, w, h) => { const r = figma.createRectangle(); r.name = name; r.resize(w, h); return r; };
  const variant = (name, h) => {
    const c = figma.createComponent(); c.name = name; c.layoutMode = "HORIZONTAL";
    c.primaryAxisSizingMode = "FIXED"; c.counterAxisSizingMode = "FIXED"; c.resize(40, h); c.appendChild(rect("Dot", 8, 8)); return c;
  };
  const small = variant("Size=Small", 18); const large = variant("Size=Large", 48);
  figma.combineAsVariants([small, large], page).name = "Badge";

  const card = figma.createComponent(); card.name = "Card"; card.x = 200;
  card.layoutMode = "VERTICAL"; card.primaryAxisSizingMode = "AUTO"; card.counterAxisSizingMode = "FIXED";
  card.resize(320, 100); card.itemSpacing = 8;
  const title = figma.createText(); title.name = "Title"; title.fontName = { family: "Inter", style: "Regular" };
  title.characters = "Title"; card.appendChild(title);
  const row = autoFrame("Row", "HORIZONTAL", 280, 40); row.appendChild(rect("RowRect", 24, 24)); card.appendChild(row);
  const plain = figma.createFrame(); plain.name = "Plain"; plain.resize(280, 120); card.appendChild(plain);
  const ellipse = figma.createEllipse(); ellipse.name = "Ellipse"; ellipse.resize(20, 20); plain.appendChild(ellipse);
  const vector = figma.createVector(); vector.name = "Vector";
  vector.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 20 0 L 20 20 Z" }]; plain.appendChild(vector);
  const g1 = rect("G1", 10, 10); const g2 = rect("G2", 10, 10); plain.appendChild(g1); plain.appendChild(g2); g2.x = 20;
  figma.group([g1, g2], plain).name = "Group";
  const turned = rect("Turned", 30, 10); plain.appendChild(turned); turned.x = 120; turned.y = 40; turned.rotation = 30;
  const free = rect("FreeRect", 30, 30); plain.appendChild(free); free.x = 200; free.y = 60;
  const nested = small.createInstance(); nested.name = "NestedBadge"; card.appendChild(nested);
  const slot = autoFrame("Slot", "VERTICAL", 280, 80);
  slot.appendChild(autoFrame("Inherited", "HORIZONTAL", 120, 30));
  const slotBadge = small.createInstance(); slotBadge.name = "SlotBadge"; slot.appendChild(slotBadge);
  card.appendChild(slot);
  slot.componentPropertyReferences = { slotContentId: declareSlot(card, "Content") };

  const inst = card.createInstance(); inst.x = 600;
  const second = card.createInstance(); second.x = 1000;
  // A reparent destination off the instance: if Figma ever lets one through, the page removal takes it.
  const scratch = figma.createFrame(); scratch.name = "Scratch"; scratch.x = 1400;
  const at = (root, name) => root.findOne((n) => n.name === name);
  const L = (name) => at(inst, name);
  // Every slot row below is meaningless unless the instance shows the bound frame as SLOT.
  if (L("Slot").type !== "SLOT") throw new Error("instance slot reads as " + L("Slot").type + ", not SLOT");

  // Silent: Figma returns and nothing changes.
  for (const name of ["Title", "Row", "RowRect", "Plain", "Ellipse", "Vector", "Group", "Turned", "FreeRect", "NestedBadge", "Slot"]) {
    ignored("instance.explicit-resize", name, "resize +10", L(name), (x) => x.resize(x.width + 10, x.height + 10), size);
    ignored("instance.explicit-resize", name, "resizeWithoutConstraints +10", L(name), (x) => x.resizeWithoutConstraints(x.width + 10, x.height + 10), size);
    // An auto-resizing text refuses an aspect lock anywhere, instance or not: not this rule's evidence.
    const lockable = "lockAspectRatio" in L(name) && !(L(name).type === "TEXT" && L(name).textAutoResize !== "NONE");
    if (lockable) ignored("instance.aspect-lock", name, "lockAspectRatio", L(name), (x) => x.lockAspectRatio(), (x) => x.targetAspectRatio);
  }
  for (const name of ["Title", "Row", "RowRect", "NestedBadge", "Slot"]) {
    ignored("instance.size-bounds", name, "minWidth", L(name), (x) => { x.minWidth = x.width + 50; }, (x) => x.minWidth);
    ignored("instance.size-bounds", name, "maxHeight", L(name), (x) => { x.maxHeight = 5; }, (x) => x.maxHeight);
  }
  for (const [name, mode] of [["Row", "VERTICAL"], ["Plain", "HORIZONTAL"], ["Slot", "HORIZONTAL"], ["NestedBadge", "VERTICAL"]])
    ignored("instance.layout-mode-change", name, "layoutMode " + mode, L(name), (x) => { x.layoutMode = mode; }, (x) => x.layoutMode);
  // auto -> NONE on the second instance's Row, which no other row writes: if it lands, nothing later reads it.
  ignored("instance.layout-mode-change", "Row (second instance)", "layoutMode NONE", at(second, "Row"), (x) => { x.layoutMode = "NONE"; }, (x) => x.layoutMode);
  ignored("instance.explicit-resize", "NestedBadge", "height 48", L("NestedBadge"), (x) => x.resize(40, 48), size);

  // Loud: Figma throws.
  throws("instance.transform", "FreeRect", "x", L("FreeRect"), (x) => { x.x += 15; });
  throws("instance.transform", "FreeRect", "y", L("FreeRect"), (x) => { x.y += 15; });
  throws("instance.transform", "FreeRect", "rotation", L("FreeRect"), (x) => { x.rotation = 15; }, /relative.?transform/i);
  throws("instance.positioning", "RowRect", "layoutPositioning ABSOLUTE", L("RowRect"), (x) => { x.layoutPositioning = "ABSOLUTE"; });
  throws("instance.constraints", "FreeRect", "constraints", L("FreeRect"), (x) => { x.constraints = { horizontal: "MAX", vertical: "MAX" }; });
  throws("instance.child-list", "Row", "appendChild", L("Row"), (x) => x.appendChild(figma.createRectangle()));
  throws("instance.child-list", "Plain", "insertChild reorder", L("Plain"), (x) => x.insertChild(0, x.children[x.children.length - 1]));
  throws("instance.child-list", "Ellipse", "reparent out of the instance", L("Ellipse"), (x) => scratch.appendChild(x));
  throws("instance.child-list", "Vector", "remove", L("Vector"), (x) => x.remove());

  // Lands on a locked layer: the "allowed" verdicts.
  const red = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
  const paint = (key) => (x) => x[key].map((p) => p.color && [p.color.r, p.color.g, p.color.b]);
  const shadow = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL" }];
  lands("RowRect", "fills", L("RowRect"), (x) => { x.fills = red; }, paint("fills"), [[1, 0, 0]]);
  lands("RowRect", "strokes", L("RowRect"), (x) => { x.strokes = red; }, paint("strokes"), [[1, 0, 0]]);
  lands("RowRect", "strokeWeight", L("RowRect"), (x) => { x.strokeWeight = 3; }, (x) => x.strokeWeight, 3);
  lands("RowRect", "effects", L("RowRect"), (x) => { x.effects = shadow; }, (x) => x.effects.map((e) => e.type), ["DROP_SHADOW"]);
  lands("RowRect", "opacity", L("RowRect"), (x) => { x.opacity = 0.5; }, (x) => x.opacity, 0.5);
  lands("RowRect", "blendMode", L("RowRect"), (x) => { x.blendMode = "MULTIPLY"; }, (x) => x.blendMode, "MULTIPLY");
  lands("RowRect", "cornerRadius", L("RowRect"), (x) => { x.cornerRadius = 6; }, (x) => x.cornerRadius, 6);
  lands("RowRect", "layoutGrow", L("RowRect"), (x) => { x.layoutGrow = 1; }, (x) => x.layoutGrow, 1);
  lands("RowRect", "layoutAlign STRETCH", L("RowRect"), (x) => { x.layoutAlign = "STRETCH"; }, (x) => x.layoutAlign, "STRETCH");
  lands("Ellipse", "visible", L("Ellipse"), (x) => { x.visible = false; }, (x) => x.visible, false);
  // Renamed back at once: every row finds its layer by name.
  lands("Vector", "name", L("Vector"), (x) => { x.name = "Renamed"; }, (x) => x.name, "Renamed");
  at(inst, "Renamed").name = "Vector";
  lands("Title", "characters", L("Title"), (x) => { x.characters = "Changed"; }, (x) => x.characters, "Changed");
  lands("Title", "fontSize", L("Title"), (x) => { x.fontSize = 20; }, (x) => x.fontSize, 20);
  // Before the FILL row below, which may itself switch the text to HEIGHT.
  lands("Title", "textAutoResize HEIGHT", L("Title"), (x) => { x.textAutoResize = "HEIGHT"; }, (x) => x.textAutoResize, "HEIGHT");
  lands("Title", "layoutSizingHorizontal FILL", L("Title"), (x) => { x.layoutSizingHorizontal = "FILL"; }, (x) => x.layoutSizingHorizontal, "FILL");
  lands("Row", "padding", L("Row"), (x) => { x.paddingLeft = 7; x.paddingTop = 3; }, (x) => [x.paddingLeft, x.paddingTop], [7, 3]);
  lands("Row", "itemSpacing", L("Row"), (x) => { x.itemSpacing = 9; }, (x) => x.itemSpacing, 9);
  lands("Row", "primaryAxisAlignItems", L("Row"), (x) => { x.primaryAxisAlignItems = "CENTER"; }, (x) => x.primaryAxisAlignItems, "CENTER");
  lands("Row", "counterAxisAlignItems", L("Row"), (x) => { x.counterAxisAlignItems = "CENTER"; }, (x) => x.counterAxisAlignItems, "CENTER");
  lands("Row", "layoutWrap", L("Row"), (x) => { x.layoutWrap = "WRAP"; }, (x) => x.layoutWrap, "WRAP");
  lands("Row", "layoutSizingHorizontal FILL", L("Row"), (x) => { x.layoutSizingHorizontal = "FILL"; }, (x) => x.layoutSizingHorizontal, "FILL");
  const clip = !L("Plain").clipsContent;
  lands("Plain", "clipsContent", L("Plain"), (x) => { x.clipsContent = clip; }, (x) => x.clipsContent, clip);
  const S = L("Slot");
  lands("Slot", "itemSpacing", S, (x) => { x.itemSpacing = 11; }, (x) => x.itemSpacing, 11);
  lands("Slot", "padding", S, (x) => { x.paddingLeft = 5; }, (x) => x.paddingLeft, 5);
  lands("Slot", "fills", S, (x) => { x.fills = red; }, paint("fills"), [[1, 0, 0]]);
  lands("Slot", "layoutSizingVertical HUG", S, (x) => { x.layoutSizingVertical = "HUG"; }, (x) => x.layoutSizingVertical, "HUG");
  lands("Slot", "layoutSizingHorizontal FILL", S, (x) => { x.layoutSizingHorizontal = "FILL"; }, (x) => x.layoutSizingHorizontal, "FILL");

  // The instance root.
  lands("Card instance", "resize width", inst, (x) => x.resize(360, x.height), (x) => Math.round(x.width), 360);
  lands("Card instance", "x", inst, (x) => { x.x = 700; }, (x) => x.x, 700);
  lands("Card instance", "minWidth", inst, (x) => { x.minWidth = 300; }, (x) => x.minWidth, 300);
  lands("Card instance", "lockAspectRatio", inst, (x) => x.lockAspectRatio(), (x) => x.targetAspectRatio !== null, true);
  if (inst.targetAspectRatio) inst.unlockAspectRatio();
  ignored("instance.root-layout-mode", "Card instance", "layoutMode HORIZONTAL", inst, (x) => { x.layoutMode = "HORIZONTAL"; }, (x) => x.layoutMode);

  // Slot content is open; a nested instance in it locks its own descendants.
  S.appendChild(autoFrame("Own", "HORIZONTAL", 60, 20));
  // Appending into a slot remaps the node's id, so read it back by name.
  lands("Own slot content", "resize", at(S, "Own"), (x) => x.resize(90, 30), size, [90, 30]);
  lands("Own slot content", "layoutMode", at(S, "Own"), (x) => { x.layoutMode = "VERTICAL"; }, (x) => x.layoutMode, "VERTICAL");
  lands("Inherited slot content", "resize", at(S, "Inherited"), (x) => x.resize(150, 36), size, [150, 36]);
  lands("Inherited slot content", "layoutMode", at(S, "Inherited"), (x) => { x.layoutMode = "VERTICAL"; }, (x) => x.layoutMode, "VERTICAL");
  lands("Slot instance", "resize", at(S, "SlotBadge"), (x) => x.resize(40, 30), size, [40, 30]);
  ignored("instance.explicit-resize", "Slot instance descendant", "Dot resize", at(at(S, "SlotBadge"), "Dot"), (x) => x.resize(14, 14), size);

  // A nested variant swap keeps the placement's px; only the definition's placement resizes it.
  const NB = L("NestedBadge"); NB.setProperties({ Size: "Large" });
  report.rows.push({ rule: "instance.explicit-resize", layer: "NestedBadge", label: "variant swap keeps 18", expect: 18, got: Math.round(NB.height), passed: Math.round(NB.height) === 18 });
  nested.resize(40, 30);
  const h = Math.round(at(second, "NestedBadge").height);
  report.rows.push({ rule: "instance.explicit-resize", layer: "definition NestedBadge", label: "definition placement resize reaches a second instance", expect: 30, got: h, passed: h === 30 });

  // Open questions: flcm strips a restated value and leaves FIXED-without-px unverified.
  probe("Turned", "same-value x", L("Turned"), (x) => { x.x = x.x; }, (x) => x.x);
  probe("RowRect", "layoutPositioning AUTO (same value)", L("RowRect"), (x) => { x.layoutPositioning = "AUTO"; }, (x) => x.layoutPositioning);
  probe("Title", "layoutSizingHorizontal FIXED", L("Title"), (x) => { x.layoutSizingHorizontal = "FIXED"; }, (x) => x.layoutSizingHorizontal);

  report.failed = report.rows.filter((r) => !r.passed);
  report.status = report.failed.length === 0 ? "passed" : "failed";
} catch (e) {
  report.status = "failed"; report.error = String((e && e.message) || e);
} finally {
  await figma.setCurrentPageAsync(original);
  page.remove();
}
return report;
