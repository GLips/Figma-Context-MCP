import { afterEach, describe, expect, it, vi } from "vitest";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer, type ReadServerOptions } from "~/read.js";

const Jimp = createJimp({ formats: [png] });
const TOKEN = "figd_read_entry_test";

async function connect(options: Partial<ReadServerOptions> = {}) {
  const invalidate = vi.fn();
  const server = createReadServer({
    credentials: { resolve: async () => ({ kind: "pat", token: TOKEN }), invalidate },
    images: {
      kind: "destination",
      destination: {
        write: async ({ fileName }) => ({ kind: "url", url: `https://i.test/${fileName}` }),
      },
      retentionDays: 14,
    },
    ...options,
  });
  const client = new Client({ name: "read-entry-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, invalidate };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

describe("createReadServer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A file the account can't open is not a dead credential; dropping the host's cached copy on
  // every such 403 would turn one user's permission error into a credential refetch storm.
  it.each([
    { status: 401, err: "Unauthorized", invalidates: true },
    { status: 403, err: "Invalid token", invalidates: true },
    { status: 403, err: "File not exportable", invalidates: false },
  ])(
    "invalidates the credential on $status '$err': $invalidates",
    async ({ status, err, invalidates }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ status, err }, { status })),
      );
      const { client, invalidate } = await connect();

      const result = await client.callTool({
        name: "get_figma_comments",
        arguments: { fileKey: "abc" },
      });

      expect(result.isError).toBe(true);
      expect(invalidate).toHaveBeenCalledTimes(invalidates ? 1 : 0);
    },
  );

  it("refuses a raster whose header declares too many pixels, before decoding it", async () => {
    const big = await new Jimp({ width: 300, height: 200, color: 0xff0000ff }).getBuffer(
      "image/png",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://api.figma.com")
          ? Response.json({ images: { "1:2": "https://cdn.test/big.png" } })
          : new Response(new Uint8Array(big)),
      ),
    );
    const { client } = await connect({ limits: { image: { maxPixels: 10_000 } } });

    const result = await client.callTool({
      name: "download_figma_images",
      arguments: { fileKey: "abc", nodes: [{ nodeId: "1:2", fileName: "big.png" }] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("300x200, more pixels than this server decodes");
  });

  it("redacts the resolved credential from what a tool returns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`socket closed while sending X-Figma-Token: ${TOKEN}`);
      }),
    );
    const { client } = await connect();

    const result = await client.callTool({ name: "get_figma_data", arguments: { fileKey: "abc" } });

    expect(textOf(result)).toContain("[REDACTED]");
    expect(textOf(result)).not.toContain(TOKEN);
  });
});
