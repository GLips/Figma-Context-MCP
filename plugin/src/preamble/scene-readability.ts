/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
/**
 * Whether Figma can read a node it lists. Moving inherited slot content out of its instance leaves
 * a node that renders and keeps an id while its getters throw "does not exist". Reads skip such
 * nodes instead of failing as a whole.
 *
 * Looks wrong: `parent` is deliberately not probed. Healthy instance layers indexed after a slot
 * import also throw on it (scene-access pairs them by order for that reason).
 */
export function isReadableSceneNode(node: { readonly name: string }): boolean {
  try {
    void node.name;
    return true;
  } catch {
    return false;
  }
}

/**
 * A container's children, or undefined when Figma cannot list them. A container holding an
 * unreadable node can fail as a whole, because the index pairing its layers fails closed rather
 * than guess around the gap.
 */
export function readableChildren<T>(node: { readonly children?: ReadonlyArray<T> }): ReadonlyArray<T> | undefined {
  try {
    return node.children ?? [];
  } catch {
    return undefined;
  }
}
