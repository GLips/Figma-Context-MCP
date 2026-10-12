/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Durable approval (ADR-0008): the server's on-disk copy of the sandbox-minted session token, so one
// Allow survives a server PROCESS restart. The plugin's `approvedTokens` Set stays the real gate; a
// restarted server re-echoes the persisted token, which the plugin still recognizes.
//
// Keyed by (cwd, PORT): same-cwd servers on distinct block ports must not reload each other's token,
// or a denied sibling could override a human Deny. Accepted residual: a server that takes a dead peer's
// freed port inherits that slot's approval, deliberately so via bridge.ts's RECLAIM_WINDOW_MS.
//
// The 0600 file widens the replay surface only to the local user, already the trust boundary.
// Mitigations: forced 0600 via atomic rename, a REAL-cwd key, a sliding TTL, an explicit revoke.

import { readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveStateDir, writePrivateFileAtomic } from "~/commercial/state-dir.js";
import { Logger } from "~/utils/logger.js";
import { parseAuthorizingUser, type AuthorizingUser } from "./approval.js";

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
  // Who clicked Allow — writes are attributed to them, so it must survive a restart with the token.
  // Null when the plugin could not name a Figma user; the write gate refuses such a session.
  authorizingUser: AuthorizingUser | null;
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

  /**
   * The persisted record for this (cwd, port) if present and unexpired, else null. Prunes an expired
   * file.
   *
   * Returns the whole record rather than just the token because the bridge needs two facts from the
   * one read: the token to echo, and `lastUsedAt` to judge how RECENTLY a plugin was approved here —
   * a much tighter question than the store's own 24h expiry (see PluginBridge.hasRecentApproval).
   */
  loadRecord(port: number, now: number): ApprovalRecord | null {
    const record = this.read(port, true);
    if (!record) return null;
    if (isExpired(record, now)) {
      this.clear(port);
      return null;
    }
    return record;
  }

  /**
   * Whether an unexpired approval is persisted for this (cwd, port). The read-only counterpart to
   * `load`: it answers the same question but deletes NOTHING, not even an expired or corrupt file.
   *
   * That is the whole reason it exists. The one caller (the bridge's reclaim probe) asks about a port
   * that is currently BUSY — held, quite possibly, by another live server of this same project. Pruning
   * from there would delete that peer's approval file behind its back, and `touch`'s compare-and-set
   * would never write it back, so the peer would lose durable approval and re-prompt its human on its
   * next restart. Only the process that actually BINDS a port may prune that port's slot.
   */
  hasUnexpiredApproval(port: number, now: number): boolean {
    const record = this.read(port, false);
    return record !== null && !isExpired(record, now);
  }

  /** Persist a freshly handed-over token (0600), stamping created/used times. Fail-safe. */
  save(
    port: number,
    token: string,
    identity: string,
    authorizingUser: AuthorizingUser | null,
    now: number,
  ): void {
    this.write(port, { token, identity, authorizingUser, createdAt: now, lastUsedAt: now });
  }

  /**
   * Slide the TTL forward on a successful write. Compare-and-set: only refreshes when the file STILL
   * holds `token`, so a peer process that has since revoked or replaced the file can't be rolled back by
   * this server writing a stale token over it. No-op if nothing is persisted or ownership has moved on.
   */
  touch(port: number, token: string, now: number): void {
    const record = this.read(port, true);
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

  /**
   * The session claim the plugin gave this (cwd, port) the last time it asked for approval, if one is
   * unexpired. It lets a server process that outlived its socket (or replaced it: a restart, the next
   * `execute` run) pick up an Allow the human gave while it was away (see PluginBridge.sessionClaim).
   * Same 0600 file discipline and fail-safe reads as the token; prunes an expired or corrupt file.
   */
  loadSessionClaim(port: number, now: number): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.claimFileFor(port), "utf8"));
    } catch {
      this.clearSessionClaim(port);
      return null;
    }
    const { sessionClaim, createdAt } = (parsed ?? {}) as {
      sessionClaim?: unknown;
      createdAt?: unknown;
    };
    if (
      typeof sessionClaim !== "string" ||
      typeof createdAt !== "number" ||
      now - createdAt > TTL_MS
    ) {
      this.clearSessionClaim(port);
      return null;
    }
    return sessionClaim;
  }

  /** Persist the plugin's session claim for this (cwd, port), 0600. Fail-safe. */
  saveSessionClaim(port: number, sessionClaim: string, now: number): void {
    try {
      writePrivateFileAtomic(
        this.claimFileFor(port),
        JSON.stringify({ sessionClaim, createdAt: now }),
      );
    } catch (err) {
      Logger.log(
        `Could not persist the session claim (${(err as Error).message}) — an Allow given while this server is disconnected reaches it only if it reconnects without restarting.`,
      );
    }
  }

  /** Forget the persisted session claim: it was spent on a handover, or is expired. Idempotent. */
  clearSessionClaim(port: number): void {
    try {
      rmSync(this.claimFileFor(port));
    } catch {
      // Already gone (or unremovable) — nothing more to do.
    }
  }

  private fileFor(port: number): string {
    return join(this.approvalsDir, `${this.cwdKey}-${port}.json`);
  }

  private claimFileFor(port: number): string {
    return join(this.approvalsDir, `${this.cwdKey}-${port}.claim.json`);
  }

  /**
   * Atomic 0600 write: create a per-process temp file, force its mode (guaranteeing 0600 regardless of
   * umask or a pre-existing file's mode), then rename over the target. Rename is atomic on one
   * filesystem, so a concurrent reader sees either the old or the new file, never a torn one. Swallows IO
   * errors (unwritable dir, disk full) and logs — durability is best-effort; the process keeps its
   * in-memory approval.
   */
  private write(port: number, record: ApprovalRecord): void {
    try {
      writePrivateFileAtomic(this.fileFor(port), JSON.stringify(record));
    } catch (err) {
      Logger.log(
        `Could not persist session approval (${(err as Error).message}) — it holds in memory for this process only.`,
      );
    }
  }

  /**
   * Parse this (cwd, port)'s file, or null if it's missing, torn, or not a record. `prune` says whether
   * an unparseable file may be deleted on the way out — true for the owner of the slot, false for a
   * probe of a port another process may hold (see `hasUnexpiredApproval`).
   */
  private read(port: number, prune: boolean): ApprovalRecord | null {
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
      if (prune) this.clear(port);
      return null;
    }
    // `authorizingUser` must be PRESENT (null is a valid value): a record without the field predates write
    // attribution, and reloading it would drive a session nobody can be billed or counted for. It
    // reads as corrupt, so the plugin re-prompts and the fresh Allow names its Authorizing User.
    if (
      typeof record !== "object" ||
      record === null ||
      typeof (record as ApprovalRecord).token !== "string" ||
      typeof (record as ApprovalRecord).lastUsedAt !== "number" ||
      !("authorizingUser" in record)
    ) {
      if (prune) this.clear(port);
      return null;
    }
    const approval = record as ApprovalRecord;
    return { ...approval, authorizingUser: parseAuthorizingUser(approval.authorizingUser) };
  }
}
