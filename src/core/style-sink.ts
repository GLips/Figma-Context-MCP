import type { StyleSink, StyleTypes } from "./types.js";
import type { NodeSnapshot, SnapshotStyleRef } from "./snapshot.js";
import { stableStringify } from "./utils.js";
import { sha1Hex } from "./sha1.js";

/**
 * The two StyleSink implementations — the seam that makes compression
 * separable from the walk (Invariant 3).
 *
 * `createRefStyleSink` reproduces the shipped register-then-finalize behavior:
 * values are hoisted under content-addressed (sha1) or named-style keys and
 * extractors emit refs. `createInlineStyleSink` is expanded mode: extractors
 * emit the values themselves, nothing is hoisted, and the hash is never
 * touched.
 */

export interface RefStyleSink extends StyleSink {
  /**
   * Keys in `styles` that are named Figma styles (vs. auto-generated
   * content-hash ids). The finalize pass keeps these hoisted even at a single
   * use, because a named style encodes design-system intent worth surfacing.
   * Collected during the walk because the post-walk pass can't otherwise tell
   * a named-style key apart from an auto-generated one by inspection.
   */
  readonly namedStyleKeys: Set<string>;
}

/** Compressing sink: register style values under deduplicating refs. */
export function createRefStyleSink(): RefStyleSink {
  const styles: Record<string, StyleTypes> = {};
  const namedStyleKeys = new Set<string>();
  // Reverse lookup: serialized style value → varId. Scoped to this sink, i.e.
  // to one extraction run.
  const varIdCache = new Map<string, string>();

  /** Find an existing style variable with the same value, or create one. */
  function findOrCreateVar(value: StyleTypes, prefix: string): string {
    const key = stableStringify(value);
    const existing = varIdCache.get(key);
    if (existing) return existing;

    // Content-addressed id so the same value yields the same id across runs, making
    // output byte-stable (the value→id cache already dedups within a single run).
    const fullHash = sha1Hex(key);

    // Truncated-hash collision guard. The 8-hex slice (32 bits) keeps refs short but
    // can alias two different style values. We reached here on a cache miss, so a
    // taken slot means a genuine collision — reusing the id would overwrite the
    // other value and every node referencing it would silently resolve to the wrong
    // style. Lengthen this value's id until the slot is free. Deterministic because
    // the walk order is stable, so the same file reproduces the same ids.
    let length = 8;
    let varId = `${prefix}_${fullHash.slice(0, length)}`;
    while (styles[varId] !== undefined && length < fullHash.length) {
      length += 4;
      varId = `${prefix}_${fullHash.slice(0, length)}`;
    }

    styles[varId] = value;
    varIdCache.set(key, varId);
    return varId;
  }

  // Figma style names aren't unique — a file can use a local style and an imported
  // library style that share a name (e.g., "Heading / Large"). Collapse same-name
  // same-value entries; disambiguate same-name different-value by appending the id.
  function resolveStyleKey(styleMatch: SnapshotStyleRef, value: StyleTypes): string {
    const existing = styles[styleMatch.name];
    if (!existing) return styleMatch.name;
    if (stableStringify(existing) === stableStringify(value)) return styleMatch.name;

    return `${styleMatch.name} (${styleMatch.id})`;
  }

  return {
    styles,
    namedStyleKeys,
    // Prefer a Figma named style when the node carries one; fall back to an
    // auto-generated deduplicating variable id.
    register(node, value, styleKeys, prefix) {
      const styleMatch = getStyleMatch(node, styleKeys);
      if (styleMatch) {
        const styleKey = resolveStyleKey(styleMatch, value);
        styles[styleKey] = value;
        // Mark as a named style so the finalize pass keeps it hoisted even if only
        // one node uses it — a named Figma style is design-system intent, not noise.
        namedStyleKeys.add(styleKey);
        return styleKey;
      }
      return findOrCreateVar(value, prefix);
    },
  };
}

/**
 * Expanded-mode sink: hand every value straight back for inline emission.
 * Never reaches the hash; `styles` stays empty.
 */
export function createInlineStyleSink(): StyleSink {
  return {
    styles: {},
    register(_node, value) {
      return value;
    },
  };
}

// Fetch the resolved named-style ref for the first matching style slot. The
// adapter already joined `node.styles` with the top-level table (see
// src/adapters/rest/node-to-snapshot.ts), so this is a plain per-slot lookup —
// the wire style table never reaches here (Invariant 2).
function getStyleMatch(node: NodeSnapshot, keys: string[]): SnapshotStyleRef | undefined {
  if (!node.styles) return undefined;
  for (const key of keys) {
    const match = node.styles[key];
    if (match) return match;
  }
  return undefined;
}
