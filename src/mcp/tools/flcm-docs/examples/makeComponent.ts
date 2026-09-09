import type { Flcm } from "@framelink/plugin/schema";

// The component-AUTHORING worked example (its sibling components.ts is the instantiating one).
// Authored against the REAL typed surface (Flcm), so a change to component/variants/the binding word
// breaks this file's typecheck rather than shipping a stale example. The generator inlines only the
// marked region below (see examples.ts).
export async function makeComponentExample(flcm: Flcm) {
  // example:start
  // Author a Button, then fold two sizes of it into a variant set. Each node a property drives says
  // so with `componentPropertyReferences`.
  const buildButton = (height: number) =>
    flcm.frame(
      {
        name: "Button",
        height,
        layout: { mode: "row", gap: 8, padding: 12, alignItems: "center" },
        fill: "#111827",
        borderRadius: 8,
      },
      [
        // A boolean property drives this dot's `visible`. Unnamed, `visible` derives to true, so
        // the definition states the false.
        flcm.ellipse({
          width: 8,
          height: 8,
          fill: "#22C55E",
          componentPropertyReferences: { visible: "Show Dot" },
        }),
        // A text property drives this content; its default derives from here ("Save").
        flcm.text("Save", {
          key: "label",
          fill: "#FFFFFF",
          componentPropertyReferences: { text: "Label" },
        }),
        // A slot property: this frame is the hole every instance fills.
        flcm.frame({ width: 24, height: 24, componentPropertyReferences: { slot: "Trailing" } }),
      ],
    );

  const definitions = {
    Label: { type: "text" },
    "Show Dot": { type: "boolean", defaultValue: false },
    Trailing: { type: "slot" },
  } as const;

  const small = await flcm.component(buildButton(32), {
    name: "Button",
    description: "The primary action.",
    propertyDefinitions: definitions,
  });
  const large = await flcm.component(buildButton(44), {
    name: "Button",
    propertyDefinitions: definitions,
  });

  // Each entry says which member of the set its component IS; the axes are what an instance picks.
  const set = await flcm.variants(
    [
      { component: small.node, variant: { Size: "Small" } },
      { component: large.node, variant: { Size: "Large" } },
    ],
    { name: "Button" },
  );

  // The set carries its members' shared properties, so Label is set beside the axis.
  await flcm.render(
    flcm.instance(set, { componentProperties: { Size: "Large", Label: "Publish" } }),
  );
  // Keys stamped in the spec still address the COMPONENT's own subtree.
  return { set: set.id, label: small.keyed.label.id };
  // example:end
}
