# Slot access: verified fix and remaining limits

Committed as `4a295eb`. The reproduced descendant-access failure is fixed: an instance can be inspected, moved into a slot, and then read, searched, measured and edited using its original child handles. Independent native readback confirmed the text edit, hidden sibling, component linkage and 180×120 root size.

The dialect now gets native objects and ordered relationships through one shared scene-access boundary. Raw user Figma code is unchanged. No clone substitution or exception-triggered alternative reader is used. Native root mappings also keep tested old child handles usable after plugin reopen.

## Verification

- 424 plugin tests,115 core tests, typecheck and bridge contract passed.
- Exact healthy output equality across 1,011 emitted descendants and 150 query matches.
- Equivalent public-operation sample medians: full get1868ms original/1734ms new; query1662/1814ms (about9% slower); scoped read201/203ms. Twenty targeted measurements had no consistent added cost. Samples vary; these are fixture results, not a universal speed guarantee.
- Page enumeration worked with 96 pages without indexing the entire document.
- Primary warm import→read/search/measure/edit passed in the product runtime and independent readback.

## Still open

Moving an already remapped instance root OUT of a slot can invalidate even native indexed root access. This reproduces through raw Figma. The product operation rolled back; the isolated raw experiment was restored and independently checked. This is not claimed fixed.

An optional reorder/constructed-variant probe hit a native connection error. Final readback confirmed unchanged order and preserved content, but that probe did not complete. It is not a passing result.

The earlier page-switch stall also remains unexplained. These limits remain distinct from the verified descendant-access fix.

[Detailed evidence and scripts](/tmp/figma-scene-access-proof/status.md).
