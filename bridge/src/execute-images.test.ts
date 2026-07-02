// The execute_code two-pass image state machine (Phase 3.2). Its branches are non-obvious and could regress
// silently — the one-rerun cap, the fetch-fails-before-any-rerun abort, and the "injection channel didn't
// take" error that stops a fetch/re-run loop dead. Driven here with fake bridge/gate/fetch seams so the
// orchestration is pinned without a live plugin or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeWithImages, injectImageBytes, type ExecuteDeps } from "./execute-images.js";

const okReply = (result: unknown) => ({ type: "EXECUTE_CODE_RESULT", result, console: [], errors: null });
const needReply = (urls: string[]) => ({ type: "EXECUTE_CODE_RESULT", imagesNeeded: urls, console: [], errors: null });

// A scripted bridge: returns the next queued reply per request and records every code string it ran.
function scriptedRequest(replies: unknown[]): { request: ExecuteDeps["request"]; codes: string[] } {
  const codes: string[] = [];
  let i = 0;
  return {
    codes,
    request: async (code) => {
      codes.push(code);
      return replies[i++];
    },
  };
}

const noGate: ExecuteDeps["gate"] = () => null;

test("no image fills: returns the reply after a single run", async () => {
  const { request, codes } = scriptedRequest([okReply(42)]);
  const outcome = await executeWithImages("code", { request, gate: noGate, fetchImage: async () => "x" });
  assert.equal(outcome.kind, "reply");
  assert.equal(codes.length, 1, "no re-run when nothing is needed");
});

test("images needed: fetches each url, injects bytes, re-runs the same code exactly once", async () => {
  const { request, codes } = scriptedRequest([needReply(["u1", "u2"]), okReply("done")]);
  const fetched: string[] = [];
  const outcome = await executeWithImages("BODY", {
    request,
    gate: noGate,
    fetchImage: async (url) => {
      fetched.push(url);
      return `b64(${url})`;
    },
  });
  assert.equal(outcome.kind, "reply");
  assert.deepEqual(fetched.sort(), ["u1", "u2"]);
  assert.equal(codes.length, 2, "exactly one re-run");
  // The re-run carries the injected bytes ahead of the original body.
  assert.match(codes[1], /^globalThis\.__flcmImageBytes = /);
  assert.match(codes[1], /b64\(u1\)/);
  assert.ok(codes[1].endsWith("BODY"));
});

test("a fetch failure fails loud and aborts BEFORE any re-run", async () => {
  const { request, codes } = scriptedRequest([needReply(["bad"]), okReply("unreached")]);
  const outcome = await executeWithImages("code", {
    request,
    gate: noGate,
    fetchImage: async () => {
      throw new Error("flcm.image could not load \"bad\": blocked range");
    },
  });
  assert(outcome.kind === "error");
  assert.match(outcome.message, /blocked range/);
  assert.equal(codes.length, 1, "no re-run after a fetch failure");
});

test("a still-needed re-run reports the injection channel failure — never a second re-run", async () => {
  // Both runs report images needed (e.g. globalThis not writable in the sandbox). Capped at one re-run.
  const { request, codes } = scriptedRequest([needReply(["u1"]), needReply(["u1"])]);
  const outcome = await executeWithImages("code", { request, gate: noGate, fetchImage: async () => "b64" });
  assert(outcome.kind === "error");
  assert.match(outcome.message, /injection channel did not take/);
  assert.equal(codes.length, 2, "still capped at one re-run even when unresolved");
});

test("too many image urls in one run fails loud without fetching or re-running", async () => {
  const many = Array.from({ length: 65 }, (_, i) => `u${i}`);
  const { request, codes } = scriptedRequest([needReply(many), okReply("unreached")]);
  let fetches = 0;
  const outcome = await executeWithImages("code", {
    request,
    gate: noGate,
    fetchImage: async () => {
      fetches++;
      return "b64";
    },
  });
  assert(outcome.kind === "error");
  assert.match(outcome.message, /over the 64 cap/);
  assert.equal(fetches, 0, "no fetch when over the count cap");
  assert.equal(codes.length, 1, "no re-run when over the count cap");
});

test("a gated first run short-circuits without fetching or re-running", async () => {
  const { request, codes } = scriptedRequest([{ type: "PENDING_APPROVAL" }]);
  const gated = { content: [{ type: "text" as const, text: "approve me" }] };
  let fetches = 0;
  const outcome = await executeWithImages("code", {
    request,
    gate: () => gated,
    fetchImage: async () => {
      fetches++;
      return "x";
    },
  });
  assert.equal(outcome.kind, "gated");
  assert.equal(fetches, 0);
  assert.equal(codes.length, 1);
});

test("injectImageBytes assigns the bytes global ahead of the original code", () => {
  const injected = injectImageBytes("flcm.render(x)", { "https://x/a.png": "QUJD" });
  assert.ok(injected.startsWith("globalThis.__flcmImageBytes = "));
  assert.ok(injected.endsWith("flcm.render(x)"));
  // The assignment is valid JS: parse the object literal back out and check the bytes survived.
  const literal = injected.slice("globalThis.__flcmImageBytes = ".length, injected.indexOf(";\n"));
  assert.deepEqual(JSON.parse(literal), { "https://x/a.png": "QUJD" });
});
