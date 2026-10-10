/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { Flcm } from "@framelink/plugin/schema";

export async function reuseExample(flcm: Flcm) {
  // example:start
  const { node } = await flcm.get("card");
  // Keeping ids moves the nodes you read and edits their named props.
  const moved = await flcm.append("sidebar", { ...node, width: 480 });
  // Ids select live nodes: this wraps all of the card's children in a new row, inside the card.
  const row = await flcm.append(moved, {
    type: "FRAME",
    layout: { mode: "row", gap: 8 },
    children: (node.children ?? []).map(({ id }) => ({ id })),
  });
  // clone copies, carrying live state a spec can't express.
  const copy = await flcm.clone(moved, "sidebar");
  return { moved, row, copy };
  // example:end
}
