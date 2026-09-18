import { createServer } from "node:http";
import { once } from "node:events";
import { channel } from "node:diagnostics_channel";
import { afterAll, expect, it, vi } from "vitest";
import { fetchAndProcessImage } from "~/services/plugin-bridge/images.js";

// Only DNS routing is controlled. Validation sees a public address; the HTTP connection dials our
// local fixture. Fetch, TCP, response streaming and abort propagation are the real implementation.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
const transport = vi.hoisted(() => ({ agents: [] as import("undici").Agent[] }));
vi.mock("undici", async (original) => {
  const actual = await original<typeof import("undici")>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor() {
        super({
          connect: {
            lookup: (_host, options, callback) => {
              if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
              else callback(null, "127.0.0.1", 4);
            },
          },
        });
        transport.agents.push(this);
      }
    },
  };
});
afterAll(async () => {
  await Promise.all(transport.agents.map((agent) => agent.close()));
});

it.each(["headers", "body"])(
  "cancellation closes a real HTTP request stalled at %s",
  async (phase) => {
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    let disconnected!: () => void;
    const requestClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const server = createServer((_request, response) => {
      response.on("close", disconnected);
      if (phase === "body") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        // Deliberately never finish the body.
      }
      received();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const chunks = channel("undici:request:bodyChunkReceived");
    let receivedChunk!: () => void;
    const bodyReceived = new Promise<void>((resolve) => {
      receivedChunk = resolve;
    });
    const onChunk = (event: unknown) => {
      const { request } = event as { request: { origin: string } };
      if (String(request.origin) === `http://fixture.invalid:${address.port}`) receivedChunk();
    };
    chunks.subscribe(onChunk);
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = fetchAndProcessImage(
      `http://fixture.invalid:${address.port}/slow.png`,
      controller.signal,
    ).catch((error) => error);
    try {
      await requestReceived;
      if (phase === "body") {
        // Wait for the real receiver to deliver body bytes, not a guessed wall-clock delay.
        await bodyReceived;
        await new Promise((resolve) => setImmediate(resolve));
      }
      controller.abort(new Error("run cancelled"));
      const [failure] = await Promise.race([
        Promise.all([result, requestClosed]),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("HTTP work survived cancellation")), 1000);
        }),
      ]);
      expect(String(failure)).toContain("run cancelled");
    } finally {
      clearTimeout(deadline);
      chunks.unsubscribe(onChunk);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await result;
    }
  },
  2000,
);
