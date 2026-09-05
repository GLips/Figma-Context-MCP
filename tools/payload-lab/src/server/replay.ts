import { build, type BuildFailure } from "esbuild";
import { createHash } from "node:crypto";
import { access, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { analyze } from "../shared/analyze.js";
import type { Baseline, Comparison, Replay } from "../shared/model.js";
import { CaptureLibrary } from "./captures.js";
import { exec, git, resolveBaseline, sourceHash, copyCandidate } from "./git.js";
const allowedBuiltins = new Set([
  "fs",
  "path",
  "url",
  "util",
  "crypto",
  "buffer",
  "events",
  "stream",
  "string_decoder",
  "assert",
  "os",
  "timers",
  "perf_hooks",
  "process",
]);
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function runSnapshot(
  source: string,
  root: string,
  raw: Buffer,
  revision: string,
): Promise<Replay> {
  const modern = await exists(join(source, "src/adapters/rest/rest.ts"));
  if (!modern && !(await exists(join(source, "src/extractors/index.ts"))))
    throw new Error("This revision has no supported replay entry point.");
  for (const file of ["src/utils/serialize.ts", "src/utils/serializable-design.ts"])
    if (!(await exists(join(source, file))))
      throw new Error(`This revision predates ${file}. Choose a newer baseline.`);
  const entry = modern
    ? 'import { simplifyRestResponse } from "./src/adapters/rest/rest.ts"; const simplify = raw => simplifyRestResponse(raw);'
    : 'import { simplifyRawFigmaObject, allExtractors, collapseSvgContainers } from "./src/extractors/index.ts"; const simplify = raw => simplifyRawFigmaObject(raw, allExtractors, { afterChildren: collapseSvgContainers });';
  const code = `${entry}
import { wrapForSerialization } from "./src/utils/serializable-design.ts";
import { serializeResult } from "./src/utils/serialize.ts";
import { readFileSync } from "node:fs";
const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const start = performance.now();
const simplified = await simplify(raw);
const simplifyMs = performance.now() - start;
const design = wrapForSerialization(simplified);
const serialized = {}, serializeMs = {};
for (const format of ["tree", "yaml", "json"]) {
  const started = performance.now(); serialized[format] = serializeResult(design, format);
  serializeMs[format] = performance.now() - started;
}
process.stdout.write(JSON.stringify({ design, serialized, timings: { simplifyMs, serializeMs } }));`;
  let result;
  try {
    result = await build({
      stdin: {
        contents: code,
        resolveDir: source,
        sourcefile: "replay-entry.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
      metafile: true,
      nodePaths: [join(root, "node_modules"), join(root, "tools/payload-lab/node_modules")],
      alias: { "~": join(source, "src") },
      define: { "process.env.NODE_ENV": '"test"' },
      plugins: [
        {
          name: "offline-pipeline",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (
                args.path === "@framelink/core" ||
                args.path === "@framelink/core/snapshot" ||
                args.path === "@framelink/core/internal"
              )
                return {
                  path: join(
                    source,
                    args.path.endsWith("/snapshot")
                      ? "core/src/snapshot.ts"
                      : args.path.endsWith("/internal")
                        ? "core/src/internal.ts"
                        : "core/src/index.ts",
                  ),
                };
              const name = args.path.replace(/^node:/, "");
              if (builtinModules.includes(name) && !allowedBuiltins.has(name))
                throw new Error(`Replay refuses network/process module ${args.path}`);
              if (/telemetry|posthog|undici|@framelink\//.test(args.path))
                throw new Error(`Replay refuses side-effect module ${args.path}`);
              return undefined;
            });
          },
        },
      ],
    });
  } catch (error) {
    const details =
      (error as Partial<BuildFailure>).errors
        ?.map((entry) => {
          const location = entry.location;
          return `${location ? `${location.file.replace(source + "/", "")}:${location.line}: ` : ""}${entry.text}`;
        })
        .join("\n") ?? "Unknown bundler error";
    throw new Error(`Cannot bundle ${revision}. ${details} No packages were fetched.`);
  }
  const bundle = result.outputFiles[0].text;
  // Never pass server credentials to revision code. Bundle only the pure pipeline,
  // execute in a short-lived process, and forbid network APIs even if referenced globally.
  const denyNetwork = `globalThis.fetch = () => { throw new Error("Replay is offline"); }; globalThis.WebSocket = class { constructor() { throw new Error("Replay is offline"); } };\n`;
  const runner = join(source, "runner.mjs"),
    input = join(source, "input.json");
  await writeFile(runner, denyNetwork + bundle, { mode: 0o600 });
  await writeFile(input, raw, { mode: 0o600 });
  let stdout: string;
  try {
    ({ stdout } = await exec(process.execPath, ["--max-old-space-size=1024", runner, input], {
      cwd: source,
      env: { NODE_ENV: "test" },
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch {
    throw new Error(
      `Replay failed for ${revision}. The revision may be incompatible with this capture or installed dependencies.`,
    );
  }
  return {
    ...JSON.parse(stdout),
    revision,
    sourceHash: await sourceHash(source),
    pipeline: modern ? "REST adapter" : "legacy extractors",
  };
}
export async function compareCapture(
  root: string,
  dataDir: string,
  library: CaptureLibrary,
  id: string,
  baseline: Baseline,
): Promise<Comparison> {
  const capture = await library.metadata(id),
    raw = await library.raw(id);
  if (createHash("sha256").update(raw).digest("hex") !== capture.sha256)
    throw new Error("Capture checksum changed. Capture again before replaying.");
  const revision = await resolveBaseline(root, baseline);
  const runs = join(dataDir, "runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(runs, "run-"));
  try {
    const beforeHash = await sourceHash(root);
    const candidateDir = join(work, "candidate"),
      baselineDir = join(work, "baseline");
    await mkdir(baselineDir);
    await copyCandidate(root, candidateDir);
    if (beforeHash !== (await sourceHash(candidateDir)) || beforeHash !== (await sourceHash(root)))
      throw new Error("Source files changed during snapshot. Replay again.");
    const archive = join(work, "baseline.tar");
    await exec("git", [
      "-C",
      root,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      revision,
      "src",
      "package.json",
      "tsconfig.json",
      ...((await git(root, ["ls-tree", "--name-only", revision, "core"])) ? ["core"] : []),
    ]);
    await exec("tar", ["-xf", archive, "-C", baselineDir]);
    const left = await runSnapshot(baselineDir, root, raw, revision);
    const right = await runSnapshot(
      candidateDir,
      root,
      raw,
      `working tree (${(await git(root, ["rev-parse", "HEAD"])).slice(0, 12)})`,
    );
    const warnings = [
      "Both revisions use the locally installed dependencies; no packages are fetched during replay.",
    ];
    const baselinePackage = JSON.parse(await readFile(join(baselineDir, "package.json"), "utf8"));
    const currentPackage = JSON.parse(await readFile(join(candidateDir, "package.json"), "utf8"));
    if (
      JSON.stringify(baselinePackage.dependencies) !== JSON.stringify(currentPackage.dependencies)
    )
      warnings.push(
        "Baseline dependency declarations differ. This is a source comparison under current dependencies, not a reproduction of the released runtime.",
      );
    return {
      capture,
      baseline: left,
      candidate: right,
      analysis: analyze(left, right),
      warnings,
      stale: beforeHash !== (await sourceHash(root)),
      comparedAt: new Date().toISOString(),
      dependencyHash: createHash("sha256")
        .update(await readFile(join(root, "pnpm-lock.yaml")))
        .digest("hex"),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
