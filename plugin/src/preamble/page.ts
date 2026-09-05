// page — the document-level verbs: which page am I on, switch to another, make a new one.
//
// Why these are flcm verbs rather than "just use figma.*": every session that builds something new
// starts by making a page, so the ONE operation nobody can avoid was the one operation the DSL
// didn't cover — and the raw path is booby-trapped. Under `documentAccess: "dynamic-page"` (our
// manifest) `figma.currentPage` is read-only, so the obvious `figma.currentPage = page` throws
// AFTER `figma.createPage()` on the line above has already committed, leaving an orphan page and an
// agent that can't see the canvas holding a half-done document op. Wrapping it costs three verbs and
// deletes that whole failure.
//
// Create and switch are deliberately SEPARATE words. A find-or-create `page("checkout")` would mint
// a page on a typo — silently doing the opposite of what was meant, which is the class of failure
// this DSL rejects everywhere else. `new` means new, `use` means it must already be there.
//
// No mutation lock: the lock's apply span is synchronous by type (so nothing interleaves between an
// entry seal and its commit) and the page switch is async, and an undo scaffold around a page
// create/switch is meaningless anyway — Figma's undo doesn't step over page navigation. Page verbs
// take effect immediately: switch, THEN render. A page switch racing a queued render (Promise.all)
// lands the render wherever the switch left the document.

import type { PageInfo, PageSummary } from "./ir.js";

// A page's identity as every page verb reports it — the same two fields a Figma page URL is built
// from, so an agent can hand `id` back to `use` or quote `name` to the human.
function summarize(page: PageNode): PageSummary {
  return { id: page.id, name: page.name };
}

function pages(): readonly PageNode[] {
  // Page STUBS are readable without loadAllPagesAsync under dynamic-page access — that call is only
  // needed to walk a non-current page's CONTENTS, which no page verb does.
  return figma.root.children;
}

function nameList(): string {
  return pages()
    .map((p) => JSON.stringify(p.name))
    .join(", ");
}

function assertPageName(verb: string, name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(
      "flcm.page." + verb + ": needs a page name (a non-empty string), got " + JSON.stringify(name) + ".",
    );
  }
  return name;
}

/**
 * Where am I? The orientation verb: the file, the page every unqualified verb acts on, and the
 * other pages by name — one answer to "did I land in the right document", which nothing else in
 * the surface could tell an agent that can't see the canvas.
 *
 * The page list rides along because it is a handful of short strings and because the alternative
 * (a separate list verb) means the only way to discover a page name is to guess one at `use` and
 * read the rejection.
 */
export async function pageCurrent(): Promise<PageInfo> {
  return {
    fileName: figma.root.name,
    page: summarize(figma.currentPage),
    pages: pages().map(summarize),
  };
}

/**
 * Switch to a page that already exists, by id or by name. A miss names every page in the file
 * rather than creating one — an agent working from a name it half-remembers gets the real list
 * back, which is a better answer than a new empty page.
 */
export async function pageUse(target: string): Promise<PageInfo> {
  const wanted = assertPageName("use", target);
  const all = pages();
  const byId = all.filter((p) => p.id === wanted);
  const byName = all.filter((p) => p.name === wanted);
  const hits = byId.length ? byId : byName;
  if (!hits.length) {
    throw new Error(
      "flcm.page.use: no page with id or name " + JSON.stringify(wanted) + " — this file has " +
        nameList() + ". flcm.page.new(name) makes one.",
    );
  }
  // Figma allows duplicate page names, so a name can be ambiguous where an id never is.
  if (hits.length > 1) {
    throw new Error(
      "flcm.page.use: " + hits.length + " pages are named " + JSON.stringify(wanted) +
        " — pass one of their ids instead: " + hits.map((p) => JSON.stringify(p.id)).join(", ") + ".",
    );
  }
  await figma.setCurrentPageAsync(hits[0]);
  return pageCurrent();
}

/**
 * Make a page and switch to it.
 *
 * Refuses when the name is already taken, which is what makes a retry safe: a call that crashed
 * after creating the page (or an agent that lost track of its own earlier call) re-runs into a
 * refusal naming the existing page instead of quietly minting a second one with the same name and
 * splitting the work across both. The name check happens BEFORE the create, so a refusal leaves
 * nothing behind.
 */
export async function pageNew(name: string): Promise<PageInfo> {
  const wanted = assertPageName("new", name);
  const taken = pages().find((p) => p.name === wanted);
  if (taken) {
    throw new Error(
      "flcm.page.new: this file already has a page named " + JSON.stringify(wanted) + " (id " +
        JSON.stringify(taken.id) + ") — flcm.page.use(name) switches to it, or pick another name. " +
        "Nothing was created.",
    );
  }
  const created = figma.createPage();
  created.name = wanted;
  await figma.setCurrentPageAsync(created);
  return pageCurrent();
}

// The `flcm.page` namespace. A namespace rather than three top-level verbs because these are the
// only words about the DOCUMENT rather than the design, and `page.new`/`page.use` read as the
// sentence the agent means. Property syntax, not method shorthand: `new(…)` in an interface is a
// construct signature, which is not what this is.
export const page = {
  current: pageCurrent,
  use: pageUse,
  new: pageNew,
};
