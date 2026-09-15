import type { Flcm, NodeSpec } from "@framelink/plugin/schema";

export async function reuseExample(flcm: Flcm) {
  // example:start
  const { node } = await flcm.get("card");
  // Keeping ids moves the nodes you read and edits their named props.
  const moved = await flcm.append("sidebar", { ...node, width: 480 });

  // Drop every node id to stamp a copy, including nodes in instance slot overrides.
  function withoutIds(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutIds);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "id")
        .map(([key, child]) => [key, withoutIds(child)]),
    );
  }
  const template = withoutIds(node) as NodeSpec;
  const copy = await flcm.append("sidebar", { ...template, name: "Card copy" });
  // clone preserves live state that the data vocabulary cannot express.
  const faithful = await flcm.clone(moved, "sidebar");
  return { moved, copy, faithful };
  // example:end
}
