// Bundle entry for the preamble. esbuild bundles this at format:'iife' + globalName:'flcm', so the
// whole module graph is wrapped in one IIFE that assigns a single `flcm` global — and ONLY the names
// re-exported here become members of it. Every internal helper (css/paint/effects/fonts/ir/bridge) is
// reachable from these roots and therefore included in the bundle, but stays closure-private inside the IIFE,
// invisible to (and uncollidable with) the agent's code that runs in the same eval scope. That
// isolation is why no internal helper needs a name prefix.
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
