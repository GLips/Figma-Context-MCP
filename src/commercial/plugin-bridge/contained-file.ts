/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The asset root is the one directory the server reads local files from on a caller's say-so:
// flcm.image paths (named by the untrusted plugin) and figma_execute_code's scriptPath (named by the
// MCP client). Both go through one reader per process, so they share a single pinned root.
import { realpath, stat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";

// Open flags for a contained read. O_NOFOLLOW is the TOCTOU guard: we open the path realpath ALREADY
// resolved, so its final component is a real file by construction — if it has become a symlink between
// the check and the open, someone swapped it under us and the open fails instead of following the swap
// out of the root. O_NONBLOCK keeps a fifo/device swapped into the path from parking the open forever
// (the fstat below then rejects it). Both are POSIX-only constants; on Windows they read as undefined
// and fall back to 0, where the handle checks below remain the guard.
const CONTAINED_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Callers name their own remedy for this refusal: who can act on it differs between them. */
export class OutsideAssetRootError extends Error {
  constructor(readonly assetRoot: string) {
    super(
      `the path resolves outside the asset root (${assetRoot}); only files under that root can be read`,
    );
  }
}

/**
 * The asset root itself can't be read from: the operator's configuration, which no path the caller
 * names can fix. Callers name the remedy, as for OutsideAssetRootError.
 */
export class AssetRootUnusableError extends Error {
  constructor(
    readonly assetRoot: string,
    problem: string,
  ) {
    super(`the asset root (${assetRoot}) ${problem}`);
  }
}

export type ContainedFileReader = (
  source: string,
  options: { maxBytes: number; signal?: AbortSignal },
) => Promise<Uint8Array>;

/**
 * Build the byte reader for one asset root. Callers wrap its errors with what they were loading; each
 * message is one clause with no trailing period, so a caller can embed it in its own sentence.
 *
 * THE ROOT IS THE CONTROL. A caller-named path is an arbitrary-file-read primitive unless contained:
 * resolve against the root, then verify the resolved REALPATH sits inside the root's realpath —
 * post-resolution, which is what defeats both `../` traversal and a symlink pointing out of the root
 * (a pre-resolution string check catches neither).
 *
 * Negative space: a HARDLINK inside the root to a file outside it passes containment, deliberately.
 * realpath structurally cannot see through one — there is no link to resolve, just a second name for
 * the same inode, and both names are equally real. It grants no capability either, because minting one
 * needs write access inside the asset root, and anyone holding that could copy the file in instead. Do
 * not "fix" it with an inode or link-count check: it buys nothing and would refuse the ordinary
 * hardlinked assets that build tools produce.
 *
 * The root is canonicalized ONCE and pinned for the process: re-resolving it per request would let a
 * root that is a symlink be retargeted mid-session, silently moving the authorization boundary the
 * operator chose at startup.
 *
 * Errors name the root explicitly: "./assets/logo.png" is ambiguous when the server's cwd differs from
 * the repo the agent is working in.
 */
export function createContainedFileReader(assetRoot: string): ContainedFileReader {
  // Cached only on success, so a root that doesn't exist yet at first use isn't a permanent verdict.
  let pinnedRoot: Promise<string> | null = null;
  const canonicalRoot = (): Promise<string> => {
    if (!pinnedRoot) {
      pinnedRoot = (async () => {
        const rootReal = await realpath(assetRoot).catch((err: NodeJS.ErrnoException) => {
          throw new AssetRootUnusableError(
            assetRoot,
            err.code === "ENOENT" ? "does not exist" : `could not be resolved: ${err.code}`,
          );
        });
        if (!(await stat(rootReal)).isDirectory()) {
          throw new AssetRootUnusableError(assetRoot, "is not a directory");
        }
        return rootReal;
      })().catch((err: unknown) => {
        pinnedRoot = null;
        throw err;
      });
    }
    return pinnedRoot;
  };

  return async function readContained(source, { maxBytes, signal }) {
    signal?.throwIfAborted();
    const rootReal = await canonicalRoot();
    let fileReal: string;
    try {
      fileReal = await realpath(resolvePath(rootReal, source));
    } catch (err) {
      // Only ENOENT/ENOTDIR genuinely mean "no such file" — reporting a permission or
      // name-too-long failure as a missing file sends the reader hunting for the wrong problem.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error(`no such file under the asset root (${assetRoot})`);
      }
      throw new Error(`could not resolve that path under the asset root (${assetRoot}): ${code}`);
    }
    if (fileReal !== rootReal && !fileReal.startsWith(rootReal + pathSep)) {
      throw new OutsideAssetRootError(assetRoot);
    }
    return readOpenedFile(fileReal, assetRoot, maxBytes, signal);
  };
}

/**
 * Read an already-contained path through ONE handle: open, verify what we actually opened, then read
 * only from that descriptor. Checking a path and then re-opening it by name is three separate races —
 * the file can become a symlink, a fifo, or a different (larger) file between them — and every one of
 * those resolves the name again. A descriptor cannot be swapped, so the object we vet is the object
 * we read, and the byte cap binds the read itself instead of a size the file no longer has.
 *
 * Negative space: a directory component swapped for a symlink between realpath and open is NOT closed
 * here. Doing so needs openat/RESOLVE_BENEATH, which Node core does not expose portably, and it takes
 * a local writer racing us inside the root — a strictly smaller threat than the caller-named path this
 * whole module exists to contain.
 */
async function readOpenedFile(
  fileReal: string,
  assetRoot: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const handle = await open(fileReal, CONTAINED_OPEN_FLAGS);
  try {
    // fstat, not stat: this describes the OPEN object, so a fifo/device/directory swapped into the
    // path after the containment check is refused here rather than read or blocked on.
    if (!(await handle.stat()).isFile()) {
      throw new Error(`the path is not a file (asset root: ${assetRoot})`);
    }
    // One cap-sized buffer, filled from the descriptor: a file that grew after the check can't make
    // us allocate past the cap, and the (cap + 1)th byte is what proves it was over.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`file is over the ${maxBytes}-byte cap`);
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}
