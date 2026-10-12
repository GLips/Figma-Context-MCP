import type { Component } from "@figma/rest-api-spec";
import { offTreeComponentIds } from "@framelink/core";
import type { NodeSnapshot } from "@framelink/core/snapshot";
import { limitConcurrency } from "~/utils/concurrency.js";
import { Logger } from "~/utils/logger.js";
import {
  componentTablesOf,
  mainComponentOf,
  type RestComponentTables,
} from "./decode/component-tables.js";
import { restNodeToSnapshot } from "./decode/node-to-snapshot.js";
import type { ParsedRestResponse } from "./decode/response.js";
import type { RestDesignSource } from "./read-rest-design.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";

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
 * One caveat the fetch cannot remove: `?ids=` returns the library's CURRENT state, and a consuming
 * file pins the version of a component it last accepted. A library layer added since then reads as
 * a layer every instance has hidden. The floor has the mirror-image bias (a donor's own edits), so
 * neither source is authoritative — `childrenFrom` says which one a reader is looking at.
 *
 * EVERY failure falls back to the donor floor. This is a supplementary fetch against a famously
 * rate-limited API, and the library grant is separate from the file grant — a user can have full
 * access to a file whose components they cannot open. So failures are logged and swallowed: the
 * read still returns, one notch less pristine.
 */
export async function fetchComponentDefinitions(
  source: RestDesignSource,
  fileKey: FigmaFileKey,
  { snapshots, tables: consuming }: ParsedRestResponse,
  maxDepth?: number,
): Promise<NodeSnapshot[]> {
  // Discovery walks the slice of the document the READ will keep: a hidden layer or one below the
  // depth cut never reaches the output, so fetching its component spends a request — and a slot of
  // the fetch budget — on bytes nobody sees. A component with no table row has no key and no
  // `remote` flag, nothing to fetch WITH; the donor floor covers it, as it does a 403.
  const found = offTreeComponentIds(snapshots, { read: "wire", maxDepth }).flatMap(
    (id): Array<[string, Component]> => {
      const component = consuming.components[id];
      return component ? [[id, component]] : [];
    },
  );
  if (found.length === 0) return [];

  // A published component costs its OWN key lookup, so a design-system page referencing a hundred
  // of them would fire a hundred concurrent calls at an API that rate-limits hard. Bound the work
  // and say what fell off the end: silent truncation reads as "we fetched everything".
  const missing = found.slice(0, MAX_DEFINITION_FETCHES);
  if (found.length > missing.length) {
    Logger.log(
      `Fetching definitions for ${missing.length} of ${found.length} off-tree components ` +
        `(cap ${MAX_DEFINITION_FETCHES}); the rest fall back to a donated instance.`,
    );
  }

  const local = missing.filter(([, component]) => !component.remote);
  const remote = missing.filter(([, component]) => component.remote);

  const fetches: Promise<NodeSnapshot[]>[] = [];
  if (local.length > 0) {
    // Same-file ids address real nodes here, so nothing needs re-keying and one call answers all.
    const wanted = new Map(local.map(([id]) => [id, { id, key: undefined }]));
    fetches.push(fetchDefinitionNodes(source, fileKey, wanted, consuming, false));
  }
  for (const [libraryFileKey, wanted] of await locateRemote(source, remote)) {
    fetches.push(fetchDefinitionNodes(source, libraryFileKey, wanted, consuming, true));
  }

  const settled = await Promise.all(fetches);
  return settled.flat();
}

/**
 * How many off-tree definitions one read will fetch. Each published one is a key lookup plus a
 * share of a node fetch, against an API whose rate limit is the read's real constraint. Past this
 * the donor floor is the better trade: a slower read that 429s is worse than a slightly less
 * pristine one.
 */
const MAX_DEFINITION_FETCHES = 40;

/** Concurrent key lookups. Enough to hide latency, low enough not to look like a burst. */
const KEY_LOOKUP_CONCURRENCY = 6;

/**
 * Trade each published component's key for the library file + node it lives at, grouped so one
 * library costs one `?ids=` call however many of its components the read used. The returned map's
 * values go library node id → the id the CONSUMING file knows the component by, which is the id
 * the fetched subtree has to come back under.
 */
async function locateRemote(
  source: RestDesignSource,
  remote: Array<[string, Component]>,
): Promise<Map<FigmaFileKey, Map<string, WantedDefinition>>> {
  const byFile = new Map<FigmaFileKey, Map<string, WantedDefinition>>();
  const lookup = limitConcurrency(KEY_LOOKUP_CONCURRENCY);
  const sites = await Promise.all(
    remote.map(([localId, component]) =>
      lookup(async () => {
        try {
          const site = await source.getPublishedComponentSite(component.key);
          return { localId, key: component.key, ...site };
        } catch (error) {
          // A cancelled call is not an access failure: stop rather than fall back.
          source.signal?.throwIfAborted();
          Logger.log(
            `Component definition for ${component.name} (key ${component.key}) is unreachable — ` +
              `falling back to a donated instance: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      }),
    ),
  );
  for (const site of sites) {
    if (!site) continue;
    const wanted = byFile.get(site.fileKey) ?? new Map<string, WantedDefinition>();
    wanted.set(site.nodeId, { id: site.localId, key: site.key });
    byFile.set(site.fileKey, wanted);
  }
  return byFile;
}

/** A definition to fetch: the id the READ must see it under, and its publish key when it has one. */
interface WantedDefinition {
  id: string;
  key?: string;
}

/**
 * One `?ids=` call, decoded to snapshots keyed by the id the READ uses. The root id is rewritten
 * because a remote definition's node id belongs to the library file while the instance points at
 * the consuming file's own id for it; descendant ids are left alone, since an instance sublayer's
 * path (`I<instance>;<tail>`) is already stated in the definition's id space.
 */
async function fetchDefinitionNodes(
  source: RestDesignSource,
  fileKey: FigmaFileKey,
  wanted: Map<string, WantedDefinition>,
  consuming: Required<RestComponentTables>,
  /** A published library answers with its CURRENT version; the same file answers with this one. */
  fromLibrary: boolean,
): Promise<NodeSnapshot[]> {
  let response;
  try {
    response = await source.getRawNodes(fileKey, [...wanted.keys()]);
  } catch (error) {
    // Access, rate limit, network. Expected enough to be a fallback rather than a failure — unless
    // the call was cancelled, which is no access failure and has nobody left to fall back for.
    source.signal?.throwIfAborted();
    Logger.log(
      `Component definitions in ${fileKey} are unreachable — falling back to donated instances: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  // A decode failure is NOT an access failure: the response arrived and we could not read it, which
  // is a bug in the adapter or a wire change, not a permission. Log it as its own thing rather than
  // letting it hide among the 403s — but still fall back, because a read that dies on supplementary
  // data is worse than one that publishes a donated body.
  const snapshots: NodeSnapshot[] = [];
  for (const [nodeId, entry] of Object.entries(response.nodes)) {
    const target = wanted.get(nodeId);
    if (!entry) {
      Logger.log(`Component definition ${nodeId} in ${fileKey} came back empty — donor instead.`);
      continue;
    }
    try {
      const library = componentTablesOf(entry);
      const snapshot = restNodeToSnapshot(entry.document, entry.styles ?? {}, library);
      snapshots.push(localize(snapshot, target?.id ?? nodeId, library, consuming, fromLibrary));
    } catch (error) {
      Logger.log(
        `Component definition ${nodeId} in ${fileKey} failed to decode — donor instead: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return snapshots;
}

/**
 * Move a fetched definition into the CONSUMING file's id space.
 *
 * The root is re-keyed because a library definition's node id belongs to the library while the
 * instance points at the id the consuming file minted for it. Descendant ids are left alone: an
 * instance sublayer's path (`I<instance>;<tail>`) is already stated in the definition's own id
 * space, which is what lets the diff line up at all.
 *
 * Nested `componentId`s are the trap. A component inside the fetched subtree names its own
 * component by a LIBRARY id, and that id can collide with an unrelated component in the consuming
 * file — the sidecar is keyed by bare id, so the collision would silently point one component's
 * children at another's. Publish keys are the only identity that crosses files, so a nested
 * reference is translated through them, and one that doesn't translate loses its `componentId`
 * rather than asserting something false. That nested instance keeps its children and simply isn't
 * named — the same place an unpublished component lands.
 */
function localize(
  snapshot: NodeSnapshot,
  rootId: string,
  library: Required<RestComponentTables>,
  consuming: Required<RestComponentTables>,
  fromLibrary: boolean,
): NodeSnapshot {
  const componentIdByKey = new Map<string, string>();
  for (const [id, component] of Object.entries(consuming.components)) {
    componentIdByKey.set(component.key, id);
  }

  // `mainComponent` was read out of the LIBRARY's tables, so its set id is a library id too. Rebuild
  // the whole reference from the consuming file's tables rather than patching the id: the name and
  // description a reader sees should be the ones this file has, not the library's newer copy.
  const translate = (node: NodeSnapshot): void => {
    if (node.componentId) {
      const key = library.components[node.componentId]?.key;
      const localId = key ? componentIdByKey.get(key) : undefined;
      if (localId) {
        node.componentId = localId;
        node.mainComponent = mainComponentOf(localId, consuming);
      } else {
        // No counterpart here: better unnamed than named wrong. The nested instance keeps its
        // children and simply isn't attributed — the same place an unpublished component lands.
        delete node.componentId;
        delete node.mainComponent;
      }
    }
    for (const child of node.children ?? []) translate(child);
  };
  for (const child of snapshot.children ?? []) translate(child);
  // Another page of the SAME file is this document's own reading of the component. Only a library
  // can hand back a version this document never adopted.
  return { ...snapshot, id: rootId, definitionUnverified: fromLibrary || undefined };
}
