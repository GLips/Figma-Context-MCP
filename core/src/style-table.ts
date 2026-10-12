import type { StyleTable, StyleValue } from "./types.js";
import { stableStringify } from "./utils.js";
import { sha1Hex } from "./sha1.js";

/**
 * The two StyleTable implementations — the seam that makes compression
 * separable from projection (Invariant 3).
 *
 * `createRefStyleTable` is the intern-then-compress form: values are hoisted
 * under content-addressed (sha1) keys and `project` emits refs. A named style
 * needs no key of its own — it is already a `{ style }` value on the node, so it
 * hoists by content when shared, like any value. `createInlineStyleTable` is
 * expanded mode: `project` emits the values themselves, nothing is hoisted, and
 * the hash is never touched.
 */

/** Compressing table: intern style values under deduplicating refs. */
export function createRefStyleTable(): StyleTable {
  const styles: Record<string, StyleValue> = {};
  // Reverse lookup: serialized style value → ref id. Scoped to this table,
  // i.e. to one projection.
  const refIdCache = new Map<string, string>();

  return {
    styles,
    /** Find an existing ref with the same value, or mint one. */
    intern(value, prefix) {
      const key = stableStringify(value);
      const existing = refIdCache.get(key);
      if (existing) return existing;

      // Content-addressed id so the same value yields the same id across runs, making
      // output byte-stable (the value→id cache already dedups within a single run).
      const fullHash = sha1Hex(key);

      // Truncated-hash collision guard. The 8-hex slice (32 bits) keeps refs short but
      // can alias two different style values. We reached here on a cache miss, so a
      // taken slot means a genuine collision — reusing the id would overwrite the
      // other value and every node referencing it would silently resolve to the wrong
      // style. Fall back to the full 40-hex hash, which cannot collide with any
      // truncated id (different length) and not with another full id (that would be
      // a sha1 collision of distinct values). Deterministic because projection order
      // is stable, so the same file reproduces the same ids.
      let refId = `${prefix}_${fullHash.slice(0, 8)}`;
      if (styles[refId] !== undefined) {
        refId = `${prefix}_${fullHash}`;
      }

      styles[refId] = value;
      refIdCache.set(key, refId);
      return refId;
    },
  };
}

/**
 * Expanded-mode table: hand every value straight back for inline emission.
 * Never reaches the hash; `styles` stays empty.
 */
export function createInlineStyleTable(): StyleTable {
  return {
    styles: {},
    intern(value) {
      return value;
    },
  };
}
