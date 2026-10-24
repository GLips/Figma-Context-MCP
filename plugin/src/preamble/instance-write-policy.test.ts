/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The instance write policy, through the public verbs. What must not regress silently: a write
// Figma would ignore or throw on inside an instance refuses the SAME way on every route that can
// reach the layer (edit, editMany, a live override, render's overrides, a retargeting edit), with
// zero writes; restating the value the layer already has is never refused; the instance root and
// slot content stay open; and the resize read-back fails loud only on a layer an instance locks.
//
// The mock honors every write Figma would ignore, so these tests prove the refusal happens before
// the write. What Figma itself does is plugin/scenarios/live/instance-write-matrix's evidence.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFigmaMock, seedVariables } from "../../harness/figma-mock.mjs";
import { specNode } from "../../harness/spec-node.js";
import * as flcm from "./runtime.js";
import { warnings as diagnostics } from "./warnings.js";
import { mintAuthorizedLiveLayout } from "./instance-write-authorization.js";
import { resizeToPlannedSize } from "./sizing-diagnostics.js";
import { liveNodeSizingFacts } from "./sizing-plan.js";
import { NO_TOKENS } from "./tokens.js";
import { instanceContextOf } from "./identity.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
  diagnostics.discardFrom(0);
});

// A "Card" column holding a locked auto-layout Row, a nested Badge instance (18px tall), and a
// slot bound frame with inherited content — the matrix scenario's fixture in flcm words. `inst` is
// a live Card instance; `outgoing` is an instance of another component, for the retargeting route;
// `bystander` is an unrelated frame an editMany batch writes beside the refused entry.
async function cardFixture() {
  const badge = await flcm.component({
    type: "FRAME", name: "Badge", width: 40, height: 18, layout: { mode: "row" },
    children: [{ type: "RECTANGLE", name: "Dot", width: 8, height: 8 }],
  });
  const card = await flcm.component(
    {
      type: "FRAME", name: "Card", left: 200, width: 320, height: 240, layout: { mode: "column", gap: 8 },
      children: [
        {
          type: "FRAME", name: "Row", width: 280, height: 40, layout: { mode: "row", gap: 2 },
          children: [{ type: "RECTANGLE", name: "RowRect", width: 24, height: 24 }],
        },
        { type: "INSTANCE", name: "NestedBadge", componentId: badge.id },
        {
          type: "FRAME", name: "Slot", width: 280, height: 80, layout: { mode: "column" },
          componentPropertyReferences: { slot: "Slot" },
          children: [{ type: "FRAME", name: "Inherited", width: 120, height: 30, layout: { mode: "row" } }],
        },
      ],
    } as never,
    { propertyDefinitions: { Slot: { type: "slot" } } },
  );
  const other = await flcm.component({ type: "FRAME", name: "Other", left: 700, width: 50, height: 50 });
  const inst = await live(await flcm.render({ type: "INSTANCE", componentId: card.id, left: 600 }));
  const outgoing = await live(await flcm.render({ type: "INSTANCE", componentId: other.id, left: 1000 }));
  const bystander = await live(await flcm.render({ type: "FRAME", name: "Bystander", left: 1400, width: 10, height: 10 }));
  const definition = await live(card);
  const pathOf = (name: string): string => definition.findOne((n: any) => n.name === name).id;
  return { badge, card, definition, inst, outgoing, bystander, pathOf };
}
type Fixture = Awaited<ReturnType<typeof cardFixture>>;

const live = (handle: { id?: string }) => figma.getNodeByIdAsync(handle.id!) as Promise<any>;
const layerOf = (root: any, name: string) => root.findOne((n: any) => n.name === name);

// Every node on the page, by the fields any route could write. Equal snapshots mean zero writes.
function pageSnapshot(): string {
  const of = (n: any): unknown => [
    n.id, n.type, n.name, n.width, n.height, n.opacity, n.layoutMode, n.itemSpacing, n.mainComponent?.id,
    (n.children ?? []).map(of),
  ];
  return JSON.stringify(figma.currentPage.children.map(of));
}

// The three locked-layer changes the parity tests drive: a nested instance's explicit height, a
// locked auto-layout frame's direction, and the direction of the instance's SLOT node itself.
const LOCKED_CASES = [
  { what: "a nested instance's height", layer: "NestedBadge", change: { height: 48 }, rule: /\(instance\.explicit-resize\)/, restate: { height: 18, opacity: 0.5 } },
  { what: "a locked frame's direction", layer: "Row", change: { layout: { mode: "column" } }, rule: /\(instance\.layout-mode-change\)/, restate: { layout: { mode: "row", gap: 6 } } },
  { what: "a slot's direction", layer: "Slot", change: { layout: { mode: "row" } }, rule: /\(instance\.layout-mode-change\)/, restate: { layout: { mode: "column", gap: 6 } } },
] as const;

// Each route writes `delta` to the named layer and resolves to the instance whose layer it wrote.
const ROUTES: Record<string, (fx: Fixture, layer: string, delta: object) => Promise<any>> = {
  "flcm.edit": async (fx, layer, delta) => { await flcm.edit(layerOf(fx.inst, layer).id, delta as never); return fx.inst; },
  "flcm.editMany": async (fx, layer, delta) => {
    await flcm.editMany([{ id: fx.bystander.id, name: "Changed" }, { id: layerOf(fx.inst, layer).id, ...delta }] as never);
    return fx.inst;
  },
  "live override": async (fx, layer, delta) => {
    await flcm.edit(fx.inst.id, { opacity: 0.5, overrides: { [fx.pathOf(layer)]: delta } } as never);
    return fx.inst;
  },
  "render overrides": async (fx, layer, delta) =>
    live(await flcm.render({ type: "INSTANCE", componentId: fx.card.id, overrides: { [fx.pathOf(layer)]: delta } } as never)),
  "retargeting edit": async (fx, layer, delta) => {
    await flcm.edit(fx.outgoing.id, { componentId: fx.card.id, opacity: 0.5, overrides: { [fx.pathOf(layer)]: delta } } as never);
    return fx.outgoing;
  },
};

for (const { what, layer, change, rule } of LOCKED_CASES) {
  for (const [route, write] of Object.entries(ROUTES)) {
    test(`${what} refuses through ${route}, naming the rule, with zero writes`, async () => {
      const fx = await cardFixture();
      const before = pageSnapshot();
      const pageChildren = figma.currentPage.children.length;
      const undo = [...figma.undoLog];
      await assert.rejects(write(fx, layer, change), rule);
      assert.equal(pageSnapshot(), before);
      assert.equal(figma.currentPage.children.length, pageChildren);
      assert.deepEqual(figma.undoLog, undo);
      assert.equal(fx.bystander.name, "Bystander");
      assert.equal(fx.outgoing.mainComponent.name, "Other");
    });
  }
}

// A pasted read restates the locked value; only the open word beside it is written. Two paths:
// judged on the live layer, and judged first against the definition (a render's overrides).
for (const { what, layer, restate } of LOCKED_CASES.slice(0, 2)) {
  for (const route of ["flcm.edit", "render overrides"]) {
    const write = ROUTES[route];
    test(`restating ${what} through ${route} writes only the open word`, async () => {
      const fx = await cardFixture();
      const target = layerOf(await write(fx, layer, restate), layer);
      if (layer === "NestedBadge") {
        assert.equal(target.height, 18);
        assert.equal(target.opacity, 0.5);
      } else {
        assert.equal(target.layoutMode, layer === "Row" ? "HORIZONTAL" : "VERTICAL");
        assert.equal(target.itemSpacing, 6);
      }
    });
  }
}

// A number compiles with "fixed" beside it, so on a hugging axis it is a sizing change even when
// the px matches: refused, and the axis keeps hugging.
test("a px matching a hugging locked axis is refused, not restated", async () => {
  const hug = await flcm.component({ type: "FRAME", name: "HugBadge", layout: { mode: "row" }, children: [{ type: "RECTANGLE", width: 8, height: 8 }] });
  const holder = await flcm.component({ type: "FRAME", name: "Holder", width: 100, height: 40, layout: { mode: "row" }, children: [{ type: "INSTANCE", name: "Hugging", componentId: hug.id }] });
  const inst = await live(await flcm.render({ type: "INSTANCE", componentId: holder.id, left: 400 }));
  const nested = layerOf(inst, "Hugging");
  assert.equal(nested.layoutSizingVertical, "HUG");
  await assert.rejects(flcm.edit(nested.id, { height: nested.height, opacity: 0.5 }), /height \(a fixed size where the layer hugs\).*\(instance\.explicit-resize\)/);
  assert.equal(nested.layoutSizingVertical, "HUG");
  assert.equal(nested.opacity, 1);
});

// A read spells a bound fixed size as its variable. Pasted back, that names the binding the layer
// already has: no change, so it is stripped, while another variable is a real resize.
test("a locked layer's bound size, read and pasted back, restates; another variable is refused", async () => {
  const { "icon/size": iconSize } = seedVariables({
    collection: "Sizes",
    variables: [{ name: "icon/size", type: "FLOAT", values: { Default: 24 } }, { name: "icon/large", type: "FLOAT", values: { Default: 32 } }],
  });
  const card = await flcm.component({
    type: "FRAME", name: "IconCard", width: 100, height: 60, layout: { mode: "row" },
    children: [{ type: "RECTANGLE", name: "Icon", width: { variable: "icon/size" }, height: 24 }],
  });
  const inst = await live(await flcm.render({ type: "INSTANCE", componentId: card.id, left: 400 }));
  const icon = layerOf(inst, "Icon");
  assert.equal(icon.boundVariables.width.id, iconSize.id);
  const read = (await flcm.get(inst)).node as any;
  assert.deepEqual(read.children[0].width, { variable: "icon/size", value: 24 });

  await flcm.render({ ...read, opacity: 0.5 });
  await flcm.edit(icon.id, { width: { variable: "icon/size" }, fill: "#00ff00" } as never);
  const { id: _id, ...template } = read;
  await flcm.render({ ...template, left: 600 });
  assert.equal(inst.opacity, 0.5);
  assert.deepEqual(icon.fills[0].color, { r: 0, g: 1, b: 0 });
  assert.equal(icon.boundVariables.width.id, iconSize.id);

  await assert.rejects(flcm.edit(icon.id, { width: { variable: "icon/large" } } as never), /width: Figma silently ignores.*\(instance\.explicit-resize\)/);
  const path = (await live(card)).children[0].id;
  await assert.rejects(
    flcm.render({ type: "INSTANCE", componentId: card.id, overrides: { [path]: { width: { variable: "icon/large" } } } } as never),
    /\(instance\.explicit-resize\)/,
  );
  assert.equal(icon.boundVariables.width.id, iconSize.id);
});

// A read of a resized instance states its constrained layers where the resize put them, in
// `overrides` and in the echo alike. Those are measurements, so a render of that read as a
// template resizes the copy and moves nothing; a real move on the same layer is still refused.
test("a resized instance's read renders as a template despite its reflowed layers", async () => {
  const card = await flcm.component({
    type: "FRAME", name: "Pinned", width: 320, height: 100,
    children: [
      { type: "RECTANGLE", name: "Corner", left: 280, top: 10, width: 20, height: 20, constraints: { x: "right" } },
      { type: "RECTANGLE", name: "Bar", left: 10, top: 50, width: 300, height: 20, constraints: { x: "stretch" } },
    ],
  } as never);
  const inst = await live(await flcm.render({ type: "INSTANCE", componentId: card.id, left: 400, width: 400 }));
  const { id: _id, ...template } = (await flcm.get(inst)).node as any;
  assert.deepEqual(Object.values(template.overrides), [{ left: 360 }, { width: 380 }]);
  const copy = await live(await flcm.render({ ...template, left: 900 }));
  assert.equal(layerOf(copy, "Corner").x, 360);
  assert.equal(layerOf(copy, "Bar").width, 380);

  const corner = (await live(card)).children[0].id;
  await assert.rejects(
    flcm.render({ type: "INSTANCE", componentId: card.id, overrides: { [corner]: { left: 100 } } } as never),
    /left: Figma throws on this inside an instance.*\(instance\.transform\)/,
  );
});

test("fill and hug land on a locked layer, where an explicit resize would not", async () => {
  const fx = await cardFixture();
  const rowRect = layerOf(fx.inst, "RowRect");
  await flcm.edit(rowRect.id, { width: "fill", fill: "#00ff00" });
  assert.equal(rowRect.layoutSizingHorizontal, "FILL");
  assert.deepEqual(rowRect.fills[0].color, { r: 0, g: 1, b: 0 });
  const row = layerOf(fx.inst, "Row");
  await flcm.edit(row.id, { height: "hug" });
  assert.equal(row.layoutSizingVertical, "HUG");
});

// Figma throws on a locked layer's transform; a restated one is stripped, so it is never written.
test("a rotation on a locked layer refuses before any write; restating its rotation lands the rest", async () => {
  const fx = await cardFixture();
  const rowRect = layerOf(fx.inst, "RowRect");
  const before = pageSnapshot();
  await assert.rejects(
    flcm.edit(rowRect.id, { rotation: 45, opacity: 0.5 }),
    /rotation: Figma throws on this inside an instance.*\(instance\.transform\)/,
  );
  assert.equal(pageSnapshot(), before);
  await flcm.edit(rowRect.id, { rotation: 0, opacity: 0.5 });
  assert.equal(rowRect.opacity, 0.5);
  assert.equal(rowRect.rotation, 0);
});

test("the instance root takes size, bounds and aspect", async () => {
  const fx = await cardFixture();
  await flcm.edit(fx.inst.id, { width: 360 });
  assert.equal(fx.inst.width, 360);
  await flcm.edit(fx.inst.id, { minWidth: 300 });
  assert.equal(fx.inst.minWidth, 300);
  await flcm.edit(fx.inst.id, { aspectRatio: 1.5 });
  assert.ok(fx.inst.targetAspectRatio);
  assert.equal(fx.definition.width, 320); // the component is untouched
});

// The root's direction follows its component on every route that can set it: matching restates,
// a different one refuses with zero writes.
const ROOT_DIRECTION_ROUTES: Record<string, (fx: Fixture, mode: string) => Promise<unknown>> = {
  "flcm.edit": (fx, mode) => flcm.edit(fx.inst.id, { opacity: 0.5, layout: { mode, gap: 20 } } as never),
  "flcm.editMany": (fx, mode) => flcm.editMany([{ id: fx.bystander.id, name: "Changed" }, { id: fx.inst.id, layout: { mode } }] as never),
  render: (fx, mode) => flcm.render({ type: "INSTANCE", componentId: fx.card.id, layout: { mode } } as never),
  "live-tree placement": (fx, mode) => flcm.append(fx.bystander.id, { id: fx.inst.id, layout: { mode } } as never),
  clone: (fx, mode) => flcm.clone(fx.inst.id, { layout: { mode } } as never),
};

for (const [route, write] of Object.entries(ROOT_DIRECTION_ROUTES)) {
  test(`an instance root's direction follows its component through ${route}`, async () => {
    const fx = await cardFixture();
    const before = pageSnapshot();
    await assert.rejects(write(fx, "row"), /\(instance\.root-layout-mode\)/);
    assert.equal(pageSnapshot(), before);
    await write(fx, "column");
    assert.equal(fx.inst.layoutMode, "VERTICAL");
  });
}

for (const retarget of ["swap", "variant"] as const) {
  test(`a ${retarget}'s root direction is judged against the incoming component, with zero writes on refusal`, async () => {
    const variants = ["Size=Small, State=Default", "Size=Large, State=Default", "Size=Large, State=Hover"].map((name) => {
      const c = figma.createComponent();
      c.name = name;
      figma.currentPage.appendChild(c);
      return c;
    });
    figma.combineAsVariants(variants, figma.currentPage).name = "Button";
    variants[1].layoutMode = "HORIZONTAL";
    variants[2].layoutMode = "VERTICAL";
    const inst = await live(await flcm.render({ type: "INSTANCE", componentId: variants[1].id }));
    const changes = retarget === "swap" ? { componentId: variants[2].id } : { componentProperties: { State: "Hover" } };
    const before = pageSnapshot();
    await assert.rejects(
      flcm.edit(inst.id, { ...changes, opacity: 0.5, layout: { mode: "row", gap: 20 } } as never),
      /\(instance\.root-layout-mode\)/,
    );
    assert.equal(pageSnapshot(), before);
    await flcm.editMany([{ id: inst.id, ...changes, layout: { mode: "column", gap: 20 } }] as never);
    assert.equal(inst.mainComponent, variants[2]);
    assert.equal(inst.itemSpacing, 20);
  });
}

test("own and inherited slot content take resize and direction; an instance placed there locks its own layers", async () => {
  const fx = await cardFixture();
  const filled = await flcm.render({
    type: "INSTANCE", componentId: fx.card.id, left: 2000,
    overrides: {
      [fx.pathOf("Slot")]: {
        children: [
          { type: "FRAME", key: "own", width: 60, height: 20, layout: { mode: "row" } },
          { type: "INSTANCE", key: "slotBadge", componentId: fx.badge.id },
        ],
      },
    },
  } as never);
  const own = await live(specNode(filled, "own"));
  await flcm.edit(own.id, { width: 90, rotation: 15, layout: { mode: "column" } });
  assert.equal(own.width, 90);
  assert.equal(own.rotation, -15);
  assert.equal(own.layoutMode, "VERTICAL");
  const inherited = layerOf(fx.inst, "Inherited");
  await flcm.edit(inherited.id, { width: 150, layout: { mode: "column" } });
  assert.equal(inherited.width, 150);
  assert.equal(inherited.layoutMode, "VERTICAL");
  const slotBadge = await live(specNode(filled, "slotBadge"));
  await flcm.edit(slotBadge.id, { width: 44 });
  assert.equal(slotBadge.width, 44);
  const dot = layerOf(slotBadge, "Dot");
  await assert.rejects(flcm.edit(dot.id, { width: 14 }), /\(instance\.explicit-resize\)/);
  assert.equal(dot.width, 8);
});

// The read-back behind the policy. The mock honors every resize, so one node's resize is stubbed
// into a no-op. The instance root is open, so a miss there is a warning like anywhere else.
test("a resize Figma ignores on an instance root is a warning, not a failure", async () => {
  const fx = await cardFixture();
  fx.inst.resize = () => {};
  await flcm.edit(fx.inst.id, { height: 48 });
  const said = diagnostics.summary().join("\n");
  assert.match(said, /requested height 48; Figma realized 240/);
  assert.doesNotMatch(said, /policy gap/);
});

// On a locked layer the policy refuses every resize, so no route reaches the backstop there today;
// it exists for the write the policy doesn't know about. Driven directly, with a minted layout.
test("a planned resize Figma ignores on a locked layer throws as a policy gap", async () => {
  const fx = await cardFixture();
  const rowRect = layerOf(fx.inst, "RowRect");
  const layout = mintAuthorizedLiveLayout("test", rowRect, { child: { kind: "free", layout: {} }, sizingFacts: liveNodeSizingFacts(rowRect) }, instanceContextOf(rowRect), NO_TOKENS);
  rowRect.resize = () => {};
  assert.throws(() => resizeToPlannedSize(rowRect, layout, { width: 30, height: 24 }), /requested width 30; Figma realized 24 \(instance write policy gap\)/);
});

test("outside any instance, a percent or aspect resize Figma doesn't honor is a warning, not a failure", async () => {
  const parent = await flcm.render({
    type: "FRAME", width: 200, height: 100,
    children: [{ type: "RECTANGLE", key: "box", width: 40, height: 40 }],
  });
  const box = await live(specNode(parent, "box"));
  box.resize = () => {};
  await flcm.edit(box.id, { width: "50%" });
  await flcm.edit(box.id, { aspectRatio: 2 });
  const said = diagnostics.summary().join("\n");
  assert.match(said, /requested width 100; Figma realized 40/);
  assert.match(said, /requested height 20; Figma realized 40/);
  assert.doesNotMatch(said, /policy gap/);
});

// The raw mutations the policy authorizes have one home each, so a new route can't reach Figma
// around it. ESLint ignores plugin/**, so this guard is a test.
// compile-nodes.ts and css.ts set `rotation` on compiled words, never on a node.
test("raw resize, aspect lock, layout-mode, bounds and rotation writes and authorized casts each live in one module", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const homes: [RegExp, string[]][] = [
    [/\.resize\(|resizeWithoutConstraints/, ["sizing-diagnostics.ts"]],
    [/\b(?:lock|unlock)AspectRatio\(\)/, ["aspect-ratio.ts"]],
    [/\.layoutMode\s*=(?!=)/, ["bridge.ts"]],
    // `geometry`/`slim` are the read output's own bounds (bridge.ts, read.ts), not a node's.
    [/(?<!\b(?:geometry|slim))\.(?:min|max)(?:Width|Height)\s*=(?!=)|writeBindable\([^,]+,\s*"(?:min|max)(?:Width|Height)"/, ["size-bounds.ts"]],
    [/\.rotation\s*=(?!=)/, ["bridge.ts", "compile-nodes.ts", "css.ts"]],
    [/as (?:unknown as )?Authorized/, ["instance-write-authorization.ts"]],
  ];
  for (const [pattern, allowed] of homes) {
    const offenders = sources.filter((file) => !allowed.includes(file) && readFileSync(join(dir, file), "utf8")
      .split("\n").some((line) => !/^\s*(?:\/\/|\*)/.test(line) && pattern.test(line)));
    assert.deepEqual(offenders, [], pattern + " belongs only in " + allowed.join(", "));
  }
});
