// License-scope gate. Commercial scope is carried per file by an SPDX header (LICENSING.md), and
// the repo default is MIT — so a commercial file that ships without its header is MIT for anyone
// who got that copy, irrevocably. That is why this fails CLOSED in both directions: every
// header-bearing source file under COMMERCIAL_PATHS must open with COMMERCIAL_HEADER, and no file
// outside them may carry the commercial identifier at all.
//
// The same scan feeds the dist manifest (writeCommercialManifest), because a bundle can't express
// per-file scope: one function, so the gate and the shipped manifest can never disagree.
//
//   node scripts/check-license-headers.mjs           → pnpm check:license-headers (wired into validate)
//   node scripts/check-license-headers.mjs --write   → add the header to in-scope files missing it
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The commercial source roots. A trailing slash is a directory (everything under it); anything else
 * is one exact file. Write-path scripts stay in scripts/ beside the MIT tooling, so they are listed
 * one by one — a new probe must be added here, and until it is, its header fails this gate.
 */
export const COMMERCIAL_PATHS = [
  "src/commercial/",
  "plugin/",
  "scripts/bridge-contract.mjs",
  "scripts/gen-flcm-doc.ts",
  "scripts/probe-commit-undo.mjs",
  "scripts/probe-grid.mjs",
  "scripts/probe-line-fill.mjs",
  "scripts/probe-midrun-await.mjs",
  "scripts/probe-constraints-stretch.mjs",
  "scripts/probe-queued-writes.mjs",
  "scripts/probe-vector.mjs",
];

const COMMERCIAL_SPDX_ID = "LicenseRef-Framelink-Commercial";
// Built from parts so no line of THIS file reads as a header to `rg` — the gate itself is MIT.
const SPDX_TAG = "SPDX-License-Identifier:";
const HEADER_LINES = [
  ` * ${SPDX_TAG} ${COMMERCIAL_SPDX_ID}`,
  " * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.",
];
export const COMMERCIAL_HEADER = ["/*!", ...HEADER_LINES, " */", ""].join("\n");
const COMMERCIAL_HTML_HEADER = ["<!--", ...HEADER_LINES, "-->", ""].join("\n");

/**
 * Generated public docs stay public: the flcm authoring reference sits inside plugin/ but is MIT.
 * scripts/gen-flcm-doc.ts writes this marker; the gate checks it is still there.
 */
export const MIT_DOC_MARKER = `<!-- ${SPDX_TAG} MIT -->\n`;
const MIT_EXCEPTIONS = ["plugin/docs/authoring/flcm.md"];

const HEADER_EXTENSIONS = /\.(?:ts|tsx|mts|mjs|js|html)$/;
// Same pattern LICENSING.md documents for `rg`: any comment line naming the commercial identifier.
const COMMERCIAL_LINE = new RegExp(`^\\s*\\*?\\s*${SPDX_TAG} ${COMMERCIAL_SPDX_ID}\\s*$`, "m");

export const COMMERCIAL_MANIFEST_PATH = "licensing/COMMERCIAL-FILES.txt";

const inCommercialScope = (path) =>
  COMMERCIAL_PATHS.some((scope) => (scope.endsWith("/") ? path.startsWith(scope) : path === scope));

/** The header a file must open with — after a shebang, if it has one. */
function expectedHeader(path) {
  return path.endsWith(".html") ? COMMERCIAL_HTML_HEADER : COMMERCIAL_HEADER;
}

function splitShebang(content) {
  const shebang = content.startsWith("#!") ? content.slice(0, content.indexOf("\n") + 1) : "";
  return [shebang, content.slice(shebang.length)];
}

function hasCommercialHeader(path, content) {
  return splitShebang(content)[1].startsWith(expectedHeader(path));
}

/** Prepends the commercial header to source text (after a shebang), unless it is already there. */
export function withCommercialHeader(path, content) {
  if (hasCommercialHeader(path, content)) return content;
  const [shebang, body] = splitShebang(content);
  return shebang + expectedHeader(path) + body;
}

// Tracked plus untracked-but-not-ignored: a new file must pass before it is ever committed, and
// .gitignore already keeps dist/ and node_modules/ out.
function listRepoFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path && existsSync(join(root, path)));
}

/**
 * One pass over the repo. `commercial` is every header-bearing source file in scope (sorted, the
 * manifest's content); `problems` is every way the tree disagrees with COMMERCIAL_PATHS.
 */
export function scanLicenseHeaders(root) {
  const commercial = [];
  const problems = [];
  for (const path of listRepoFiles(root).sort()) {
    if (MIT_EXCEPTIONS.includes(path)) {
      const content = readFileSync(join(root, path), "utf8");
      if (!content.startsWith(MIT_DOC_MARKER) || COMMERCIAL_LINE.test(content))
        problems.push(`${path}: the MIT exception must open with ${MIT_DOC_MARKER.trim()}`);
      continue;
    }
    if (!HEADER_EXTENSIONS.test(path)) continue;
    const content = readFileSync(join(root, path), "utf8");
    if (inCommercialScope(path)) {
      if (hasCommercialHeader(path, content)) commercial.push(path);
      else problems.push(`${path}: missing the commercial header`);
    } else if (COMMERCIAL_LINE.test(content)) {
      problems.push(`${path}: carries the commercial header but is outside COMMERCIAL_PATHS`);
    }
  }
  return { commercial, problems };
}

/** The covered-files list shipped in dist, where bundling has erased per-file scope. */
export function buildCommercialManifest(root) {
  const { commercial, problems } = scanLicenseHeaders(root);
  if (problems.length) throw new Error(explain(problems));
  return commercial.join("\n") + "\n";
}

export function writeCommercialManifest(root, output) {
  const destination = join(output, COMMERCIAL_MANIFEST_PATH);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, buildCommercialManifest(root));
}

function explain(problems) {
  return (
    `License header scope drift (${problems.length}):\n  ` +
    problems.join("\n  ") +
    "\n\nCommercial source is declared by COMMERCIAL_PATHS in scripts/check-license-headers.mjs. " +
    "A commercial file pushed without its header is MIT for whoever got it, so this fails closed: " +
    "add the header (see LICENSING.md), or move the file / fix COMMERCIAL_PATHS so scope and headers agree."
  );
}

// Never strips a header from an out-of-scope file: whether that file is commercial is a decision,
// so it stays a failure for a human to resolve.
function writeMissingHeaders(root) {
  for (const path of listRepoFiles(root)) {
    if (!inCommercialScope(path) || !HEADER_EXTENSIONS.test(path)) continue;
    const content = readFileSync(join(root, path), "utf8");
    const headed = withCommercialHeader(path, content);
    if (headed !== content) writeFileSync(join(root, path), headed);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (process.argv.includes("--write")) writeMissingHeaders(root);
  const { commercial, problems } = scanLicenseHeaders(root);
  if (problems.length) {
    console.error(explain(problems));
    process.exit(1);
  }
  console.log(`License headers passed: ${commercial.length} commercial files, scope matches.`);
}
