/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// figma_execute_code's reply text: designTokens entries the preamble marked render as token lines, and
// everything else stays compact JSON. The marking itself is pinned plugin-side (read-egress.test.ts).
import { describe, expect, it } from "vitest";
import { TOKEN_ENTRY_MARK } from "@framelink/plugin/token-mark";
import { formatExecuteCodeReply, withoutTokenMarks } from "~/commercial/tools/token-tree.js";

const variable = (entry: Record<string, unknown>) => ({ ...entry, [TOKEN_ENTRY_MARK]: "variable" });
const style = (entry: Record<string, unknown>) => ({ ...entry, [TOKEN_ENTRY_MARK]: "style" });

const brand = variable({
  reference: { variable: "color/brand" },
  collection: "Brand",
  type: "COLOR",
  values: { Light: "#2D4024", Dark: "rgba(255, 255, 255, 0.5)" },
});
const action = variable({
  reference: { variable: "color/action" },
  collection: "Brand",
  type: "COLOR",
  values: { Light: { variable: "color/brand" }, Dark: { variable: "color/brand" } },
  scopes: ["FRAME_FILL"],
});
const label = variable({
  reference: { variable: { id: "VariableID:1:9", name: "label" } },
  collection: "Copy",
  type: "STRING",
  values: { Default: "12" },
  remote: true,
});

describe("figma_execute_code reply text", () => {
  it("renders a token listing as one line per token, grouped by library and collection", () => {
    const text = formatExecuteCodeReply({
      result: {
        variables: [brand, action, label],
        styles: [
          style({ reference: { style: "Heading/L" }, type: "TEXT", value: { fontSize: 32 } }),
        ],
        libraries: [{ name: "Brand Kit", collections: [{ name: "Colors", variables: 120 }] }],
      },
      console: ["listed"],
      errors: null,
    });
    expect(text).toBe(
      [
        "result:",
        "  variables:",
        "    [LOCAL]",
        '      [COLLECTION] "Brand" modes=["Light","Dark"]',
        '        [COLOR] "color/brand" #2D4024 "rgba(255, 255, 255, 0.5)"',
        '        [COLOR] "color/action" {"variable":"color/brand"} {"variable":"color/brand"} scopes=["FRAME_FILL"]',
        "    [REMOTE]",
        '      [COLLECTION] "Copy" modes=["Default"]',
        // A string that would read as a number stays quoted.
        '        [STRING] "label" #VariableID:1:9 "12"',
        "  styles:",
        '    [TEXT] "Heading/L" value={"fontSize":32}',
        '  libraries: [{"name":"Brand Kit","collections":[{"name":"Colors","variables":120}]}]',
        'console: ["listed"]',
        "errors: null",
      ].join("\n"),
    );
  });

  it("renders entries in place inside other data, and leaves unmarked look-alikes as JSON", () => {
    const lookalike = withoutTokenMarks(brand);
    const reply = {
      result: { picked: [action, "note"], mine: lookalike },
      console: [],
      errors: null,
    };
    expect(formatExecuteCodeReply(reply)).toBe(
      [
        "result:",
        "  picked:",
        '    [COLLECTION] "Brand" modes=["Light","Dark"]',
        '      [COLOR] "color/action" {"variable":"color/brand"} {"variable":"color/brand"} scopes=["FRAME_FILL"]',
        '    - "note"',
        `  mine: ${JSON.stringify(lookalike)}`,
        "console: []",
        "errors: null",
      ].join("\n"),
    );
    // The CLI keeps its JSON contract: same data, marks dropped.
    expect(JSON.stringify(withoutTokenMarks(reply))).not.toContain(TOKEN_ENTRY_MARK);
  });
});
