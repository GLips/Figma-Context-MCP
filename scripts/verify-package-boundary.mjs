import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const forbidden =
  /(?:payload-lab[\\/]|@framelink\/payload-lab|\.payload-lab[\\/]|Payload Lab|payload-lab-theme)/;
/** @param {{path: string, content: string}[]} files */
export function assertPackageFiles(files) {
  for (const file of files) {
    if (
      forbidden.test(file.path) ||
      !/^(?:package\/)?(?:dist\/|package\.json$|README\.md$|LICENSE(?:\.md)?$)/.test(file.path)
    )
      throw new Error(`Unexpected published file: ${file.path}`);
    if (file.path.endsWith("package.json")) {
      const pkg = JSON.parse(file.content);
      for (const name of Object.keys({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      })) {
        if (
          ["@framelink/payload-lab", "react", "react-dom", "vite", "@hono/node-server"].includes(
            name,
          )
        )
          throw new Error(`Lab dependency would ship: ${name}`);
      }
    } else if (forbidden.test(file.content))
      throw new Error(`Lab content found in published artifact: ${file.path}`);
  }
}
export function assertSourceBoundary(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lab = JSON.parse(readFileSync(join(root, "tools/payload-lab/package.json"), "utf8"));
  if (lab.private !== true) throw new Error("Payload Lab must stay private.");
  if (JSON.stringify(pkg.files) !== JSON.stringify(["dist", "README.md"]))
    throw new Error("Review published files allowlist before changing it.");
  if (/payload-lab|recursive|--filter|\s-r\b/.test(pkg.scripts.build))
    throw new Error("Production build must not build the lab.");
  const config = readFileSync(join(root, "tsup.config.ts"), "utf8");
  if (forbidden.test(config)) throw new Error("Production build config references the lab.");
  function scan(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && forbidden.test(readFileSync(path, "utf8")))
        throw new Error(`Production source references Payload Lab: ${path}`);
    }
  }
  // Every source tree that reaches dist. core/ and plugin/ are private workspace members inlined
  // by tsup's `noExternal`, so a lab reference in either ships just as surely as one in src/.
  scan(join(root, "src"));
  scan(join(root, "core/src"));
  scan(join(root, "plugin/src"));
}
export function verifyPackage(root, buildFirst = true) {
  assertSourceBoundary(root);
  const scratch = mkdtempSync(join(tmpdir(), "payload-package-"));
  try {
    // Build only the published application. No workspace-recursive build is allowed.
    if (buildFirst) execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
    const packed = JSON.parse(
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
        {
          cwd: root,
          encoding: "utf8",
        },
      ),
    );
    const archive = join(scratch, packed[0].filename);
    const paths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    for (const required of [
      "package/dist/index.js",
      "package/dist/bin.js",
      "package/dist/mcp-server.js",
    ]) {
      if (!paths.includes(required)) throw new Error(`Missing production entry: ${required}`);
    }
    assertPackageFiles(
      paths
        .filter((path) => !path.endsWith("/"))
        .map((path) => ({
          path,
          content: execFileSync("tar", ["-xOf", archive, path], {
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          }),
        })),
    );
    console.log(
      `Package boundary passed: ${paths.length} tarball entries; no lab code, assets, or captures.`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  verifyPackage(process.cwd(), !process.argv.includes("--no-build"));
