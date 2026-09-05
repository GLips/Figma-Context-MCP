import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { root } from "./environment.js";
import { join } from "node:path";
import { createApp } from "./app.js";
const port = Number(process.env.PAYLOAD_LAB_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PAYLOAD_LAB_PORT must be between 1024 and 65535.");
const origin = `http://127.0.0.1:${port}`;
const app = createApp({
  root,
  dataDir: join(root, ".payload-lab"),
  origin,
  credentials: { apiKey: process.env.FIGMA_API_KEY, oauthToken: process.env.FIGMA_OAUTH_TOKEN },
});
app.get("/*", serveStatic({ root: join(root, "tools/payload-lab/dist") }));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
  console.log(`Payload Lab: ${origin}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
