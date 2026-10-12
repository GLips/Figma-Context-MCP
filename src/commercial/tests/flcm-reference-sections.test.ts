/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { INPUT_ALIASES } from "@framelink/plugin/schema";
import {
  buildFullReference,
  buildQuickStart,
  buildReferenceSections,
} from "~/commercial/tools/flcm-docs/reference.js";
import { CLI_DOCS_CHANNEL, MCP_DOCS_CHANNEL } from "~/commercial/tools/flcm-docs/channels.js";
import { describe, expect, it } from "vitest";

// The mental model used to ship only to a caller who named nothing, which is nobody who knows what
// they are doing. These two guard the delivery shape, not the prose: it must be reachable by name,
// and a nameless call must come back as a menu rather than a page of reference an agent didn't ask for.
describe("get_flcm_reference delivery", () => {
  it("refuses a call that names no sections, and points at mental-model", () => {
    const blank = buildReferenceSections(undefined, MCP_DOCS_CHANNEL);
    const empty = buildReferenceSections([], MCP_DOCS_CHANNEL);

    expect(blank).toBe(empty);
    expect(blank).toContain('get_flcm_reference(["mental-model"])');
    expect(blank).toContain("`verbs` — ");
    expect(blank).not.toContain("Nodes are plain JavaScript data");
  });

  it("serves the mental model to a caller that names it", () => {
    const body = buildReferenceSections(["mental-model"], MCP_DOCS_CHANNEL);

    expect(body).toContain("Nodes are plain JavaScript data");
    expect(body).toContain("Removing only the root id creates a new root");
    expect(body).toContain("Save specs, constants, SVG markup and looked-up ids in session");
  });
});

// A CLI reader has no MCP tools, so naming one sends it after something it cannot reach. Every
// section and the quick-start must come back in the reader's own channel.
const MCP_TOOL_NAMES =
  /get_figma_data|download_figma_images|get_figma_comments|figma_execute_code|get_flcm_reference|get_screenshot/;

it("never names an MCP tool to a CLI reader", () => {
  const mcp = buildFullReference(MCP_DOCS_CHANNEL);
  const cli = buildFullReference(CLI_DOCS_CHANNEL) + buildQuickStart(CLI_DOCS_CHANNEL);

  expect(mcp).toContain("get_screenshot");
  expect(cli).toContain("--screenshot");
  expect(cli).not.toMatch(MCP_TOOL_NAMES);
});

it("never documents an input alias", () => {
  const doc = buildFullReference(MCP_DOCS_CHANNEL) + buildFullReference(CLI_DOCS_CHANNEL);
  for (const rule of Object.values(INPUT_ALIASES)) {
    // fontSize is also the canonical nested text-style field.
    for (const key of rule.keys) if (key !== "fontSize") expect(doc).not.toContain(key);
  }
  expect(doc).toContain("| `fontSize` |");
});
