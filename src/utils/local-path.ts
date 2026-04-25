import path from "path";

export type ResolveLocalPathFailureReason = "outside_image_dir" | "drive_letter_on_posix";
export type ResolveLocalPathResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: ResolveLocalPathFailureReason };

// Subset of the `path` module we use. Both `path.posix` and `path.win32`
// satisfy this shape, so tests can exercise cross-platform behavior on a
// single host.
type PathImpl = Pick<typeof path, "sep" | "resolve" | "isAbsolute" | "relative">;

/**
 * Resolve a user-supplied path against an allowed base directory, accepting
 * absolute inputs only when they lexically resolve inside the base.
 *
 * The previous implementation used `path.join(base, raw)` so that a leading
 * slash from the LLM ("/public/images") would be silently treated as a
 * relative path. That hack hid a class of cross-OS bugs: an absolute Windows
 * path mangled by the LLM into POSIX shape (e.g. drive letter stripped) was
 * also "silently treated as relative," concatenated onto the base, and
 * resulted in a doubled-up directory structure under imageDir. The tool
 * reported success and the file was never where the user expected.
 *
 * This resolver makes ambiguous inputs loud:
 *   - On POSIX servers, backslashes are normalized to forward slashes so an
 *     LLM can use either separator. Drive-letter prefixes ("C:/..." or
 *     "C:\\...") still reject loudly though — they aren't recognized as
 *     absolute by path.posix.isAbsolute, so they'd otherwise resolve to
 *     "<base>/C:/..." and silently miswrite.
 *   - Absolute paths must lexically resolve inside the base directory.
 *     Naturally accepts "user pasted a full path that happens to be inside
 *     the project" while rejecting absolute paths pointing elsewhere.
 *   - Containment is computed via path.relative — a single source of truth
 *     replacing ad-hoc startsWith(base + sep) checks that mishandle drive
 *     roots on Windows.
 *
 * Not a defense against symlinks/junctions: the check is lexical, so a
 * symlink under the base that points outside is not detected. If a real
 * filesystem boundary is needed later, compare `realpath` of base and
 * candidate's existing parent.
 */
export function resolveLocalPath(
  rawPath: string,
  baseDir: string,
  pathImpl: PathImpl = path,
): ResolveLocalPathResult {
  let normalized = rawPath;
  if (pathImpl.sep === "/") {
    // Drive-letter prefixes aren't recognized as absolute by path.posix, so
    // "C:\\Users\\..." or "C:/Users/..." would resolve to "<base>/C:/Users/..."
    // and silently miswrite. The path is meaningless on POSIX regardless.
    if (/^[A-Za-z]:[/\\]/.test(rawPath)) {
      return { ok: false, reason: "drive_letter_on_posix" };
    }
    // Otherwise normalize backslashes to forward slashes so an LLM can use
    // either separator without thinking about host OS. Backslashes are valid
    // filename characters on POSIX in theory, but real-world filenames
    // virtually never contain them and the common case (LLM mixing styles)
    // is far more important.
    normalized = rawPath.replace(/\\/g, "/");
  }

  const base = pathImpl.resolve(baseDir);
  const candidate = pathImpl.isAbsolute(normalized)
    ? pathImpl.resolve(normalized)
    : pathImpl.resolve(base, normalized);

  if (!isWithin(base, candidate, pathImpl)) {
    return { ok: false, reason: "outside_image_dir" };
  }

  return { ok: true, resolvedPath: candidate };
}

/**
 * True when `candidate` is `base` itself or a descendant of `base`.
 *
 * Uses path.relative rather than `startsWith(base + sep)` because the latter
 * mishandles drive roots on Windows (where `base` already ends with a
 * separator and concatenating another would double it).
 */
export function isWithin(base: string, candidate: string, pathImpl: PathImpl = path): boolean {
  const rel = pathImpl.relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !pathImpl.isAbsolute(rel));
}
