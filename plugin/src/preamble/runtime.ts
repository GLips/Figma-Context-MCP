// Bundle entry for the preamble. esbuild bundles this at format:'iife' + globalName:'flcm', so the
// whole module graph is wrapped in one IIFE that assigns a single `flcm` global — and ONLY the names
// re-exported here become members of it. Every internal helper (css/paint/effects/fonts/ir/bridge) is
// reachable from these roots and therefore included in the bundle, but stays closure-private inside the IIFE,
// invisible to (and uncollidable with) the agent's code that runs in the same eval scope. That
// isolation is why no internal helper needs a name prefix.
//
// The agent calls `flcm.frame(...)`, `await flcm.render(...)`, etc. — these are the only public verbs.
export { frame, text, rect, ellipse, line, svg, path, render, gradient, image, effects, get, id } from "./flcm.js";
