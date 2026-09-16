import { buildReferenceSections } from "~/mcp/tools/flcm-docs/reference.js";
import { describe, expect, it } from "vitest";

// The mental model used to ship only to a caller who named nothing, which is nobody who knows what
// they are doing. These two guard the delivery shape, not the prose: it must be reachable by name,
// and a nameless call must come back as a menu rather than a page of reference an agent didn't ask for.
describe("get_flcm_reference delivery", () => {
  it("refuses a call that names no sections, and points at mental-model", () => {
    const blank = buildReferenceSections();
    const empty = buildReferenceSections([]);

    expect(blank).toBe(empty);
    expect(blank).toContain('get_flcm_reference(["mental-model"])');
    expect(blank).toContain("`verbs` — ");
    expect(blank).not.toContain("Nodes are plain JavaScript data");
  });

  it("serves the mental model to a caller that names it", () => {
    const body = buildReferenceSections(["mental-model"]);

    expect(body).toContain("Nodes are plain JavaScript data");
    expect(body).toContain("Removing only the root id creates a new root");
    expect(body).toContain("Save specs, constants, SVG markup and looked-up ids in session");
  });
});
