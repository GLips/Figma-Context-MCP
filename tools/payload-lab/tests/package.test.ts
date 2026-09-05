import { test } from "node:test";
import assert from "node:assert/strict";
// The same verifier inspects actual npm tarball entries in pnpm check:package.
import {
  assertPackageFiles,
  assertSourceBoundary,
} from "../../../scripts/verify-package-boundary.mjs";
import { fileURLToPath } from "node:url";
test("published package verifier rejects lab source, bundled code, assets, captures and dependencies", () => {
  assertPackageFiles([{ path: "package/dist/index.js", content: "export const main = 1;" }]);
  for (const file of [
    { path: "package/tools/payload-lab/src/app.ts", content: "" },
    { path: "package/dist/app.js", content: 'const brand = "Payload Lab";' },
    { path: "package/.payload-lab/captures/a/response.json", content: "{}" },
    { path: "package/dist/payload-lab/assets/a.css", content: "" },
    { path: "package/package.json", content: '{"dependencies":{"@framelink/payload-lab":"*"}}' },
  ])
    assert.throws(() => assertPackageFiles([file]));
  assertSourceBoundary(fileURLToPath(new URL("../../../", import.meta.url)));
});
