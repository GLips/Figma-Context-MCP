// A stand-in host for figma-developer-mcp/read, run by scripts/check-read-entry.mjs against the
// packed tarball in a scratch directory. It is typechecked there (strict, no skipLibCheck) and then
// executed: every request goes through a real Streamable HTTP transport, one server per POST.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createReadServer,
  type FigmaCredential,
  type ImageDestination,
  type ReadServerOptions,
  type ReadToolObservation,
} from "figma-developer-mcp/read";

const FIGMA_TOKEN = "figd_consumer_gate_secret";
// A 1x1 PNG, so the engine's header check and decode both run for real.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// The engine's outbound calls to Figma, answered locally. The MCP client keeps the real fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.figma.com" && url.pathname === "/v1/images/abc123") {
    assert.equal(new Headers(init?.headers).get("X-Figma-Token"), FIGMA_TOKEN);
    return Response.json({ images: { "1:2": "https://figma-cdn.test/render.png" } });
  }
  if (url.hostname === "figma-cdn.test") return new Response(PNG_1X1);
  throw new Error(`Unexpected engine fetch: ${url.href}`);
};

let credentialResolves = 0;
const observations: ReadToolObservation[] = [];
const destination: ImageDestination = {
  async write({ fileName, bytes, contentType }) {
    assert.equal(contentType, "image/png");
    assert.ok(bytes.byteLength > 0);
    return { kind: "url", url: `https://images.test/${fileName}` };
  },
};

function readServerOptions(signal: AbortSignal): ReadServerOptions {
  return {
    credentials: {
      async resolve(): Promise<FigmaCredential> {
        credentialResolves++;
        return { kind: "pat", token: FIGMA_TOKEN };
      },
      invalidate() {},
    },
    images: { kind: "destination", destination, retentionDays: 14 },
    signal,
    limits: {
      maxResponseBytes: 1024 * 1024,
      image: { maxBytes: 1024 * 1024, maxPixels: 4096 * 4096, maxConcurrent: 2 },
    },
    guardToolCall: (run) => run(),
    observe: (event) => observations.push(event),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const server = createReadServer(readServerOptions(controller.signal));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const http = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error);
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const { port } = http.address() as AddressInfo;

const client = new Client({ name: "read-entry-consumer", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { fetch: realFetch }),
);

try {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "download_figma_images",
    "get_figma_comments",
    "get_figma_data",
  ]);
  for (const tool of tools) {
    assert.deepEqual(
      tool.annotations && {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      `${tool.name} annotations`,
    );
  }
  const download = tools.find((tool) => tool.name === "download_figma_images")!;
  assert.ok(
    !("localPath" in (download.inputSchema.properties ?? {})),
    "destination mode has no localPath",
  );
  assert.equal(credentialResolves, 0, "initialize and tools/list must not resolve the credential");

  const result = await client.callTool({
    name: "download_figma_images",
    arguments: { fileKey: "abc123", nodes: [{ nodeId: "1:2", fileName: "hero.png" }] },
  });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assert.notEqual(result.isError, true, text);
  assert.match(text, /hero\.png: https:\/\/images\.test\/hero\.png \| 1x1/);
  assert.ok(!text.includes(FIGMA_TOKEN));
  assert.equal(credentialResolves, 1, "the first Figma call resolves the credential once");
  assert.deepEqual(
    observations.map(({ tool, outcome, imageCount, successCount }) => ({
      tool,
      outcome,
      imageCount,
      successCount,
    })),
    [{ tool: "download_figma_images", outcome: "ok", imageCount: 1, successCount: 1 }],
  );
  console.log(
    "Read entry consumer passed: 3 annotated read tools, lazy credential, URL image result.",
  );
} finally {
  await client.close();
  http.close();
}
