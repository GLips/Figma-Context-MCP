import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, resolveBaseline } from "../src/server/git.js";
import { compareCapture, runSnapshot } from "../src/server/replay.js";
import { CaptureLibrary } from "../src/server/captures.js";
test("isolated replay keeps capture bytes constant, includes uncommitted edits, and resolves baseline presets", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-test-"));
  const runGit = (...args: string[]) => exec("git", ["-C", root, ...args]);
  try {
    await runGit("init", "-b", "main");
    await runGit("config", "user.email", "test@example.test");
    await runGit("config", "user.name", "Test");
    await mkdir(join(root, "src/adapters/rest"), { recursive: true });
    await mkdir(join(root, "src/utils"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module","dependencies":{}}');
    await writeFile(join(root, "tsconfig.json"), "{}");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.0");
    await writeFile(
      join(root, "src/utils/serializable-design.ts"),
      "export const wrapForSerialization = x => x;",
    );
    await writeFile(
      join(root, "src/utils/serialize.ts"),
      "export const serializeResult = (x, format) => format + JSON.stringify(x);",
    );
    const producer = (width: number) =>
      `export const simplifyRestResponse = raw => ({nodes:[{id: raw.document.id, width: ${width}, inheritedSecret: Boolean(process.env.PAYLOAD_LAB_TEST_SECRET)}]});`;
    const path = join(root, "src/adapters/rest/rest.ts");
    await writeFile(path, producer(10));
    await runGit("add", ".");
    await runGit("commit", "-m", "baseline");
    await runGit("tag", "v1.0.0");
    const first = await resolveBaseline(root, { kind: "main" });
    await writeFile(path, producer(20));
    await runGit("commit", "-am", "second");
    await mkdir(join(root, "core/src"), { recursive: true });
    await writeFile(join(root, "core/package.json"), '{"name":"@framelink/core","type":"module"}');
    await writeFile(join(root, "core/src/internal.ts"), producer(30));
    await writeFile(
      join(root, "core/src/index.ts"),
      'export { simplifyRestResponse } from "@framelink/core/internal";',
    );
    const workspaceEntry = 'export { simplifyRestResponse } from "@framelink/core";';
    await writeFile(path, workspaceEntry);
    assert.equal(await resolveBaseline(root, { kind: "previous" }), first);
    assert.equal(await resolveBaseline(root, { kind: "tag", ref: "v1.0.0" }), first);
    assert.equal(await resolveBaseline(root, { kind: "commit", ref: first }), first);
    assert.equal(
      await resolveBaseline(root, { kind: "merge-base" }),
      await resolveBaseline(root, { kind: "main" }),
    );
    await assert.rejects(resolveBaseline(root, { kind: "commit", ref: "--output=/tmp/bad" }));
    const dataDir = join(root, ".payload-lab"),
      library = new CaptureLibrary(join(dataDir, "captures"));
    const raw = Buffer.from('{ "document": { "id": "a" } }\n');
    const capture = await library.save(raw, {
      name: "Sample",
      kind: "sample",
      fileKey: "x",
      nodeIds: [],
      sourceUrl: "local",
      endpoint: "local",
    });
    process.env.PAYLOAD_LAB_TEST_SECRET = "must-not-reach-replay";
    const result = await compareCapture(root, dataDir, library, capture.id, {
      kind: "previous",
    });
    delete process.env.PAYLOAD_LAB_TEST_SECRET;
    assert.equal(result.analysis.candidateNodes[0].fields.inheritedSecret, false);
    assert.equal(result.analysis.changes[0].before, 10);
    assert.equal(result.analysis.changes[0].after, 30);
    assert.deepEqual(await library.raw(capture.id), raw);
    assert.equal(await readFile(path, "utf8"), workspaceEntry);
    assert.equal(result.stale, false);
    assert.equal(result.baseline.revision, first);
    const repeated = await compareCapture(root, dataDir, library, capture.id, {
      kind: "previous",
    });
    assert.equal(repeated.baseline.sourceHash, result.baseline.sourceHash);
    assert.equal(repeated.candidate.sourceHash, result.candidate.sourceHash);
    assert.deepEqual(repeated.analysis.changes, result.analysis.changes);
    await runGit("add", ".");
    await runGit("commit", "-m", "extract core workspace");
    await writeFile(join(root, "core/src/internal.ts"), producer(40));
    const coreResult = await compareCapture(root, dataDir, library, capture.id, {
      kind: "commit",
      ref: "HEAD",
    });
    assert.equal(coreResult.analysis.baselineNodes[0].fields.width, 30);
    assert.equal(coreResult.analysis.candidateNodes[0].fields.width, 40);
    assert.notEqual(coreResult.candidate.sourceHash, repeated.candidate.sourceHash);
    await writeFile(
      path,
      'import "node:https"; export const simplifyRestResponse = () => ({nodes: []});',
    );
    await assert.rejects(
      runSnapshot(root, root, raw, "network-test"),
      /Replay refuses network\/process module node:https/,
    );
  } finally {
    delete process.env.PAYLOAD_LAB_TEST_SECRET;
    await rm(root, { recursive: true, force: true });
  }
});
