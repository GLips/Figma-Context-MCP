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
// Security posture (deliberately documented, not just coded): persisting the token WIDENS the replay
// surface. Before, the token lived only in RAM, harvestable by a local process that won the race to a
// freed port during a drop window. Now it also lives in a 0600 file, so an attacker can read it and
// bind the port at leisure. Both reduce to the SAME trust boundary — the local user — who can already
// do far worse. Consent remains the real gate for the first Allow; the token is defense-in-depth, never
// cryptographic auth. Mitigations that keep this defensible: 0600 perms; a key derived from the server's
// REAL cwd (a cross-project squatter gets a different file, hence no token); a sliding TTL (no ancient
// token silently re-approving weeks later); and an explicit revoke path. What this does NOT defend
// against — a compromised local user — was never in scope and still isn't.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A working session lasts a day, refreshed on use (see `touch`). Long enough that an active human is
// never re-prompted mid-session; short enough that a forgotten on-disk token can't silently re-approve
// a stale session much later. NOT forever — that would make the file a standing credential.
export const TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRecord {
  token: string;
  identity: string;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * The persistence key for a project directory: sha256 of the path. Keyed by the server's own cwd (the
 * caller passes the real, symlink-resolved path) so two runs of the SAME project share the token — the
 * intended "restart stays approved" — while a different project, or a squatter running elsewhere, gets a
 * different key and inherits nothing. Pure (hash only; the realpath resolution is the caller's IO).
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
function defaultBaseDir(): string {
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
 * Imperative shell over the pure helpers above: one JSON file per project directory, 0600. Injectable
 * cwd + baseDir so tests and the contract harness can isolate to a temp dir instead of touching the real
 * ~/.framelink. Every method is resilient to a missing/corrupt file — a durable-approval store must
 * never crash the server it exists to make more convenient.
 */
export class ApprovalStore {
  private readonly file: string;

  constructor(cwd: string = process.cwd(), baseDir: string = defaultBaseDir()) {
    this.file = join(baseDir, "approvals", `${keyForCwd(safeRealpath(cwd))}.json`);
  }

  /** The persisted token for this project if present and unexpired, else null. Prunes an expired/corrupt file. */
  load(now: number): string | null {
    const record = this.read();
    if (!record) return null;
    if (isExpired(record, now)) {
      this.clear();
      return null;
    }
    return record.token;
  }

  /** Persist a freshly handed-over token (0600), stamping created/used times. */
  save(token: string, identity: string, now: number): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const record: ApprovalRecord = { token, identity, createdAt: now, lastUsedAt: now };
    writeFileSync(this.file, JSON.stringify(record), { mode: 0o600 });
  }

  /** Slide the TTL forward on a successful write. No-op if nothing is persisted. */
  touch(now: number): void {
    const record = this.read();
    if (!record) return;
    record.lastUsedAt = now;
    writeFileSync(this.file, JSON.stringify(record), { mode: 0o600 });
  }

  /** Forget the persisted approval (revoke, or an expired/corrupt prune). Idempotent. */
  clear(): void {
    try {
      rmSync(this.file);
    } catch {
      // Already gone — nothing to do.
    }
  }

  private read(): ApprovalRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      this.clear();
      return null;
    }
    if (
      typeof record !== "object" ||
      record === null ||
      typeof (record as ApprovalRecord).token !== "string" ||
      typeof (record as ApprovalRecord).lastUsedAt !== "number"
    ) {
      this.clear();
      return null;
    }
    return record as ApprovalRecord;
  }
}
