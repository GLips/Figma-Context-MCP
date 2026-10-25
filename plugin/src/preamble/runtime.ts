/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The public flcm verbs. sandbox.ts nests these exports beside session inside the preamble IIFE.
// Internal helpers remain closure-private, so their names cannot collide with agent declarations.
//
// Only these exports are visible to sandbox authors.
import * as valueSugar from "./value-sugar.js";
import * as read from "./read.js";
import * as components from "./component.js";
import * as editVerb from "./edit.js";
import * as editManyVerb from "./edit-many.js";
import * as structure from "./structure.js";
import * as pages from "./page.js";
import { designTokens as listDesignTokens } from "./design-tokens.js";
import { registerTokenEntry } from "./egress.js";
import { publicVerb } from "./flcm-error.js";
import type { TokenEntryKind } from "./token-mark.js";
import type { Flcm } from "./schema.js";

// Every verb is wrapped here and only here, so each failure names the call the agent wrote and
// points at the agent's line (publicVerb). A throw site states what went wrong, not which verb it
// is in.
const gradient = publicVerb("flcm.gradient", valueSugar.gradient);
const image = publicVerb("flcm.image", valueSugar.image);
const effects = publicVerb("flcm.effects", valueSugar.effects);
const get = publicVerb("flcm.get", read.get);
const find = publicVerb("flcm.find", read.find);
const findOne = publicVerb("flcm.findOne", read.findOne);
const selection = publicVerb("flcm.selection", read.selection);
const component = publicVerb("flcm.component", components.component);
const variants = publicVerb("flcm.variants", components.variants);
const edit = publicVerb("flcm.edit", editVerb.edit);
const editMany = publicVerb("flcm.editMany", editManyVerb.editMany);
const render = publicVerb("flcm.render", structure.render);
const append = publicVerb("flcm.append", structure.append);
const prepend = publicVerb("flcm.prepend", structure.prepend);
const insertBefore = publicVerb("flcm.insertBefore", structure.insertBefore);
const insertAfter = publicVerb("flcm.insertAfter", structure.insertAfter);
const remove = publicVerb("flcm.remove", structure.remove);
const clone = publicVerb("flcm.clone", structure.clone);
const measure = publicVerb("flcm.measure", structure.measure);
const replace = publicVerb("flcm.replace", structure.replace);
const detach = publicVerb("flcm.detach", structure.detach);
const page = {
  current: publicVerb("flcm.page.current", pages.page.current),
  use: publicVerb("flcm.page.use", pages.page.use),
  new: publicVerb("flcm.page.new", pages.page.new),
};

// Each listed entry is registered by identity, so it leaves the run marked for the server's token
// renderer wherever the agent returns it: whole, filtered, found, nested or edited in place. A copy the
// agent built is not registered and stays plain JSON. Identity lasts one run: an entry kept in session
// and returned by a later call is plain JSON there.
const designTokens = publicVerb("flcm.designTokens", (async (from?: unknown) => {
  // Every overload's listing has this shape; the cast spares re-deriving it from the overload set.
  const listing = (await listDesignTokens(from as never)) as { variables: object[]; styles?: object[] };
  const mark = (entries: object[] | undefined, kind: TokenEntryKind) => {
    for (const entry of entries ?? []) registerTokenEntry(entry, kind);
  };
  mark(listing.variables, "variable");
  mark(listing.styles, "style");
  return listing;
}) as typeof listDesignTokens);

export { detach, component, variants, render, gradient, image, effects, get, find, findOne, selection, edit, editMany, append, prepend, insertBefore, insertAfter, remove, clone, measure, replace, page, designTokens };

// Tier-1 drift guard, held at the one true public boundary: the exported surface must match the typed
// Flcm interface schema.ts derives docs and examples from — exhaustively, so a verb added to Flcm but
// not exported here (or exported with a drifted signature) fails plugin typecheck. `satisfies` checks
// without widening; the local is DCE'd from the bundle (pure init, unreferenced).
const _flcmSurface = { detach, component, variants, render, gradient, image, effects, get, find, findOne, selection, edit, editMany, append, prepend, insertBefore, insertAfter, remove, clone, measure, replace, page, designTokens } satisfies Flcm;
void _flcmSurface;
