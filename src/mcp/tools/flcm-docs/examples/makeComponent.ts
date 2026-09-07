import type { Flcm } from "@framelink/plugin/schema";

// The component-AUTHORING worked example (its sibling components.ts is the instantiating one).
// Authored against the REAL typed surface (Flcm), so a change to component/variants/the binding word
// breaks this file's typecheck rather than shipping a stale example. The generator inlines only the
// marked region below (see examples.ts).
export async function makeComponentExample(flcm: Flcm) {
  // example:start
  // Author a Button, then fold two sizes of it into a variant set.
  // The spec renders exactly as flcm.render would and its root becomes the COMPONENT; each node a
  // property drives says so with `componentPropertyReferences` — the read's own word for a binding.
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
        // A boolean property hides/shows this dot. Its default is derived from the node: `visible`
        // unnamed is true, so state the false explicitly.
        flcm.ellipse({
          width: 8,
          height: 8,
          fill: "#22C55E",
          componentPropertyReferences: { visible: "Show Dot" },
        }),
        // A text property drives this node's content; omitting `defaultValue` derives it from here ("Save").
        flcm.text("Save", {
          key: "label",
          fill: "#FFFFFF",
          componentPropertyReferences: { text: "Label" },
        }),
        // A slot IS a frame you author: this frame stays in the component, and every instance shows
        // it as a SLOT holding this frame's content.
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

  // Fold them into a set: each entry says which member of the set its component IS. The set lands
  // where the FIRST component sat, and the axes become what an instance picks.
  const set = await flcm.variants(
    [
      { component: small.node, variant: { Size: "Small" } },
      { component: large.node, variant: { Size: "Large" } },
    ],
    { name: "Button" },
  );

  // An instance picks a member by the set's AXES. Whether a member's own non-variant properties
  // (Label, Show Dot) also resolve at set level is Figma's business — read the set back before
  // naming them here.
  await flcm.render(flcm.instance(set, { componentProperties: { Size: "Large" } }));
  // `keyed` is minted from the COMPONENT's own subtree, so keys stamped in the spec still address it.
  return { set: set.id, label: small.keyed.label.id };
  // example:end
}
