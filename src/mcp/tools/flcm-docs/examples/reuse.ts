import type { Flcm, NodeSpec } from "@framelink/plugin/schema";

export async function reuseExample(flcm: Flcm) {
  // example:start
  const { node } = await flcm.get("caption");
  // Keeping ids moves the nodes you read and edits their named props.
  const moved = await flcm.append("sidebar", { ...node, width: 480 });

  // This caption is one TEXT node. For a subtree, also drop ids on children and slot content you want copied.
  const template: NodeSpec = { ...node };
  delete template.id;
  const copy = await flcm.append("sidebar", { ...template, name: "Caption copy" });
  // clone preserves live state that the data vocabulary cannot express.
  const faithful = await flcm.clone(moved, "sidebar");
  return { moved, copy, faithful };
  // example:end
}
