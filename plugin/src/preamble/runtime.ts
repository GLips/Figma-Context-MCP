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
import type { Flcm } from "./schema.js";

export { detach, component, variants, render, gradient, image, effects, get, find, findOne, selection, id, edit, editMany, append, prepend, insertBefore, insertAfter, remove, clone, measure, replace, page };

// Tier-1 drift guard, held at the one true public boundary: the exported surface must match the typed
// Flcm interface schema.ts derives docs and examples from — exhaustively, so a verb added to Flcm but
// not exported here (or exported with a drifted signature) fails plugin typecheck. `satisfies` checks
// without widening; the local is DCE'd from the bundle (pure init, unreferenced).
const _flcmSurface = { detach, component, variants, render, gradient, image, effects, get, find, findOne, selection, id, edit, editMany, append, prepend, insertBefore, insertAfter, remove, clone, measure, replace, page } satisfies Flcm;
void _flcmSurface;
