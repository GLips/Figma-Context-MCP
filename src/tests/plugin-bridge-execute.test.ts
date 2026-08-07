// The single-pass figma_execute_code outcome shaping (protocol 2): consent gate, reply parsing, and
// the stale-plugin tripwire — a pre-v2 plugin that answers with the retired two-pass sentinel must
// fail loud naming the re-import fix, never silently return an empty result.
import assert from "node:assert/strict";
import { executeAgentCode, type ExecuteDeps } from "~/services/plugin-bridge/execute.js";

const okReply = (result: unknown) => ({
  type: "EXECUTE_CODE_RESULT",
  result,
  console: [],
  errors: null,
});

const noGate: ExecuteDeps["gate"] = () => null;

test("a normal run returns the parsed reply after exactly one request", async () => {
  const codes: string[] = [];
  const outcome = await executeAgentCode("BODY", {
    request: async (code) => {
      codes.push(code);
      return okReply(42);
    },
    gate: noGate,
  });
  assert(outcome.kind === "reply");
  assert.equal(outcome.reply.result, 42);
  assert.deepEqual(codes, ["BODY"], "the code runs exactly once — there is no re-run path");
});

test("a consent-gated reply short-circuits without parsing", async () => {
  const gated = { content: [{ type: "text" as const, text: "pending approval" }] };
  const outcome = await executeAgentCode("code", {
    request: async () => ({ type: "PENDING_APPROVAL" }),
    gate: () => gated,
  });
  assert(outcome.kind === "gated");
  assert.equal(outcome.result, gated);
});

test("a pre-v2 plugin's imagesNeeded sentinel fails loud naming the re-import fix", async () => {
  const outcome = await executeAgentCode("code", {
    request: async () => ({
      type: "EXECUTE_CODE_RESULT",
      imagesNeeded: ["https://cdn.example.com/a.jpg"],
      console: [],
      errors: null,
    }),
    gate: noGate,
  });
  assert(outcome.kind === "error");
  assert.match(outcome.message, /out of date/);
  assert.match(outcome.message, /re-import/i);
  assert.match(outcome.message, /Nothing was rendered/);
});

test("a run error passes through as a parsed reply (the tool shapes it, not this layer)", async () => {
  const outcome = await executeAgentCode("code", {
    request: async () => ({
      type: "EXECUTE_CODE_RESULT",
      console: ["[log] hi"],
      errors: "Error: boom",
    }),
    gate: noGate,
  });
  assert(outcome.kind === "reply");
  assert.equal(outcome.reply.errors, "Error: boom");
  assert.equal(outcome.reply.result, undefined);
});
