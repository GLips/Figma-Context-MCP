// Durable approval: the server's on-disk memory of the sandbox-minted session token, so a single
// human Allow survives a SERVER PROCESS restart (dev-watch save-restart, or a production
// crash/respawn) — not just the WS reconnects the in-memory token already handled.
//
// Why this is the whole fix, server-side only: the plugin's `approvedTokens` Set is the real gate
// and it outlives any socket, so as long as the plugin stays open it still remembers the token. The
// ONLY thing a restart lost was the SERVER's copy of that token (in-memory `PluginBridge.sessionToken`),
// so it echoed `null` in SESSION_INFO and the plugin re-prompted. Persisting the token here lets the
// restarted server re-echo it; the plugin recognizes it and stays approved. The plugin's honor path is
// untouched.
//
// Keyed by (cwd, PORT), not cwd alone. Multiple server processes can run from one project directory
// (Cursor + Claude Code both spawn the server at the workspace root; Phase 3 supports N concurrent
// servers on distinct block ports). Keying by cwd alone would collapse their distinct per-session
// tokens into one shared file, letting a DENIED or second server reload a sibling's token after a
// restart and appear approved — silently overriding a human Deny, the exact thing the minted-token
// model exists to prevent. Adding the bound port to the key isolates each server: a restart that
// RECLAIMS its port (the common single-server case — it frees the port on exit and re-probes to the
// same base) reloads its own token; a concurrent sibling on another port inherits nothing and
// re-prompts (fail-closed). Residual, deliberately accepted: a server that grabs a DEAD peer's exact
// freed port loads that slot's token and inherits its approval — narrow, requires the peer to have
// exited, and is "the approval of whoever holds this slot," which the WS_CONNECTED reset + token model
// already govern.
//
// Security posture (deliberately documented, not just coded): persisting the token WIDENS the replay
// surface. Before, the token lived only in RAM, harvestable by winning a race to a freed port during a
// drop window. Now it also lives in a 0600 file, so an attacker can read it and bind the port at
// leisure. Both reduce to the SAME trust boundary — the local user — who can already do far worse.
// Consent remains the real gate for the first Allow; the token is defense-in-depth, never cryptographic
// auth. Mitigations that keep this defensible: 0600 perms (enforced unconditionally via write-temp +
// chmod + atomic rename, so an existing looser-perm file can't leak the token); a key derived from the
// server's REAL cwd + port; a sliding TTL; and an explicit revoke path. What this does NOT defend
// against — a compromised local user — was never in scope and still isn't.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Logger } from "~/utils/logger.js";

// A working session lasts a day, refreshed on use (see `touch`). Long enough that an active human is
// never re-prompted mid-session; short enough that a forgotten on-disk token can't silently re-approve
// a stale session much later. NOT forever — that would make the file a standing credential.
export const TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRecord {
  token: string;
  // Retained for operator inspection of this security-adjacent file (which project it approves, and
  // when) — NOT read back or trusted at load time. The filename key already binds the file to a cwd;
  // these fields exist so a human can `cat` the file and understand it, not as a load-time check.
  identity: string;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * The cwd component of the persistence key: sha256 of the real path. The bound port is appended to the
 * filename (see `fileFor`) so concurrent same-cwd servers don't share a file. Pure (hash only; realpath
 * resolution is the caller's IO).
 */
export function keyForCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

/** A record is expired once it hasn't been used within the TTL. `now` is injected so this stays pure. */
export function isExpired(record: ApprovalRecord, now: number, ttlMs: number = TTL_MS): boolean {
  return now - record.lastUsedAt > ttlMs;
}

// Base dir resolution order: an explicit override (tests, contract harness, unusual setups), then the
// XDG state home, then ~/.framelink. Approval files land under `<base>/approvals/`.
export function resolveStateDir(): string {
  const explicit = process.env.FRAMELINK_STATE_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "framelink");
  return join(homedir(), ".framelink");
}

function safeRealpath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    // A cwd that can't be resolved (deleted out from under us, or a synthetic path in a test) still
    // gets a stable key from the raw string — resolution is a canonicalization nicety, not a gate.
    return cwd;
  }
}

/**
 * Imperative shell over the pure helpers above: one JSON file per (project directory, bound port), 0600.
 * Injectable cwd + baseDir so tests and the contract harness can isolate to a temp dir instead of
 * touching the real ~/.framelink. Every method is FAIL-SAFE: a missing/corrupt file, an unwritable state
 * dir, or a disk-full write degrades to "no durable approval" (in-memory approval for this process still
 * holds) and never throws — a durable-approval convenience must never crash or fail the write path it
 * exists to smooth. Writes are atomic (temp + chmod + rename) so a torn read can't surface a partial file
 * and an existing file's looser mode can't survive.
 */
export class ApprovalStore {
  private readonly approvalsDir: string;
  private readonly cwdKey: string;

  constructor(cwd: string = process.cwd(), baseDir: string = resolveStateDir()) {
    this.approvalsDir = join(baseDir, "approvals");
    this.cwdKey = keyForCwd(safeRealpath(cwd));
  }

  /** Where this store persists (for a startup log so an operator can see where the token file lives). */
  get directory(): string {
    return this.approvalsDir;
  }

  /** The persisted token for this (cwd, port) if present and unexpired, else null. Prunes an expired file. */
  load(port: number, now: number): string | null {
    const record = this.read(port);
    if (!record) return null;
    if (isExpired(record, now)) {
      this.clear(port);
      return null;
    }
    return record.token;
  }

  /** Persist a freshly handed-over token (0600), stamping created/used times. Fail-safe. */
  save(port: number, token: string, identity: string, now: number): void {
    this.write(port, { token, identity, createdAt: now, lastUsedAt: now });
  }

  /**
   * Slide the TTL forward on a successful write. Compare-and-set: only refreshes when the file STILL
   * holds `token`, so a peer process that has since revoked or replaced the file can't be rolled back by
   * this server writing a stale token over it. No-op if nothing is persisted or ownership has moved on.
   */
  touch(port: number, token: string, now: number): void {
    const record = this.read(port);
    if (!record || record.token !== token) return;
    record.lastUsedAt = now;
    this.write(port, record);
  }

  /** Forget the persisted approval (revoke, or an expired/corrupt prune). Idempotent and fail-safe. */
  clear(port: number): void {
    try {
      rmSync(this.fileFor(port));
    } catch {
      // Already gone (or unremovable) — nothing more to do.
    }
  }

  private fileFor(port: number): string {
    return join(this.approvalsDir, `${this.cwdKey}-${port}.json`);
  }

  /**
   * Atomic 0600 write: create a per-process temp file, force its mode (guaranteeing 0600 regardless of
   * umask or a pre-existing file's mode), then rename over the target. Rename is atomic on one
   * filesystem, so a concurrent reader sees either the old or the new file, never a torn one. Swallows IO
   * errors (unwritable dir, disk full) and logs — durability is best-effort; the process keeps its
   * in-memory approval.
   */
  private write(port: number, record: ApprovalRecord): void {
    const file = this.fileFor(port);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(this.approvalsDir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      Logger.log(
        `Could not persist session approval (${(err as Error).message}) — it holds in memory for this process only.`,
      );
      try {
        rmSync(tmp);
      } catch {
        // Temp may not exist if the failure was before the write — ignore.
      }
    }
  }

  private read(port: number): ApprovalRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.fileFor(port), "utf8");
    } catch {
      return null;
    }
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      this.clear(port);
      return null;
    }
    if (
      typeof record !== "object" ||
      record === null ||
      typeof (record as ApprovalRecord).token !== "string" ||
      typeof (record as ApprovalRecord).lastUsedAt !== "number"
    ) {
      this.clear(port);
      return null;
    }
    return record as ApprovalRecord;
  }
}
