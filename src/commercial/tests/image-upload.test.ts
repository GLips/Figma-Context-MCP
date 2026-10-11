/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The upload route is how a file outside the asset root reaches flcm.image without the server ever
// opening a caller-named path, so its refusals are the security story: a browser can't upload, a
// handle dies on time, a run can't use a handle its own code didn't name, and the byte cap binds the
// stream itself.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import {
  ImageUploadStore,
  UPLOAD_TTL_MS,
  uploadHandlesNamedIn,
} from "~/commercial/plugin-bridge/image-intake.js";
import { MAX_IMAGE_BYTES } from "~/commercial/plugin-bridge/images.js";
import {
  listUploadEndpoints,
  startUploadEndpoint,
  type UploadEndpoint,
} from "~/commercial/plugin-bridge/upload-endpoint.js";
import { runUpload } from "~/commercial/commands/upload.js";

const Jimp = createJimp({ formats: [png] });
const makePng = async () =>
  new Uint8Array(await new Jimp({ width: 4, height: 4, color: 0xff0000ff }).getBuffer("image/png"));

let stateDir: string;
let endpoint: UploadEndpoint;
let store: ImageUploadStore;
let now: number;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "flcm-uploads-"));
  process.env.FRAMELINK_STATE_DIR = stateDir;
  now = Date.now();
  store = new ImageUploadStore(() => now);
  endpoint = await startUploadEndpoint({ store, stateDir });
});

afterEach(async () => {
  endpoint.stop();
  delete process.env.FRAMELINK_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

/** POST straight at the endpoint, for the requests the CLI would never send. */
function post(
  headers: Record<string, string>,
  body: Iterable<Uint8Array>,
): Promise<{ status: number; body: { error?: string; handle?: string } }> {
  return new Promise((resolve, reject) => {
    let replied = false;
    const req = request(
      { host: "127.0.0.1", port: endpoint.port, method: "POST", path: "/uploads", headers },
      (res) => {
        replied = true;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    // Once the reply has arrived, the server hanging up on the rest of a refused body is expected.
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (!replied) reject(err);
    });
    for (const chunk of body) req.write(chunk);
    req.end();
  });
}

const capabilityHeaders = () => ({
  Authorization: `Bearer ${listUploadEndpoints(stateDir)[0].capability}`,
  "Content-Type": "application/octet-stream",
});

test("the CLI uploads a file and its handle redeems only for a run whose code names it", async () => {
  const file = join(stateDir, "photo.png");
  await writeFile(file, await makePng());
  const handle = await runUpload(file, {});

  const runA = uploadHandlesNamedIn(`fill: flcm.image("${handle}")`);
  const bytes = Buffer.from(store.redeem(handle, runA), "base64");
  expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

  // Another run's code never named it: the plugin asking for it there is refused.
  const runB = uploadHandlesNamedIn(`fill: flcm.image("assets/other.png")`);
  expect(() => store.redeem(handle, runB)).toThrow(/does not name that upload handle/);
});

test("a browser-origin request is refused before the capability is even checked", async () => {
  const { status, body } = await post({ ...capabilityHeaders(), Origin: "https://evil.example" }, [
    await makePng(),
  ]);
  expect(status).toBe(403);
  expect(body.error).toMatch(/browser/);
  expect(body.handle).toBeUndefined();
});

test("an upload over the byte cap is refused while streaming, without a declared length", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const chunks = Array.from({ length: MAX_IMAGE_BYTES / chunk.length + 1 }, () => chunk);
  const { status, body } = await post(
    { ...capabilityHeaders(), "Transfer-Encoding": "chunked" },
    chunks,
  );
  expect(status).toBe(413);
  expect(body.error).toMatch(/upload cap/);
});

test("a handle stops working once it expires", async () => {
  const { handle } = await store.intake([await makePng()]);
  const named = uploadHandlesNamedIn(handle);
  expect(() => store.redeem(handle, named)).not.toThrow();
  now += UPLOAD_TTL_MS + 1;
  expect(() => store.redeem(handle, named)).toThrow(/unknown or has expired/);
});
