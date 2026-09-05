import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureLibrary, captureLive, captureRequest, captureId } from "./captures.js";
import { compareCapture } from "./replay.js";
import { git } from "./git.js";
export const baselineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("main") }).strict(),
  z.object({ kind: z.literal("merge-base") }).strict(),
  z.object({ kind: z.literal("previous") }).strict(),
  z.object({ kind: z.literal("tag"), ref: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("commit"), ref: z.string().min(1).max(200) }).strict(),
]);
interface AppOptions {
  root: string;
  dataDir: string;
  origin: string;
  credentials: { apiKey?: string; oauthToken?: string };
  fetcher?: typeof fetch;
}
export function createApp(options: AppOptions) {
  const app = new Hono();
  const library = new CaptureLibrary(join(options.dataDir, "captures"));
  let running = false;
  app.use("*", async (c, next) => {
    if (
      new URL(c.req.url).origin !== options.origin ||
      (c.req.header("host") && c.req.header("host") !== new URL(options.origin).host)
    )
      return c.json({ error: "Local requests only." }, 403);
    const origin = c.req.header("origin");
    if (
      (origin && origin !== options.origin) ||
      (c.req.method !== "GET" && origin !== options.origin)
    )
      return c.json({ error: "Open the lab on its local address." }, 403);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (c) => c.json({ error: "Request is too large." }, 413),
    }),
  );
  app.onError((err, c) =>
    c.json({ error: err instanceof z.ZodError ? "Check the request fields." : err.message }, 400),
  );
  app.get("/api/status", async (c) =>
    c.json({
      credentialConfigured: !!(options.credentials.apiKey || options.credentials.oauthToken),
      tags: (await git(options.root, ["tag", "--sort=-version:refname"]))
        .split("\n")
        .filter(Boolean),
      head: await git(options.root, ["rev-parse", "--short=12", "HEAD"]),
    }),
  );
  app.get("/api/captures", async (c) => c.json(await library.list()));
  app.post("/api/captures", async (c) =>
    c.json(
      await captureLive(
        library,
        captureRequest.parse(await c.req.json()),
        options.credentials,
        options.fetcher,
      ),
      201,
    ),
  );
  app.post("/api/sample", async (c) => {
    const raw = await readFile(join(options.root, "tools/payload-lab/samples/grouped-design.json"));
    return c.json(
      await library.save(raw, {
        name: "Sample · rotated groups",
        kind: "sample",
        sourceUrl: "Local synthetic sample",
        fileKey: "sample",
        nodeIds: [],
        endpoint: "local sample",
      }),
      201,
    );
  });
  app.get("/api/captures/:id/raw", async (c) => {
    const raw = await library.raw(captureId.parse(c.req.param("id")));
    return new Response(raw.toString("utf8"), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  });
  app.delete("/api/captures/:id", async (c) => {
    await library.remove(captureId.parse(c.req.param("id")));
    return c.json({ deleted: true });
  });
  app.post("/api/compare", async (c) => {
    const request = z
      .object({ captureId, baseline: baselineSchema })
      .strict()
      .parse(await c.req.json());
    if (running)
      return c.json({ error: "A replay is already running. Wait for it to finish." }, 409);
    running = true;
    try {
      return c.json(
        await compareCapture(
          options.root,
          options.dataDir,
          library,
          request.captureId,
          request.baseline,
        ),
      );
    } finally {
      running = false;
    }
  });
  return app;
}
