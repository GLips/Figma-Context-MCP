import { z } from "zod";

// Owns the whole figma_execute_code orchestration — the reply schema, consent gating, and result
// shaping — not just images; the two-pass IMAGE path (fetch bytes server-side, inject, re-run once)
// is the interesting case, and holding it here with its bridge/gate/fetch seams injected makes that
// state machine testable off-network. The code-mode tool registration wires the real seams.

// Bound on distinct image urls one figma_execute_code call may request, and on how many fetch/decode concurrently
// — the pair caps peak server memory (each in-flight fetch holds a decoded raster) to FETCH_CONCURRENCY
// rasters regardless of how many the agent's code asks for.
const MAX_IMAGES_PER_RUN = 64;
const FETCH_CONCURRENCY = 4;

// The plugin always replies with this exact shape; parse it once so callers trust the type instead of
// re-checking each field. `result` is absent when the code returns nothing or throws: undefined isn't JSON,
// so it's dropped crossing the WS — optional, not required (a missing key is the error/void path).
// `imagesNeeded` is the two-pass image request: flcm.render() throws its "images needed" sentinel BEFORE
// creating any node when the server hasn't injected bytes yet, and code.ts surfaces the urls here. Present
// only on that first pass; absent (or null) on a normal result.
export const ExecuteCodeReply = z.object({
  result: z.unknown().optional(),
  console: z.array(z.string()),
  errors: z.string().nullable(),
  imagesNeeded: z.array(z.string()).nullish(),
});

export type ExecuteCodeReplyT = z.infer<typeof ExecuteCodeReply>;

export type GatedResult = { content: { type: "text"; text: string }[] };

export type ExecuteOutcome =
  | { kind: "gated"; result: GatedResult }
  | { kind: "reply"; reply: ExecuteCodeReplyT }
  | { kind: "error"; message: string };

// The seams executeWithImages drives, injected so the two-pass state machine is testable without a live
// bridge or the network: `request` runs code in the sandbox, `gate` maps a consent refusal to its
// agent-facing text (or null), `fetchImage` is the guarded server-side fetch (fetchAndProcessImage).
export interface ExecuteDeps {
  request: (code: string) => Promise<unknown>;
  gate: (reply: unknown) => GatedResult | null;
  fetchImage: (url: string) => Promise<string>;
}

// Prepend the fetched image bytes as a `globalThis.__flcmImageBytes` assignment ahead of the agent's code,
// so the re-run's flcm.render() finds them (the preamble reads that global; see flcm.ts injectedImageBytes).
// The assignment lands inside the same async IIFE the executor wraps the code in, before render() runs.
//
// U+2028/U+2029 are valid in a JSON string but were illegal in a JS string literal pre-ES2019, and the
// sandbox's engine is old — so escape them, or a url carrying one would break the eval. base64 never
// contains them; a url key theoretically could. This is the ONE injection line the live-grounding checkbox
// covers: if globalThis is absent/read-only in the real QuickJS sandbox, only this line needs to change.
export function injectImageBytes(code: string, bytes: Record<string, string>): string {
  const literal = JSON.stringify(bytes)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `globalThis.__flcmImageBytes = ${literal};\n${code}`;
}

/**
 * The two-pass image path. The first run returns `imagesNeeded` when the agent's code fills anything with
 * flcm.image(url) — flcm.render() throws its sentinel before creating any node, so re-running is safe (pure
 * flcm builds an inert tree then renders; nothing has run twice). We fetch+validate+downscale each url
 * server-side (the sandbox reaches no network), inject the bytes, and re-run the SAME code exactly once.
 *
 * Capped at one re-run: a well-behaved re-run has every url present, so render() proceeds. A second
 * `imagesNeeded` means the injection channel didn't take (e.g. globalThis not writable in the real
 * sandbox — the live-grounding gap) — surfaced as a loud error, never a fetch/re-run loop. A fetch failure
 * (blocked range, oversize, non-image, unreachable) also fails loud, naming the url, per the plan's
 * "an unfetchable, blocked, or invalid URL fails loud."
 */
export async function executeWithImages(code: string, deps: ExecuteDeps): Promise<ExecuteOutcome> {
  const raw = await deps.request(code);
  const gated = deps.gate(raw);
  if (gated) return { kind: "gated", result: gated };
  const reply = ExecuteCodeReply.parse(raw);
  if (!reply.imagesNeeded || reply.imagesNeeded.length === 0) return { kind: "reply", reply };

  // Cap how many images one code blob can request. Each fetch decodes a raster server-side, so an unbounded
  // url list is a memory-amplification knob; over the cap, fail loud and tell the agent to split the work.
  if (reply.imagesNeeded.length > MAX_IMAGES_PER_RUN) {
    return {
      kind: "error",
      message:
        `flcm.image: ${reply.imagesNeeded.length} distinct image urls requested in one figma_execute_code call, over ` +
        `the ${MAX_IMAGES_PER_RUN} cap — split the build across calls.`,
    };
  }

  // Fetch every requested url up front; a single failure aborts before any re-run, so a blocked/oversize
  // url never renders as a blank fill. urls are already deduped by render() (Set) before they reach here.
  // Bounded concurrency, not Promise.all: it caps peak decode memory (each fetch holds a raster) to the
  // limit rather than to the full url count.
  const bytes: Record<string, string> = {};
  try {
    await mapWithConcurrency(reply.imagesNeeded, FETCH_CONCURRENCY, async (url) => {
      bytes[url] = await deps.fetchImage(url);
    });
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const rerun = await deps.request(injectImageBytes(code, bytes));
  const rerunGated = deps.gate(rerun);
  if (rerunGated) return { kind: "gated", result: rerunGated };
  const rerunReply = ExecuteCodeReply.parse(rerun);
  if (rerunReply.imagesNeeded && rerunReply.imagesNeeded.length > 0) {
    return {
      kind: "error",
      message:
        "flcm.image: the server fetched the image bytes but the sandbox still reported them missing after " +
        "re-running — the globalThis.__flcmImageBytes injection channel did not take in this Figma runtime. " +
        `Unresolved: ${rerunReply.imagesNeeded.join(", ")}.`,
    };
  }
  return { kind: "reply", reply: rerunReply };
}

// Run `fn` over `items` with at most `limit` in flight at once. `limit` workers pull from a shared cursor
// until the list is drained; the first rejection propagates through Promise.all (in-flight peers finish, but
// the caller's try/catch already owns the failure). Small local helper — no need for a concurrency dep.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      await fn(items[cursor++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
