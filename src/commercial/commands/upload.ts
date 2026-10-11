/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { type Command, command } from "cleye";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";
import { relative, isAbsolute } from "node:path";
import { UsageError } from "~/config.js";
import { MAX_IMAGE_BYTES } from "~/commercial/plugin-bridge/images.js";
import { UPLOAD_TTL_MS } from "~/commercial/plugin-bridge/image-intake.js";
import {
  listUploadEndpoints,
  UPLOAD_PATH,
  type UploadEndpointRecord,
} from "~/commercial/plugin-bridge/upload-endpoint.js";
import { buildCommandHelp } from "~/utils/cli-help.js";

export const uploadCommand: Command = command(
  {
    name: "upload",
    strictFlags: true,
    parameters: ["<image>"],
    help: buildCommandHelp({
      name: "upload",
      summary: "Hand a local image to the running Framelink server for flcm.image",
      details: `Reads a PNG, JPEG or GIF with your own permissions and sends its bytes to the Framelink MCP
server running for this project, which prints a handle on stdout. Pass the handle to flcm.image in
place of a path, written literally in the script that uses it. Use this for a file outside the
server's asset root. Handles last ${UPLOAD_TTL_MS / 60_000} minutes and work only on the server that issued them.

With several servers running, the one started in this directory or above it is chosen; --port picks
one when that is ambiguous.`,
      exampleArgs: ["~/Downloads/photo.png", "hero.jpg --port 53123"],
    }),
    flags: {
      port: {
        type: Number,
        placeholder: "<port>",
        description: "The upload port of the server to use, when more than one is running",
      },
    },
  },
  (argv) => {
    runUpload(argv._.image, argv.flags).then(
      (handle) => process.stdout.write(handle + "\n"),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
  },
);

/** Upload one file and return its handle. The file is read here, on the caller's side. */
export async function runUpload(
  file: string,
  { port, cwd = process.cwd() }: { port?: number; cwd?: string },
): Promise<string> {
  const endpoint = chooseEndpoint(listUploadEndpoints(), port, cwd);
  // One descriptor for the size check and the stream, so the file checked is the file sent.
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new UsageError(`${file} is not a regular file.`);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new UsageError(`${file} is ${stat.size} bytes, over the ${MAX_IMAGE_BYTES}-byte cap.`);
    }
    const issued = await postImage(
      endpoint,
      createReadStream("", { fd: handle, autoClose: false }),
    );
    const expires = new Date(issued.expiresAt).toLocaleTimeString();
    console.error(
      `Uploaded to the server for ${endpoint.identity}; the handle works until ${expires}.`,
    );
    return issued.handle;
  } finally {
    await handle.close();
  }
}

function chooseEndpoint(
  records: UploadEndpointRecord[],
  port: number | undefined,
  cwd: string,
): UploadEndpointRecord {
  if (records.length === 0) {
    throw new Error(
      "No running Framelink MCP server is accepting uploads. Start it (your MCP client does), then retry.",
    );
  }
  if (port !== undefined) {
    const match = records.find((record) => record.port === port);
    if (!match)
      throw new Error(`No running server accepts uploads on port ${port}.\n${list(records)}`);
    return match;
  }
  if (records.length === 1) return records[0];
  // The server whose directory is the closest enclosing one wins; a tie leaves it to --port.
  const enclosing = records
    .filter((record) => isWithin(record.identity, cwd))
    .sort((a, b) => b.identity.length - a.identity.length);
  if (
    enclosing.length === 1 ||
    (enclosing.length > 1 && enclosing[0].identity !== enclosing[1].identity)
  )
    return enclosing[0];
  throw new Error(`Several servers accept uploads; choose one with --port.\n${list(records)}`);
}

function isWithin(dir: string, cwd: string): boolean {
  const rel = relative(dir, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function list(records: UploadEndpointRecord[]): string {
  return records
    .map((record) => `  --port ${record.port}  ${record.identity} (pid ${record.pid})`)
    .join("\n");
}

/**
 * node:http rather than fetch on purpose: fetch adds Sec-Fetch-* headers, which the endpoint refuses
 * as a browser request.
 */
function postImage(
  endpoint: UploadEndpointRecord,
  body: NodeJS.ReadableStream,
): Promise<{ handle: string; expiresAt: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        method: "POST",
        path: UPLOAD_PATH,
        headers: {
          Authorization: `Bearer ${endpoint.capability}`,
          "Content-Type": "application/octet-stream",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let reply: { handle?: unknown; expiresAt?: unknown; error?: unknown };
          try {
            reply = JSON.parse(text) as typeof reply;
          } catch {
            return reject(new Error(`The server answered ${res.statusCode} with: ${text}`));
          }
          if (res.statusCode === 201 && typeof reply.handle === "string") {
            return resolve({ handle: reply.handle, expiresAt: Number(reply.expiresAt) });
          }
          reject(new Error(`Upload refused: ${String(reply.error ?? text)}.`));
        });
      },
    );
    req.on("error", (err) =>
      reject(new Error(`Could not reach the server on port ${endpoint.port}: ${err.message}`)),
    );
    body.on("error", (err: Error) => req.destroy(err));
    body.pipe(req);
  });
}
