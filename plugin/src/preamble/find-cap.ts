/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The predicate materialization cap, in its own figma-free, zod-free module so the server's docs
// (narrative.ts) import the number read.ts enforces instead of restating it.
//
// A predicate-only find makes every rendered node a candidate, so without a ceiling it would silently
// churn a whole real design; past the cap it fails loud, naming the number. The cap is on CANDIDATES,
// checked before any simplify. It is deliberately high and tunable: if materialization is too slow at
// this scale, the fix is the algorithm, not a lower cap.

/** The most query survivors `flcm.find`'s predicate is offered before the call fails loud. */
export const FIND_MATERIALIZE_CAP = 5000;
