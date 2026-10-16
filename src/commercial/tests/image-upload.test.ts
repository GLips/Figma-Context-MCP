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
import type { ServerRequest } from "@framelink/plugin/protocol";
import type { ChannelRunContext, PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { executePluginCode } from "~/commercial/plugin-bridge/execution.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import { createImageSourceFetcher } from "~/commercial/plugin-bridge/image-requests.js";
import {
  createTestWriteAccess,
  targetedTestCall,
  TEST_DOCUMENT,
  TEST_INTENT,
  TEST_PLUGIN_LINK,
} from "./fixtures/write-access.js";

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

/**
 * Submit `code` the way figma_execute_code does, and during the run ask for `source` the way the
 * plugin's images.fetch would — so the grant comes from the real submission path, not a hand-built set.
 */
async function fetchDuringRun(code: string, source: string): Promise<string> {
  const fetchImage = createImageSourceFetcher({
    uploads: { store, port: () => endpoint.port },
  });
  let fetched: Promise<string> | undefined;
  const bridge = {
    submitRun: async (
      _link: unknown,
      _payload: ServerRequest,
      _executionId: string,
      { runContext: run }: { runContext: ChannelRunContext },
    ) => {
      fetched = fetchImage(source, run);
      await fetched.catch(() => {});
      return {
        type: "EXECUTE_CODE_RESULT",
        result: null,
        console: [],
        errors: null,
        documentChanged: false,
      };
    },
    targetCall: targetedTestCall,
  } as unknown as PluginBridge;
  await executePluginCode(
    {
      bridge,
      writeMeter: createTestWriteAccess().writeMeter,
      readLocalImage: () => Promise.reject(new Error("no local reads in this test")),
    },
    {
      executionId: mintExecutionId(),
      intent: TEST_INTENT,
      link: TEST_PLUGIN_LINK,
      document: TEST_DOCUMENT,
      session: null,
    },
    code,
  );
  return fetched!;
}

test("the CLI uploads a file and its handle loads only in a run whose code names it", async () => {
  const file = join(stateDir, "photo.png");
  await writeFile(file, await makePng());
  const handle = await runUpload(file, {});

  const bytes = Buffer.from(await fetchDuringRun(`flcm.image("${handle}")`, handle), "base64");
  expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

  // Another run's code never named it: the plugin asking for it there is refused.
  await expect(fetchDuringRun(`flcm.image("assets/other.png")`, handle)).rejects.toThrow(
    /does not name that upload handle/,
  );
});

test("a browser-origin request is refused before the capability is even checked", async () => {
  // No capability: were the checks swapped, this would be a 401 instead.
  const { status, body } = await post(
    { "Content-Type": "application/octet-stream", Origin: "https://evil.example" },
    [await makePng()],
  );
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
  expect(() => store.redeem(handle, named)).toThrow(/unknown to this server or has expired/);
});
