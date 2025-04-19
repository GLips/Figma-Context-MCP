import { StyleId } from "~/utils/common.js";
import { SimplifiedNode, GlobalVars, SimplifiedDesign } from "~/services/simplify-node-response.js";

// Regular expression to match and capture the prefix of Figma style IDs
const idPattern = /^([a-zA-Z]+)_([a-zA-Z0-9]+)$/;

export function compress(file: SimplifiedDesign): SimplifiedDesign {
  const { nodes, globalVars } = file;
  const { shortenedNodes, shortenedGlobalVars } = shortenGlobalVarIds(nodes, globalVars);

  const { hierarchy, nodes: flattenedNodes } = flattenNodes(shortenedNodes);

  return {
    ...file,
    hierarchy,
    nodes: flattenedNodes,
    globalVars: shortenedGlobalVars,
  };
}

/**
 * Shortens the keys in globalVars.styles and updates references in the nodes.
 * Dynamically generates unique short prefixes based on original prefixes.
 *
 * @param nodes - The array of simplified nodes.
 * @param globalVars - The original global variables object with long IDs.
 * @returns An object containing the modified nodes, the new globalVars with short IDs,
 *          a map from original IDs to short IDs, and the prefix mapping used.
 */
export function shortenGlobalVarIds(
  nodes: SimplifiedNode[],
  globalVars: GlobalVars,
): {
  shortenedNodes: SimplifiedNode[];
  shortenedGlobalVars: GlobalVars;
  idMap: Record<StyleId, string>; // Map from original long ID to new short ID
  prefixMap: Record<string, string>; // Map from generated short prefix to original prefix
} {
  const idMap: Record<StyleId, string> = {};
  const shortenedGlobalVars: GlobalVars = { styles: {} };
  const counters: Record<string, number> = {};
  const prefixMap: Record<string, string> = {};

  for (const [originalId, styleValue] of Object.entries(globalVars.styles)) {
    const match = originalId.match(idPattern);
    let shortId: string;
    let generatedShortPrefix: string | null = null;

    if (match && match[1]) {
      const originalPrefix = match[1];
      const originalLowerPrefix = originalPrefix.toLowerCase();
      let potentialShortPrefix = "";
      let charIndex = 0;

      // Find the shortest unique prefix
      while (charIndex < originalLowerPrefix.length) {
        potentialShortPrefix += originalLowerPrefix[charIndex];
        const existingMapping = prefixMap[potentialShortPrefix];

        if (!existingMapping) {
          prefixMap[potentialShortPrefix] = originalLowerPrefix;
          generatedShortPrefix = potentialShortPrefix;
          break;
        } else if (existingMapping === originalLowerPrefix) {
          generatedShortPrefix = potentialShortPrefix;
          break;
        } else {
          charIndex++;
        }
      }

      if (!generatedShortPrefix) {
        generatedShortPrefix = originalLowerPrefix + "_fallback";
        prefixMap[generatedShortPrefix] = originalLowerPrefix;
        console.warn(
          `Could not generate unique short prefix for ${originalLowerPrefix}. Using fallback: ${generatedShortPrefix}`,
        );
      }
    } else {
      generatedShortPrefix = "unk";
      if (!prefixMap[generatedShortPrefix]) {
        prefixMap[generatedShortPrefix] = "unknown";
      }
      console.warn(
        `Unexpected GlobalVar ID format: ${originalId}. Using fallback prefix: ${generatedShortPrefix}`,
      );
    }

    if (!(generatedShortPrefix in counters)) {
      counters[generatedShortPrefix] = 0;
    }
    counters[generatedShortPrefix]++;
    shortId = `${generatedShortPrefix}${counters[generatedShortPrefix]}`;

    idMap[originalId as StyleId] = shortId;
    shortenedGlobalVars.styles[shortId as StyleId] = styleValue;
  }

  function updateNodeIds(node: SimplifiedNode): SimplifiedNode {
    const newNode: SimplifiedNode = { ...node };

    const propertiesToUpdate: (keyof SimplifiedNode)[] = [
      "fills",
      "strokes",
      "effects",
      "layout",
      "textStyle",
      "styles", // Include 'styles' if it's used for referencing globalVars
    ];

    for (const prop of propertiesToUpdate) {
      const originalValue = newNode[prop];
      if (typeof originalValue === "string" && originalValue in idMap) {
        (newNode[prop] as string) = idMap[originalValue as StyleId];
      }
    }

    if (newNode.children && newNode.children.length > 0) {
      newNode.children = newNode.children.map(updateNodeIds);
    }

    return newNode;
  }

  const shortenedNodes = nodes.map(updateNodeIds);

  return {
    shortenedNodes,
    shortenedGlobalVars,
    idMap,
    prefixMap,
  };
}


/**
 * Flattens the nodes into a hierarchy string and returns the flattened nodes.
 * the format of the hierarchy string is:
 * root1_id(child1_id(grandchild1_id(greatgrandchild1_id,greatgrandchild2_id(leaf1_id,leaf2_id)),grandchild2_id))
 *
 * @param nodes - The array of simplified nodes.
 * @returns An object containing the hierarchy string and the flattened nodes.
 */
interface TreeNode {
  id: string;
  children?: this[];
}

export function flattenNodes<T extends TreeNode>(
  nodes: T[],
): {
  hierarchy: string;
  nodes: Omit<T, "children">[];
} {
  const flattened: Omit<T, "children">[] = [];

  function buildPath(node: T): string {
    const { children, ...nodeWithoutChildren } = node;

    flattened.push(nodeWithoutChildren);

    if (!children?.length) {
      return node.id;
    }

    const childPaths = children.map(buildPath);
    return `${node.id}(${childPaths.join(",")})`;
  }

  const hierarchy = nodes.map(buildPath).join(",");


  const hierarchyText = `The hierarchy string represents the complete node structure in a compact format.
  Each node ID is followed by its children in parentheses, creating a nested representation
  that preserves the original hierarchy while eliminating the need for redundant node objects.
  This format allows for efficient reconstruction of the tree structure when needed.
  the format of the hierarchy string is: root1_id(child1_id(grandchild1_id(greatgrandchild1_id,greatgrandchild2_id(leaf1_id,leaf2_id)),grandchild2_id))
  the hierarchy data is: ${hierarchy}`;

  return {
    hierarchy: hierarchyText,
    nodes: flattened,
  };
}
