import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, copyFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Baseline } from "../shared/model.js";
export const exec = promisify(execFile);
export async function git(root: string, args: string[]) {
  return (await exec("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}
export async function resolveBaseline(root: string, baseline: Baseline): Promise<string> {
  let ref: string;
  switch (baseline.kind) {
    case "main":
      ref = "refs/heads/main";
      break;
    case "merge-base":
      ref = await git(root, ["merge-base", "HEAD", "refs/heads/main"]);
      break;
    case "previous":
      ref = "HEAD~1";
      break;
    case "tag":
      if (!baseline.ref) throw new Error("Choose a release tag.");
      ref = `refs/tags/${baseline.ref}`;
      break;
    case "commit":
      if (!baseline.ref) throw new Error("Enter a commit or ref.");
      ref = baseline.ref;
      break;
  }
  try {
    return await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  } catch {
    throw new Error(
      "Baseline does not resolve to a local commit. Fetch the desired ref outside the lab.",
    );
  }
}
// These are the source inputs used by the supported pure replay entry points.
export async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(relative: string) {
    const full = join(root, relative);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Replay source contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(full)).sort()) await walk(`${relative}/${entry}`);
    } else if (/\.(?:ts|js|json)$/.test(relative)) files.push(relative);
  }
  await walk("src");
  try {
    await lstat(join(root, "core/src"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [...files, "package.json", "tsconfig.json"].sort();
  }
  await walk("core/src");
  files.push("core/package.json");
  files.push("package.json", "tsconfig.json");
  return files.sort();
}
export async function sourceHash(root: string) {
  const hash = createHash("sha256");
  for (const file of await sourceFiles(root)) {
    hash.update(file);
    hash.update(await readFile(join(root, file)));
  }
  return hash.digest("hex");
}
export async function copyCandidate(root: string, destination: string) {
  for (const file of await sourceFiles(root)) {
    const target = join(destination, file);
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(join(root, file), target);
  }
}
