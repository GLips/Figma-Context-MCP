// The one invariant of the reply path: a reply is a function of the handler's body plus the
// correlation id and the local routing tag — never of the inbound message's other fields. Pinned
// because the failure is SILENT: a field the sandbox consumes (here `scale`) riding back out would
// look exactly like metadata a newer server had attached, and nothing downstream would complain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replyTarget, replyEnvelope } from "./reply-envelope.js";

test("a reply carries nothing back from its request but the id and the routing key", () => {
  const inbound = {
    id: "req-7",
    type: "SCREENSHOT",
    nodeId: "1:2",
    scale: 2,
    sessionId: "abc-123",
    __connKey: 9876,
  };

  assert.deepEqual(replyEnvelope(replyTarget(inbound), { type: "SCREENSHOT_RESULT", image: "…" }), {
    type: "SCREENSHOT_RESULT",
    image: "…",
    id: "req-7",
    __connKey: 9876,
  });
});
