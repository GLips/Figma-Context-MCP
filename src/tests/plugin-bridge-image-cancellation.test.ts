import { expect, it, vi } from "vitest";
import { fetch } from "undici";
import { fetchAndProcessImage } from "~/services/plugin-bridge/images.js";

// Keep the guarded source path; replace only DNS/network I/O with a held request.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("undici", async (original) => ({
  ...(await original<typeof import("undici")>()),
  fetch: vi.fn(),
}));

it("run cancellation aborts the active HTTP fetch rather than waiting for its timeout", async () => {
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  let rejectFetch!: (error: Error) => void;
  vi.mocked(fetch).mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        received = init?.signal;
        rejectFetch = reject;
        received?.addEventListener("abort", () => reject(received?.reason), { once: true });
      }),
  );
  const result = fetchAndProcessImage("https://example.com/slow.png", controller.signal).catch(
    (e) => e,
  );
  await new Promise((resolve) => setImmediate(resolve));
  try {
    expect(received?.aborted).toBe(false);
    controller.abort(new Error("run cancelled"));
    expect(received?.aborted).toBe(true);
    expect(String(await result)).toContain("run cancelled");
  } finally {
    rejectFetch(new Error("test cleanup"));
    await result;
  }
});
