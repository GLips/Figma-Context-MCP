/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The process-wide state root shared by every on-disk store (session approvals, image uploads, write
// access). It reads FRAMELINK_STATE_DIR directly rather than through src/config.ts because the stores
// are constructed deep in the write path, and tests and the contract harness isolate them per process
// by setting the env var.

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Resolution order: an explicit override (tests, contract harness, unusual setups), then the XDG state
// home, then ~/.framelink.
export function resolveStateDir(): string {
  const explicit = process.env.FRAMELINK_STATE_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "framelink");
  return join(homedir(), ".framelink");
}

/**
 * Atomic 0600 write of a small state file: create a per-process temp file, force its mode
 * (guaranteeing 0600 regardless of umask or a pre-existing file's mode), then rename over the target.
 * Rename is atomic on one filesystem, so a concurrent reader sees the old or the new file, never a
 * torn one. Throws on IO failure — each caller decides what a lost write costs it.
 */
export function writePrivateFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, contents, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
