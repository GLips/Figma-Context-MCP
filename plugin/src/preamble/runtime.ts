/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The public flcm verbs. sandbox.ts nests these exports beside session inside the preamble IIFE.
// Internal helpers remain closure-private, so their names cannot collide with agent declarations.
//
// Only these exports are visible to sandbox authors.
import { gradient, image, effects, get, find, findOne, selection, id } from "./flcm.js";
import { render } from "./render.js";
import { detach } from "./instance.js";
import { component, variants } from "./component.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { append, prepend, insertBefore, insertAfter, remove, clone, measure, replace } from "./structure.js";
import { page } from "./page.js";
import { designTokens as listDesignTokens } from "./design-tokens.js";
import { registerRead } from "./host.js";
import { TOKEN_ENTRY_MARK, type TokenEntryKind } from "./token-mark.js";
import type { Flcm } from "./schema.js";

// Each listed entry is registered by identity, so it leaves the run marked for the server's token
// renderer wherever the agent returns it: whole, filtered, found or nested. A copy the agent built is
// not registered and stays plain JSON.
const designTokens = (async (from?: unknown) => {
  // Every overload's listing has this shape; the cast spares re-deriving it from the overload set.
  const listing = (await listDesignTokens(from as never)) as { variables: object[]; styles?: object[] };
  const mark = (entries: object[] | undefined, kind: TokenEntryKind) => {
    for (const entry of entries ?? []) registerRead(entry, () => ({ ...entry, [TOKEN_ENTRY_MARK]: kind }));
  };
  mark(listing.variables, "variable");
  mark(listing.styles, "style");
  return listing;
}) as typeof listDesignTokens;

export { detach, component, variants, render, gradient, image, effects, get, find, findOne, selection, id, edit, editMany, append, prepend, insertBefore, insertAfter, remove, clone, measure, replace, page, designTokens };

// Tier-1 drift guard, held at the one true public boundary: the exported surface must match the typed
// Flcm interface schema.ts derives docs and examples from — exhaustively, so a verb added to Flcm but
// not exported here (or exported with a drifted signature) fails plugin typecheck. `satisfies` checks
// without widening; the local is DCE'd from the bundle (pure init, unreferenced).
const _flcmSurface = { detach, component, variants, render, gradient, image, effects, get, find, findOne, selection, id, edit, editMany, append, prepend, insertBefore, insertAfter, remove, clone, measure, replace, page, designTokens } satisfies Flcm;
void _flcmSurface;
