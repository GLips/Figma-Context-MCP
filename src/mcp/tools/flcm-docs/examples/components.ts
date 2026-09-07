import type { Flcm } from "@framelink/plugin/schema";

// The component-instantiation worked example. Authored against the REAL typed surface (Flcm), so a
// change to instance/get/find breaks this file's typecheck rather than shipping a stale example. The
// generator inlines only the marked region below (see examples.ts).
export async function componentsExample(flcm: Flcm) {
  // example:start
  // A toolbar of buttons from the file's Button component. Find the component set by name, then read
  // one variant to learn its property names and sublayer paths (the `components` sidecar lists them).
  const button = await flcm.findOne({ type: "COMPONENT_SET", name: "Button" });
  const { components } = await flcm.get(button);
  // components[button.id].propertyDefinitions → { Size: { type: "variant", variantOptions: [...] }, Label: { type: "text" }, ... }

  const toolbar = flcm.frame({ key: "toolbar", layout: { mode: "row", gap: 8, padding: 12 } }, [
    // The set as the component: the variant is picked by its axes, as a whole combination.
    flcm.instance(button, {
      key: "save",
      componentProperties: { Size: "Large", State: "Default", Label: "Save" },
    }),
    // The same, plus a root-level override (width) and a sublayer override by component-relative path —
    // exactly the path `get` keys an instance's `overrides` by. Everything unnamed keeps tracking the component.
    flcm.instance(button, {
      key: "cancel",
      width: 120,
      componentProperties: { Size: "Large", Label: "Cancel" },
      overrides: { "11:9": { fill: "#B91C1C" } },
    }),
  ]);
  const out = await flcm.render(toolbar);

  // A read instance authors as-is: `componentId`, `componentProperties` and `overrides` are the same words.
  const { node: save } = await flcm.get(out.keyed.save);
  await flcm.append("toolbar", flcm.instance({ ...save, name: "Save (copy)" }));
  return { toolbar: out.node.id, definitions: Object.keys(components ?? {}) };
  // example:end
}
