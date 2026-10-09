import { describe, expect, test } from "bun:test";
import { buildTrialPrompt, CRAFT_FRAMING, renderPrompt } from "../scripts/lib/prompt.ts";
import { parseTranscriptStats } from "../scripts/lib/transcript-stats.ts";
import { parseTrial } from "../scripts/lib/trial.ts";

const TRIAL = `---
surface: edit
needs: pricing-page
---
## Brief
Change the page "{source}" and put it on "{page}".

## Follow-up
Now make it green.

## Rubric
- Looks good.
`;

describe("parseTrial", () => {
  test("reads frontmatter and the three sections", () => {
    const t = parseTrial(TRIAL, "x", "/x.md");
    expect(t.surface).toBe("edit");
    expect(t.needs).toBe("pricing-page");
    expect(t.brief).toContain("{source}");
    expect(t.followUp).toBe("Now make it green.");
    expect(t.rubric).toBe("- Looks good.");
  });

  test("rejects a trial without a brief or with a bad surface", () => {
    expect(() => parseTrial("---\nsurface: nope\n---\n## Brief\nx", "x", "/x")).toThrow(/surface/);
    expect(() => parseTrial("---\nsurface: create\n---\n## Rubric\nx", "x", "/x")).toThrow(/Brief/);
  });
});

describe("renderPrompt", () => {
  const vars = { page: "P 2026-01-01 10:00", source: "S", renders: "/r" };

  test("substitutes placeholders and appends craft framing only on craft", () => {
    expect(renderPrompt("on {page} from {source} into {renders}", vars)).toBe(
      "on P 2026-01-01 10:00 from S into /r",
    );
    expect(buildTrialPrompt({ brief: "b", track: "ergo", vars })).toBe("b");
    expect(buildTrialPrompt({ brief: "b", track: "craft", vars })).toBe(`b\n\n${CRAFT_FRAMING}`);
  });

  test("fails loudly on an unresolved placeholder", () => {
    expect(() => renderPrompt("see {file}", vars)).toThrow(/figmaFileUrl/);
    expect(() => renderPrompt("see {source}", { page: "p", renders: "/r" })).toThrow(/needs/);
  });
});

describe("parseTranscriptStats", () => {
  test("counts tool calls by name and error results", () => {
    const tail = [
      "#3    10:00:01  assistant tool_use mcp__framelink-mcp__figma_execute_code",
      "  keys: code",
      "",
      "#4    10:00:02  user      tool_result ↳#3",
      "  [error] Timeout after 60s",
      "",
      "#5    10:00:03  assistant tool_use mcp__framelink-mcp__figma_execute_code",
      "  keys: code",
      "",
      "#6    10:00:04  user      tool_result ↳#5",
      "  ok",
      "",
      "#7    10:00:05  assistant tool_use mcp__framelink-mcp__get_screenshot",
      "  keys: nodeId",
      "",
    ].join("\n");
    expect(parseTranscriptStats(tail)).toEqual({
      toolCalls: {
        "mcp__framelink-mcp__figma_execute_code": 2,
        "mcp__framelink-mcp__get_screenshot": 1,
      },
      toolErrors: 1,
    });
  });
});
