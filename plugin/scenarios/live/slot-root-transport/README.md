# Current slot root transport investigation

`setup.js` uses the current data-tree API and creates one retained fixture frame on the current page, with four independent warm-read INSTANCE roots imported into slots, recording both original and remapped IDs. It records complete warm reads before any movement, original IDs and destinations. It does not move roots or remove fixtures.

Run one transport case at a time in a separate execution, saving the envelope and independently reading the exact recorded fixture afterwards. Compare native appendChild, native insertChild, `flcm.append(destination, { id: root })`, and a native temporary group transported then ungrouped. The group route tests identity-preserving native reparenting without cloning; it is a hypothesis, not a product workaround yet. A thrown getter is not evidence that the placement did not happen. Do not replay an ambiguous execution or clone-replace the source to disguise identity loss. Preserve text overrides, hidden children, master identity, dimensions and sibling order in readback.

This fixture uses the current API syntax; the September archive preserves the earlier probes. Setup and the product move were verified live on October 2, as recorded below.

## October 2 results

Current CLI successfully created fixture `5071:2647` on the existing page. Persisted approval was reused. See `evidence-2026-10-02.json` for exact IDs and independent readbacks.

- Native append with the original ordinary root handle succeeded. Fresh evaluation confirms identity, 180×120 dimensions, text and hidden child preserved at the destination.
- Native insert with the indexed compound root handle also succeeded in the canvas. A fresh evaluation resolves the original ordinary ID and confirms complete readable contents and an empty source slot.
- The temporary-group candidate failed at ungroup because its pre-move compound GROUP handle no longer exists. A further evaluation still obtained an invalid GROUP handle from destination.children; it refused before any cleanup or product-case operation. That isolated wrapper is retained as evidence. This route is not recommended as a fix.
- The unchanged imported controls reproduce stale raw descendant getters while current flcm reads work. Thus the established descendant-access fix remains necessary.
- Following explicit user approval, the product case reproduced a stale-handle failure in `set_layoutGrow` after placement. Independent readback confirmed rollback restored the source and left the destination empty.
- After the shared-access fix, the same verified-restored case passed. Independent readback confirmed original root `5071:2673`, master `5071:2651`, 180×120 dimensions, original visible/hidden text IDs and contents, empty source, and correct destination membership. No clone substitution or temporary group is used by the fix.

## Fix and coverage

The shared scene-access boundary now refreshes a transported view from the destination's direct children by exact known ID after append/insert, before subsequent setters or layout settling can reuse a retired compound handle. Previously indexed descendants are refreshed in the moved subtree. Fresh unindexed nodes skip this work; the destination subtree is never indexed for this transition. Missing identity refuses rather than guessing by name or position.

The regression tests exercise both append and insert, retained child handles, setters, identity and parent links; they fail if the destination subtree is scanned. Full plugin suite: 482 passed. Plugin typecheck and current CLI build passed. These current tests resolve the reproduced slot root move-out failure. Plugin-reopen transport was not repeated in this run; the separate native group experiment remains a failed candidate, preserved inside the disposable fixture.
