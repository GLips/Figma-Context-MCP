# Slot access: verified fix and remaining limits

Committed as `4a295eb`. The reproduced descendant-access failure is fixed: an instance can be inspected, moved into a slot, and then read, searched, measured and edited using its original child handles. Independent native readback confirmed the text edit, hidden sibling, component linkage and 180×120 root size.

The dialect now gets native objects and ordered relationships through one shared scene-access boundary. Raw user Figma code is unchanged. No clone substitution or exception-triggered alternative reader is used. Native root mappings also keep tested old child handles usable after plugin reopen.

## Verification

- 424 plugin tests,115 core tests, typecheck and bridge contract passed.
- Exact healthy output equality across 1,011 emitted descendants and 150 query matches.
- Equivalent public-operation sample medians: full get1868ms original/1734ms new; query1662/1814ms (about9% slower); scoped read201/203ms. Twenty targeted measurements had no consistent added cost. Samples vary; these are fixture results, not a universal speed guarantee.
- Page enumeration worked with 96 pages without indexing the entire document.
- Primary warm import→read/search/measure/edit passed in the product runtime and independent readback.

## Root transport resolved October 2

Current-runtime controls showed that moving an indexed instance root out of a slot preserves the actual instance, but retires its old compound native handle. The product then failed while settling layout through that handle. The shared scene-access boundary now refreshes the moved node and previously acquired descendants from the destination before subsequent writes.

The exact failing product case passed after this change. Independent readback preserved the original root ID, component linkage, 180×120 dimensions, visible and hidden text, and source/destination membership. Both append and insert have focused regressions; all 482 plugin tests and plugin typecheck passed. [Durable reproduction and evidence](plugin/scenarios/live/slot-root-transport/README.md) supersede the missing temporary September artifacts for this failure.

Plugin-reopen transport was not repeated in this October run. A separate native temporary-group transport candidate failed on an invalidated GROUP handle and was not used in the product fix.

## Other historical limits

An optional reorder/constructed-variant probe hit a native connection error. Final readback confirmed unchanged order and preserved content, but that probe did not complete. It is not a passing result.

The earlier page-switch stall also remains unexplained. These limits remain distinct from the verified descendant-access fix.

[Detailed evidence and scripts](/tmp/figma-scene-access-proof/status.md).
