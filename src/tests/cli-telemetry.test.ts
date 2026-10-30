import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createCliCommandContext } from "~/commands/cli-context.js";
import { runFetch } from "~/commands/fetch.js";
import { createServer } from "~/mcp/index.js";
import { closeTelemetry, initTelemetry } from "~/telemetry/index.js";
import { stubPostHogNetwork } from "./fixtures/posthog-network.js";

// Figma and PostHog are the boundaries; the command, the tool and telemetry run for real.
const FILE = {
  name: "Parity",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        name: "Page",
        type: "CANVAS",
        children: [{ id: "1:2", name: "Card", type: "FRAME", children: [] }],
      },
    ],
  },
  components: {},
  componentSets: {},
  styles: {},
};
const CREDENTIAL = { kind: "pat", token: "figd_parity" } as const;

let posthog: ReturnType<typeof stubPostHogNetwork>;

beforeEach(() => {
  initTelemetry({ enabled: true });
  posthog = stubPostHogNetwork(async () => Response.json(FILE));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await closeTelemetry(5_000);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("a CLI fetch records the event its MCP twin get_figma_data records, transport aside", async () => {
  const server = createServer(
    { credential: CREDENTIAL, imageDir: null },
    { transport: "stdio", telemetry: true },
  );
  const client = new Client({ name: "parity-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  await client.request(
    {
      method: "tools/call",
      params: { name: "get_figma_data", arguments: { fileKey: "abc123", depth: 2 } },
    },
    CallToolResultSchema,
  );
  await Promise.all([client.close(), server.close()]);

  const code = await runFetch(
    { fileKey: "abc123", depth: 2, format: "tree" },
    [],
    createCliCommandContext({ signal: new AbortController().signal, credential: CREDENTIAL }),
  );
  expect(code).toBe(0);

  const [mcp, cli] = (await posthog.delivered()).filter((event) => event.event === "tool_called");
  // Timings and the MCP client's name differ by nature; everything else is the same event.
  const comparable = ({ properties }: { properties: Record<string, unknown> }) =>
    Object.fromEntries(
      Object.entries(properties).filter(
        ([key]) => !/_ms$|^transport$|^client_|^\$/.test(key) && key !== "duration_ms",
      ),
    );
  expect(mcp.properties).toMatchObject({ tool: "get_figma_data", transport: "stdio" });
  expect(cli.properties).toMatchObject({ tool: "get_figma_data", transport: "cli" });
  expect(comparable(cli)).toEqual(comparable(mcp));
  expect(cli.properties.raw_node_count).toBeGreaterThan(0);
});
