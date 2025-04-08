import { StyleId } from '~/utils/common.js';
import { SimplifiedNode, GlobalVars, SimplifiedDesign } from '~/services/simplify-node-response.js';

interface Result {
  shortenedNodes: SimplifiedNode[];
  shortenedGlobalVars: GlobalVars;
  idMap: Record<StyleId, string>; // Map from original long ID to new short ID
  prefixMap: Record<string, string>; // Map from generated short prefix to original prefix
}

// Regular expression to match and capture the prefix of Figma style IDs
const idPattern = /^([a-zA-Z]+)_([a-zA-Z0-9]+)$/;

export function compress(file: SimplifiedDesign): SimplifiedDesign {
  const { nodes, globalVars } = file;
  const { shortenedNodes, shortenedGlobalVars } = shortenGlobalVarIds(nodes, globalVars);

  return {
    ...file,
    nodes: shortenedNodes,
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
): Result {
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
        generatedShortPrefix = originalLowerPrefix + '_fallback';
        prefixMap[generatedShortPrefix] = originalLowerPrefix;
         console.warn(`Could not generate unique short prefix for ${originalLowerPrefix}. Using fallback: ${generatedShortPrefix}`);
      }
    } else {
      generatedShortPrefix = 'unk';
      if (!prefixMap[generatedShortPrefix]) {
         prefixMap[generatedShortPrefix] = 'unknown';
      }
       console.warn(`Unexpected GlobalVar ID format: ${originalId}. Using fallback prefix: ${generatedShortPrefix}`);
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
      'fills',
      'strokes',
      'effects',
      'layout',
      'textStyle',
      'styles', // Include 'styles' if it's used for referencing globalVars
    ];

    for (const prop of propertiesToUpdate) {
      const originalValue = newNode[prop];
      if (typeof originalValue === 'string' && originalValue in idMap) {
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
