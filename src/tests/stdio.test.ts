import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("stdio transport", () => {
  let client: Client;
  let transport: StdioClientTransport;

  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      // Best-effort cleanup
    }
  });

  it("starts, completes MCP handshake, and lists tools", async () => {
    transport = new StdioClientTransport({
      command: "tsx",
      args: ["src/bin.ts", "--stdio", "--figma-api-key=test-key"],
    });
    client = new Client({ name: "stdio-test", version: "1.0.0" });

    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("get_figma_data");
    expect(toolNames).toContain("download_figma_images");
  }, 30_000);
});
