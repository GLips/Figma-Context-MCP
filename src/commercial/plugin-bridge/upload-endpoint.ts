/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The HTTP front door to image intake: `POST /uploads` with raw image bytes, answered with a handle.
// It listens on its own ephemeral loopback port, not the WS relay's: the relay admits `Origin: null`
// for the plugin iframe, and this route must refuse every browser, so the two don't share a gate.
//
// Loopback is not the authorization — any local page can reach loopback. The gates, in order:
//   1. Any request carrying browser-only headers (Origin, Sec-Fetch-*) is refused before anything
//      else is read. A browser can't drop them, and the Authorization header below forces a CORS
//      preflight this server never answers, so a page can neither send nor read an upload.
//   2. Host must be the loopback literal and our port, which defeats DNS rebinding.
//   3. A bearer upload capability: 256 random bits, rotated, each living CAPABILITY_TTL_MS, published
//      only in a 0600 record in the user's state directory. Holding it proves the caller can read the
//      user's own files; it grants nothing but uploads to this one server.
// The request carries bytes and nothing else: no query string, no path or url parameter, ever.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "~/utils/logger.js";
import { resolveStateDir, writePrivateFileAtomic } from "~/commercial/state-dir.js";
import { SESSION_IDENTITY } from "./approval.js";
import { ImageIntakeError, tooLarge, type ImageUploadStore } from "./image-intake.js";
import { MAX_IMAGE_BYTES } from "./images.js";

export const UPLOAD_PATH = "/uploads";
const CAPABILITY_TTL_MS = 10 * 60 * 1000;
// Rotating at half the life means the published capability always has at least half its life left,
// so a reader of the record never picks up one about to die mid-upload.
const CAPABILITY_ROTATE_MS = CAPABILITY_TTL_MS / 2;
// A slow sender can hold an intake slot (image-intake.ts caps those) for at most this long.
const REQUEST_TIMEOUT_MS = 30_000;
// How long a refused sender may keep streaming into the void before we hang up on it.
const REFUSAL_LINGER_MS = 2_000;

/** What a running server publishes for the upload command to find and authenticate to it. */
export interface UploadEndpointRecord {
  port: number;
  capability: string;
  expiresAt: number;
  /** The server's working directory, so the CLI can pick the server for the project it runs in. */
  identity: string;
  pid: number;
}

export function uploadRecordsDir(stateDir: string = resolveStateDir()): string {
  return join(stateDir, "uploads");
}

export interface UploadEndpoint {
  port: number;
  stop(): void;
}

/** Start the endpoint for one server process and publish its record. */
export async function startUploadEndpoint({
  store,
  stateDir = resolveStateDir(),
  now = Date.now,
}: {
  store: ImageUploadStore;
  stateDir?: string;
  now?: () => number;
}): Promise<UploadEndpoint> {
  const capabilities = new CapabilitySet(now);
  let port = 0;
  const server = createServer(
    { requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: 10_000, maxHeaderSize: 8 * 1024 },
    (req, res) => {
      void serveUpload(req, res, { port, store, capabilities });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as { port: number }).port;

  const recordFile = join(uploadRecordsDir(stateDir), `${process.pid}.json`);
  const publish = (): void => {
    const { capability, expiresAt } = capabilities.mint();
    const record: UploadEndpointRecord = {
      port,
      capability,
      expiresAt,
      identity: SESSION_IDENTITY,
      pid: process.pid,
    };
    writePrivateFileAtomic(recordFile, JSON.stringify(record, null, 2));
  };
  try {
    publish();
  } catch (err) {
    // Nothing can know this port without the record, so a listener left bound would only leak.
    server.close();
    throw err;
  }
  // A failed rotation leaves the previous capability published until it expires; uploads then fail
  // with a 401 naming the cause, which beats crashing the server from a timer.
  const rotation = setInterval(() => {
    try {
      publish();
    } catch (err) {
      Logger.log(`Could not rotate the upload capability: ${(err as Error).message}`);
    }
  }, CAPABILITY_ROTATE_MS);
  rotation.unref();
  // Don't let an idle listener keep a short-lived process alive. A stdio server usually exits on
  // stdin close rather than through stop(), so the record also goes on exit; a crash can still strand
  // one, which the reader skips once its pid is gone or its capability expires.
  server.unref();
  const removeRecord = (): void => rmSync(recordFile, { force: true });
  process.once("exit", removeRecord);
  Logger.log(`Image upload endpoint listening on http://127.0.0.1:${port}${UPLOAD_PATH}`);

  return {
    port,
    stop: () => {
      clearInterval(rotation);
      server.close();
      server.closeAllConnections();
      process.off("exit", removeRecord);
      removeRecord();
    },
  };
}

/** Every capability minted and not yet expired. Stored as digests, compared in constant time. */
class CapabilitySet {
  private live: { digest: Buffer; expiresAt: number }[] = [];

  constructor(private readonly now: () => number) {}

  mint(): { capability: string; expiresAt: number } {
    const capability = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + CAPABILITY_TTL_MS;
    this.prune();
    this.live.push({ digest: sha256(capability), expiresAt });
    return { capability, expiresAt };
  }

  accepts(presented: string): boolean {
    this.prune();
    const digest = sha256(presented);
    // Check every live entry rather than returning on the first match, so timing says nothing about
    // which one (or whether any) matched.
    return this.live.reduce((ok, entry) => timingSafeEqual(entry.digest, digest) || ok, false);
  }

  private prune(): void {
    const now = this.now();
    this.live = this.live.filter((entry) => entry.expiresAt > now);
  }
}

async function serveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  {
    port,
    store,
    capabilities,
  }: { port: number; store: ImageUploadStore; capabilities: CapabilitySet },
): Promise<void> {
  const { headers } = req;
  if (
    headers.origin !== undefined ||
    Object.keys(headers).some((h) => h.startsWith("sec-fetch-"))
  ) {
    return refuse(req, res, 403, "browser requests are refused; upload with the CLI");
  }
  if (headers.host !== `127.0.0.1:${port}`) {
    return refuse(req, res, 403, "the Host header must name this loopback endpoint");
  }
  if (req.method !== "POST" || req.url !== UPLOAD_PATH) {
    return refuse(req, res, 404, `the only route is POST ${UPLOAD_PATH}, with no query string`);
  }
  const bearer = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1];
  if (!bearer || !capabilities.accepts(bearer)) {
    return refuse(
      req,
      res,
      401,
      "missing, unknown or expired upload capability; the upload command reads a fresh one",
    );
  }
  if (headers["content-type"] !== "application/octet-stream") {
    return refuse(req, res, 415, "send the image as raw application/octet-stream bytes");
  }
  // An early refusal for an honest oversized declaration; the streamed cap is what actually binds.
  const declared = Number(headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    const { message, status } = tooLarge();
    return refuse(req, res, status, message);
  }
  try {
    // destroyOnReturn: false — leaving the loop at the byte cap must not tear the socket down before
    // the refusal is written (see refuse).
    const issued = await store.intake(req.iterator({ destroyOnReturn: false }));
    send(res, 201, issued);
  } catch (err) {
    if (err instanceof ImageIntakeError) return refuse(req, res, err.status, err.message);
    // The sender hung up mid-body: nobody is left to answer.
    if (req.destroyed) return;
    Logger.log(`Image upload failed: ${err instanceof Error ? err.message : String(err)}`);
    refuse(req, res, 500, "the upload failed on the server");
  }
}

/**
 * Answer and close. The body may be unread (an early refusal) or half-read (a cap crossed mid-stream).
 * Destroying the socket the moment the reply is written can reset the connection before the sender
 * reads the reply, so discard what keeps arriving and close after a short linger instead.
 */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  req.resume();
  res.once("finish", () => setTimeout(() => req.destroy(), REFUSAL_LINGER_MS).unref());
  // No `Connection: close`: Node would end the socket on finish, racing a sender still mid-body.
  send(res, status, { error });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * The live endpoint records in the state directory, for the upload command. A record is skipped when
 * its capability has expired, its process is gone, or the file isn't a private regular file owned by
 * this user: a record someone else could plant would point our uploads at their listener.
 */
export function listUploadEndpoints(
  stateDir: string = resolveStateDir(),
  now: number = Date.now(),
): UploadEndpointRecord[] {
  const dir = uploadRecordsDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: UploadEndpointRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) continue;
      if (process.getuid && stat.uid !== process.getuid()) continue;
      const record = parseRecord(JSON.parse(readFileSync(file, "utf8")));
      if (record && record.expiresAt > now && isProcessAlive(record.pid)) records.push(record);
    } catch {
      // Unreadable or torn mid-rotation: treat as absent, like a dead server's leftover.
    }
  }
  return records;
}

function parseRecord(value: unknown): UploadEndpointRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { port, capability, expiresAt, identity, pid } = value as Record<string, unknown>;
  if (
    typeof port !== "number" ||
    typeof capability !== "string" ||
    typeof expiresAt !== "number" ||
    typeof identity !== "string" ||
    typeof pid !== "number"
  )
    return null;
  return { port, capability, expiresAt, identity, pid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM included: the record is this user's, so a pid owned by someone else was reused after
    // our server died, and its listener is not ours to send images to.
    return false;
  }
}
