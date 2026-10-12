// The package-consumer gate for figma-developer-mcp/read. Two checks:
//
// 1. The bundler's input graph for src/read.ts (not just the emitted text) reaches nothing
//    commercial, nothing from the plugin, and none of the local server's process-wide machinery.
// 2. The packed tarball, installed into a scratch directory outside the workspace, typechecks a
//    host against its declarations with no skipLibCheck, then runs that host over real HTTP
//    (scripts/read-entry-consumer/consumer.ts).
//
// `--no-build` reuses an existing dist (validate runs it right after `pnpm build`).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Paths are esbuild's, relative to the repo root; workspace members resolve to core/ and plugin/.
const FORBIDDEN_INPUTS = [
  /^src\/commercial\//,
  /^plugin\//,
  /^src\/telemetry\//,
  /^src\/(server|config|bin|index)\.ts$/,
  /^src\/mcp\/index\.ts$/,
];
// Packages that only make sense process-wide: telemetry, the global dispatcher, HTTP/WS servers.
const FORBIDDEN_PACKAGES = ["posthog-node", "undici", "express", "ws", "dotenv", "cleye"];

async function checkInputGraph() {
  const { metafile } = await build({
    entryPoints: [join(root, "src/read.ts")],
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    // Mirrors tsup: runtime dependencies stay external, workspace members are bundled.
    external: Object.keys(pkg.dependencies),
    logLevel: "silent",
  });
  const problems = [];
  for (const [input, { imports }] of Object.entries(metafile.inputs)) {
    if (FORBIDDEN_INPUTS.some((pattern) => pattern.test(input))) problems.push(input);
    for (const { path, external } of imports) {
      const name = path.startsWith("@")
        ? path.split("/").slice(0, 2).join("/")
        : path.split("/")[0];
      if (external && FORBIDDEN_PACKAGES.includes(name)) problems.push(`${input} → ${path}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The read entry's input graph reaches forbidden code:\n  ${problems.join("\n  ")}`,
    );
  }
  console.log(`Read entry input graph clean: ${Object.keys(metafile.inputs).length} inputs.`);
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function checkPackedConsumer(buildFirst) {
  if (buildFirst) run("pnpm", ["build"], root);
  const scratch = mkdtempSync(join(tmpdir(), "read-entry-consumer-"));
  try {
    const [{ filename }] = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          scratch,
          "--cache",
          join(scratch, "npm-cache"),
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    const consumer = join(scratch, "consumer");
    cpSync(join(root, "scripts/read-entry-consumer"), consumer, { recursive: true });
    const devVersion = (name) => pkg.devDependencies[name].replace(/^[\^~]/, "");
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "read-entry-consumer",
        private: true,
        type: "module",
        dependencies: {
          "figma-developer-mcp": `file:${join(scratch, filename)}`,
          "@modelcontextprotocol/sdk": pkg.dependencies["@modelcontextprotocol/sdk"],
        },
        devDependencies: {
          typescript: devVersion("typescript"),
          "@types/node": devVersion("@types/node"),
        },
      }),
    );
    // Outside the workspace, so pnpm installs it as a lone project; the store makes it quick.
    run(
      "pnpm",
      ["install", "--prefer-offline", "--silent", "--config.confirmModulesPurge=false"],
      consumer,
    );
    run(join(consumer, "node_modules/.bin/tsc"), ["-p", "."], consumer);
    run(process.execPath, [join(consumer, "out/consumer.js")], consumer);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await checkInputGraph();
checkPackedConsumer(!process.argv.includes("--no-build"));
