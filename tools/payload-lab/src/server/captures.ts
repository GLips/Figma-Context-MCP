import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Capture, Obj } from "../shared/model.js";
export const captureId = z.string().uuid();
export const captureRequest = z
  .object({ name: z.string().trim().min(1).max(100), url: z.string().max(2048) })
  .strict();
const MAX_BYTES = 32 * 1024 * 1024;
export function parseFigmaUrl(input: string) {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("Use an https://www.figma.com/design/ or /file/ URL.");
  const segments = url.pathname.split("/").filter(Boolean);
  if (!["design", "file"].includes(segments[0]) || !/^[a-zA-Z0-9]+$/.test(segments[1] ?? ""))
    throw new Error("Use a Figma design or file URL.");
  const branch = segments.indexOf("branch", 2);
  const fileKey = branch >= 0 ? segments[branch + 1] : segments[1];
  if (!fileKey || !/^[a-zA-Z0-9]+$/.test(fileKey))
    throw new Error("The Figma branch key is invalid.");
  const rawId = url.searchParams.get("node-id");
  const nodeId = rawId?.replace(/(\d+)-(\d+)/g, "$1:$2");
  if (nodeId && !/^I?\d+:\d+(?:;\d+:\d+)*$/.test(nodeId))
    throw new Error("The URL has an invalid node ID.");
  const endpoint = `https://api.figma.com/v1/files/${fileKey}${nodeId ? `/nodes?ids=${encodeURIComponent(nodeId)}` : ""}`;
  // Keep only the design identity, never query parameters that could contain credentials.
  return {
    fileKey,
    nodeIds: nodeId ? [nodeId] : [],
    endpoint,
    sourceUrl: `https://www.figma.com/design/${fileKey}${nodeId ? `?node-id=${encodeURIComponent(nodeId)}` : ""}`,
  };
}
export function parseRaw(raw: Uint8Array): Obj {
  if (raw.byteLength > MAX_BYTES)
    throw new Error("Capture exceeds the 32 MiB limit. Select a smaller subtree.");
  const data = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(raw).toString("utf8")));
  if (
    !(data.document && typeof data.document === "object") &&
    !(
      data.nodes &&
      typeof data.nodes === "object" &&
      !Array.isArray(data.nodes) &&
      Object.values(data.nodes).some(Boolean)
    )
  )
    throw new Error("Figma returned no document or node data.");
  return data as Obj;
}
export class CaptureLibrary {
  constructor(readonly directory: string) {}
  private folder(id: string) {
    return join(this.directory, captureId.parse(id));
  }
  async list(): Promise<Capture[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const captures: Capture[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !captureId.safeParse(entry.name).success) continue;
      captures.push(await this.metadata(entry.name));
    }
    return captures.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }
  async metadata(id: string): Promise<Capture> {
    return JSON.parse(await readFile(join(this.folder(id), "metadata.json"), "utf8"));
  }
  async raw(id: string): Promise<Buffer> {
    return readFile(join(this.folder(id), "response.json"));
  }
  async remove(id: string) {
    await rm(this.folder(id), { recursive: true, force: true });
  }
  async save(
    raw: Uint8Array,
    input: {
      name: string;
      kind: Capture["kind"];
      sourceUrl: string;
      fileKey: string;
      nodeIds: string[];
      endpoint: string;
    },
  ): Promise<Capture> {
    const data = parseRaw(raw);
    const id = randomUUID();
    const capture: Capture = {
      schemaVersion: 1,
      id,
      name: z.string().trim().min(1).max(100).parse(input.name),
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      fileKey: input.fileKey,
      nodeIds: input.nodeIds,
      capturedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.byteLength,
      api: {
        endpoint: input.endpoint,
        version: "v1",
        fileVersion: typeof data.version === "string" ? data.version : undefined,
        lastModified: typeof data.lastModified === "string" ? data.lastModified : undefined,
      },
    };
    await mkdir(this.folder(id), { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(this.folder(id), "response.json"), raw, { mode: 0o600 });
      await writeFile(join(this.folder(id), "metadata.json"), JSON.stringify(capture, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      await this.remove(id);
      throw error;
    }
    return capture;
  }
}
export async function captureLive(
  library: CaptureLibrary,
  input: z.infer<typeof captureRequest>,
  credentials: { apiKey?: string; oauthToken?: string },
  fetcher: typeof fetch = fetch,
) {
  const source = parseFigmaUrl(input.url);
  if (!credentials.apiKey && !credentials.oauthToken)
    throw new Error("Set FIGMA_API_KEY or FIGMA_OAUTH_TOKEN on the server, then restart the lab.");
  let response: Response;
  try {
    response = await fetcher(source.endpoint, {
      headers: credentials.oauthToken
        ? { Authorization: `Bearer ${credentials.oauthToken}` }
        : { "X-Figma-Token": credentials.apiKey! },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Figma capture failed. Check connectivity and retry.");
  }
  if (!response.ok)
    throw new Error(
      `Figma returned HTTP ${response.status}. Check file access, token permissions, or rate limits.`,
    );
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Capture exceeds 32 MiB. Select a smaller subtree.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Figma returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Capture exceeds 32 MiB. Select a smaller subtree.");
    }
    chunks.push(value);
  }
  return library.save(Buffer.concat(chunks), { ...source, name: input.name, kind: "live" });
}
