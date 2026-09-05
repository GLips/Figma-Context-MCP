import type {
  Component,
  GetFileNodesResponse,
  GetFileResponse,
  Node as FigmaDocumentNode,
} from "@figma/rest-api-spec";
import type { NodeSnapshot } from "@framelink/core/snapshot";
import type { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import { parseAPIResponse } from "./rest.js";
import { restNodeToSnapshot } from "./node-to-snapshot.js";

/**
 * Fetch the definitions for components a read REFERENCED but didn't contain.
 *
 * A component's children are emitted once and every instance of it as a diff, so the read needs
 * that component's subtree from somewhere. When the definition is on the same page it is already
 * in the tree and nothing here runs. Otherwise the core's floor is to donate the least-edited
 * instance's children — honest, but the donor's own edits are baked in. This is the upgrade: ask
 * Figma for the real definition.
 *
 * Two shapes, because a component id means two different things:
 *   - `remote: false` — another page of the SAME file. The id addresses a real node there, so one
 *     `?ids=` call answers every one of them.
 *   - `remote: true` — a published library. The id is local to the consuming file and addresses
 *     nothing; only the publish `key` crosses files, so each one costs a `/components/:key` lookup
 *     for its file+node, and then one `?ids=` per library file.
 *
 * EVERY failure falls back to the donor floor. This is a supplementary fetch against a famously
 * rate-limited API, and the library grant is separate from the file grant — a user can have full
 * access to a file whose components they cannot open. So failures are logged and swallowed: the
 * read still returns, one notch less pristine.
 */
export async function fetchComponentDefinitions(
  figmaService: FigmaService,
  fileKey: string,
  apiResponse: GetFileResponse | GetFileNodesResponse,
): Promise<NodeSnapshot[]> {
  const { rawNodes, components } = parseAPIResponse(apiResponse);
  const missing = missingDefinitions(rawNodes, components);
  if (missing.length === 0) return [];

  const local = missing.filter(([, component]) => !component.remote);
  const remote = missing.filter(([, component]) => component.remote);

  const fetches: Promise<NodeSnapshot[]>[] = [];
  if (local.length > 0) {
    const wanted = new Map(local.map(([id]) => [id, id]));
    fetches.push(fetchDefinitionNodes(figmaService, fileKey, wanted));
  }
  for (const [libraryFileKey, wanted] of await locateRemote(figmaService, remote)) {
    fetches.push(fetchDefinitionNodes(figmaService, libraryFileKey, wanted));
  }

  const settled = await Promise.all(fetches);
  return settled.flat();
}

/**
 * The component ids instances point at that no COMPONENT/COMPONENT_SET node in the response
 * defines, paired with their table row. The row is what says where to look: `remote` picks the
 * fetch shape and `key` is the only cross-file handle.
 */
function missingDefinitions(
  rawNodes: FigmaDocumentNode[],
  components: Record<string, Component>,
): Array<[string, Component]> {
  const referenced = new Set<string>();
  const defined = new Set<string>();
  const visit = (node: FigmaDocumentNode): void => {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") defined.add(node.id);
    if (node.type === "INSTANCE" && node.componentId) referenced.add(node.componentId);
    for (const child of "children" in node ? (node.children ?? []) : []) visit(child);
  };
  for (const node of rawNodes) visit(node);

  const missing: Array<[string, Component]> = [];
  for (const id of referenced) {
    if (defined.has(id)) continue;
    const component = components[id];
    // No table row means no key and no `remote` flag — nothing to fetch WITH. The donor floor
    // covers it, which is the same place a 403 or a deleted component lands.
    if (component) missing.push([id, component]);
  }
  return missing;
}

/**
 * Trade each published component's key for the library file + node it lives at, grouped so one
 * library costs one `?ids=` call however many of its components the read used. The returned map's
 * values go library node id → the id the CONSUMING file knows the component by, which is the id
 * the fetched subtree has to come back under.
 */
async function locateRemote(
  figmaService: FigmaService,
  remote: Array<[string, Component]>,
): Promise<Map<string, Map<string, string>>> {
  const byFile = new Map<string, Map<string, string>>();
  const sites = await Promise.all(
    remote.map(async ([localId, component]) => {
      try {
        const site = await figmaService.getPublishedComponentSite(component.key);
        return { localId, ...site };
      } catch (error) {
        Logger.log(
          `Component definition for ${component.name} (key ${component.key}) is unreachable — ` +
            `falling back to a donated instance: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }),
  );
  for (const site of sites) {
    if (!site) continue;
    const wanted = byFile.get(site.fileKey) ?? new Map<string, string>();
    wanted.set(site.nodeId, site.localId);
    byFile.set(site.fileKey, wanted);
  }
  return byFile;
}

/**
 * One `?ids=` call, decoded to snapshots keyed by the id the READ uses. The root id is rewritten
 * because a remote definition's node id belongs to the library file while the instance points at
 * the consuming file's own id for it; descendant ids are left alone, since an instance sublayer's
 * path (`I<instance>;<tail>`) is already stated in the definition's id space.
 */
async function fetchDefinitionNodes(
  figmaService: FigmaService,
  fileKey: string,
  wanted: Map<string, string>,
): Promise<NodeSnapshot[]> {
  try {
    const response = await figmaService.getRawNodes(fileKey, [...wanted.keys()]);
    const snapshots: NodeSnapshot[] = [];
    for (const [nodeId, entry] of Object.entries(response.nodes)) {
      if (!entry) continue;
      const snapshot = restNodeToSnapshot(entry.document, entry.styles ?? {}, {
        components: entry.components,
        componentSets: entry.componentSets,
      });
      snapshots.push({ ...snapshot, id: wanted.get(nodeId) ?? nodeId });
    }
    return snapshots;
  } catch (error) {
    Logger.log(
      `Component definitions in ${fileKey} are unreachable — falling back to donated instances: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
