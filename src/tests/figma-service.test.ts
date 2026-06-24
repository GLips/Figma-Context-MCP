import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FigmaService } from "~/services/figma.js";

/**
 * Characterization tests for FigmaService's request/error path. These pin the
 * CURRENT behavior of endpoint construction, auth-header selection, and the
 * HTTP-status-to-message translation in `requestWithSize`. They mock the global
 * `fetch` (not `fetchJSON`) so the real fetch-json + error-meta flow runs
 * end-to-end — that's the layer that tags `http_status`, which FigmaService
 * branches on. Modeled on `http-header-auth.test.ts`.
 *
 * Error-message assertions deliberately match stable substrings, not full
 * strings: `src/services/errors/*` is designed to be reworded without a release.
 */

const figmaFileResponse = {
  name: "Test File",
  lastModified: "2026-01-01T00:00:00Z",
  thumbnailUrl: "",
  version: "1",
  document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [] },
  components: {},
  componentSets: {},
  schemaVersion: 0,
  styles: {},
};

describe("FigmaService request/error path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Configure the stubbed fetch to answer api.figma.com with a given response. */
  function stubFigmaResponse(makeResponse: () => Response) {
    const realFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.figma.com")) {
        return makeResponse();
      }
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  function firstRequestUrl(): string {
    return String(fetchMock.mock.calls[0][0]);
  }

  function firstRequestHeaders(): Record<string, string> {
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers?: Record<string, string> };
    return init.headers ?? {};
  }

  /** Await a promise expecting it to reject, and return the thrown Error. */
  async function captureError(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected promise to reject, but it resolved");
  }

  beforeEach(() => {
    stubFigmaResponse(() => Response.json(figmaFileResponse));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("endpoint construction", () => {
    it("builds the nodes endpoint for getRawNode", async () => {
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      await service.getRawNode("ABC", "1:2");

      expect(firstRequestUrl()).toContain("/files/ABC/nodes?ids=1:2");
    });

    it("appends depth to the nodes endpoint when provided", async () => {
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      await service.getRawNode("ABC", "1:2", 3);

      expect(firstRequestUrl()).toContain("/files/ABC/nodes?ids=1:2&depth=3");
    });

    it("builds the file endpoint for getRawFile", async () => {
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      await service.getRawFile("ABC");

      expect(firstRequestUrl()).toMatch(/\/files\/ABC$/);
    });

    it("appends depth to the file endpoint when provided", async () => {
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      await service.getRawFile("ABC", 2);

      expect(firstRequestUrl()).toContain("/files/ABC?depth=2");
    });
  });

  describe("auth headers", () => {
    it("sends X-Figma-Token when using a personal access token", async () => {
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      await service.getRawFile("ABC");

      expect(firstRequestHeaders()).toMatchObject({ "X-Figma-Token": "test-key" });
    });

    it("sends Authorization Bearer when using OAuth", async () => {
      const service = new FigmaService({
        figmaApiKey: "",
        figmaOAuthToken: "tok",
        useOAuth: true,
      });

      await service.getRawFile("ABC");

      expect(firstRequestHeaders()).toMatchObject({ Authorization: "Bearer tok" });
    });
  });

  describe("happy path return shape", () => {
    it("returns parsed data alongside a positive rawSize", async () => {
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      const { data, rawSize } = await service.getRawFile("ABC");

      expect(data).toMatchObject({ name: "Test File" });
      expect(rawSize).toBeGreaterThan(0);
    });
  });

  describe("error translation", () => {
    it("translates 429 into the rate-limit guidance message", async () => {
      stubFigmaResponse(
        () => new Response("rate limited body", { status: 429, statusText: "Too Many Requests" }),
      );
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      const error = await captureError(service.getRawNode("ABC", "1:2"));

      expect(error.message).toContain("Figma API rate limit hit (429).");
      expect(error.message).toContain("https://developers.figma.com/docs/rest-api/rate-limits/");
      expect(error.cause).toBeDefined();
    });

    it("translates 403 into the forbidden guidance message", async () => {
      stubFigmaResponse(
        () => new Response("forbidden body", { status: 403, statusText: "Forbidden" }),
      );
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      const error = await captureError(service.getRawNode("ABC", "1:2"));

      expect(error.message).toContain(
        "https://www.framelink.ai/docs/troubleshooting#cannot-access-file",
      );
      expect(error.message).toContain("returned 403 Forbidden");
      expect(error.message).toContain("forbidden body");
      expect(error.cause).toBeDefined();
    });

    it("translates other failures into the generic endpoint message", async () => {
      stubFigmaResponse(
        () =>
          new Response("server error body", { status: 500, statusText: "Internal Server Error" }),
      );
      const service = new FigmaService({
        figmaApiKey: "test-key",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      const error = await captureError(service.getRawNode("ABC", "1:2"));

      expect(error.message).toContain("Failed to make request to Figma API endpoint");
      expect(error.message).toContain("/files/ABC/nodes?ids=1:2");
      expect(error.cause).toBeDefined();
    });
  });

  describe("missing-auth guard", () => {
    it("rejects without making a request when no credentials are configured", async () => {
      const service = new FigmaService({
        figmaApiKey: "",
        figmaOAuthToken: "",
        useOAuth: false,
      });

      const error = await captureError(service.getRawFile("ABC"));

      expect(error.message).toContain("authentication is required");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
