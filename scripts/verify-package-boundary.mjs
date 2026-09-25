import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { licenseFiles, licenseBanner } from "./distribution-licenses.mjs";
import { COMMERCIAL_MANIFEST_PATH, buildCommercialManifest } from "./check-license-headers.mjs";

const forbidden =
  /(?:payload-lab[\\/]|@framelink\/payload-lab|\.payload-lab[\\/]|Payload Lab|payload-lab-theme)/;
/** @param {{path: string, content: string}[]} files */
export function assertPackageFiles(files) {
  for (const file of files) {
    const relativePath = file.path.replace(/^package\//, "");
    if (
      forbidden.test(file.path) ||
      !(
        /^(?:dist\/|package\.json$|README\.md$)/.test(relativePath) ||
        licenseFiles.includes(relativePath)
      )
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
  // Only when present: this runs from `prepack` to decide if the ROOT is publishable, and must not
  // crash on a checkout without the optional lab. The scans below are what protect the tarball.
  const labManifest = join(root, "tools/payload-lab/package.json");
  if (existsSync(labManifest)) {
    const lab = JSON.parse(readFileSync(labManifest, "utf8"));
    if (lab.private !== true) throw new Error("Payload Lab must stay private.");
  }
  if (JSON.stringify(pkg.files) !== JSON.stringify(["dist", "README.md", ...licenseFiles]))
    throw new Error("Review published files allowlist before changing it.");
  if (pkg.license !== "SEE LICENSE IN LICENSING.md")
    throw new Error("Package license metadata must point to LICENSING.md.");
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
  // Every tree that reaches dist — the members are inlined by tsup's `noExternal`.
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
    const files = paths
      .filter((path) => !path.endsWith("/"))
      .map((path) => ({
        path,
        content: execFileSync("tar", ["-xOf", archive, path], {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        }),
      }));
    assertPackageFiles(files);
    const contents = new Map(files.map((file) => [file.path, file.content]));
    for (const file of licenseFiles) {
      const expected = readFileSync(join(root, file), "utf8");
      for (const prefix of ["package/", "package/dist/"]) {
        if (contents.get(prefix + file) !== expected)
          throw new Error(`Missing or stale distribution license document: ${prefix}${file}`);
      }
    }
    // The bundles can't say which of their sources are commercial; this manifest is what does.
    const manifestPath = `package/dist/${COMMERCIAL_MANIFEST_PATH}`;
    const manifest = contents.get(manifestPath);
    if (!manifest?.trim())
      throw new Error(`Missing or empty commercial-files manifest: ${manifestPath}`);
    if (manifest !== buildCommercialManifest(root))
      throw new Error(
        `Stale commercial-files manifest: ${manifestPath} no longer matches the header scan.`,
      );
    for (const file of files) {
      if (file.path.startsWith("package/dist/") && /\.[cm]?js$/.test(file.path)) {
        if (!file.content.includes(licenseBanner))
          throw new Error(`Missing distribution license banner: ${file.path}`);
      }
    }
    console.log(
      `Package boundary passed: ${paths.length} tarball entries; license documents, banners, and commercial-files manifest verified; no lab code, assets, or captures.`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  verifyPackage(process.cwd(), !process.argv.includes("--no-build"));
