/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Plugin runs no MCP call is waiting on. A call that checks in before its run ends detaches only its
// WAITER: the run, its services and its charge carry on, and this registry owns its outcome until an
// agent fetches it with await_figma_execution. In memory only: a server restart forgets every handle,
// which an await of one must word as "outcome unavailable", never as "didn't run".
//
// The statuses are MCP Tasks' (modelcontextprotocol.io/extensions/tasks), and a handle is shaped to
// serve as a taskId, so adopting that extension later changes the transport, not the model.
import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionHandle } from "~/commercial/plugin-bridge/session-handle.js";

declare const RUN_HANDLE: unique symbol;

/**
 * Names one detached run to the agent that started it. Unpredictable: holding one is what lets a
 * caller fetch or cancel the run. Shaped unlike a four-word session handle, so neither passes for
 * the other.
 */
export type RunHandle = string & { readonly [RUN_HANDLE]: true };

// 32 symbols, so a random byte masked to 5 bits is uniform; no l, o, 0 or 1 to misread.
const RUN_HANDLE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
// 20 symbols of 5 bits: 100 bits.
const RUN_HANDLE_LENGTH = 20;
const RUN_HANDLE_PATTERN = new RegExp(`^run-[${RUN_HANDLE_ALPHABET}]{${RUN_HANDLE_LENGTH}}$`);

export function mintRunHandle(): RunHandle {
  const symbols = [...randomBytes(RUN_HANDLE_LENGTH)].map((b) => RUN_HANDLE_ALPHABET[b & 31]);
  return `run-${symbols.join("")}` as RunHandle;
}

/** An agent's handle, or null when it isn't shaped like one. */
export function parseRunHandle(raw: string): RunHandle | null {
  return RUN_HANDLE_PATTERN.test(raw) ? (raw as RunHandle) : null;
}

/** MCP Tasks' status vocabulary. */
export type DetachedRunStatus = "working" | "completed" | "failed" | "cancelled";

/** What a run ends with: the reply its tool returns, and the session it ran in (code runs only). */
export interface DetachedRunOutcome {
  reply: CallToolResult;
  session: SessionHandle | null;
}

export type DetachedRunKind = "code" | "screenshot";

interface WorkingRun<Run> {
  handle: RunHandle;
  scope: object;
  kind: DetachedRunKind;
  run: Run;
  finished: Promise<DetachedRunOutcome>;
  cancelRequested: boolean;
}

interface FinishedRun {
  status: Exclude<DetachedRunStatus, "working">;
  kind: DetachedRunKind;
  scope: object;
  outcome: DetachedRunOutcome;
  completedAt: number;
  bytes: number;
}

/** A finished run whose result is gone: what an await of it can still say. */
interface RunTombstone {
  scope: object;
  kind: DetachedRunKind;
  session: SessionHandle | null;
  reason: "expired" | "evicted";
}

export type DetachedRunLookup<Run> =
  | { state: "working"; working: WorkingRun<Run> }
  | { state: "finished"; status: FinishedRun["status"]; outcome: DetachedRunOutcome }
  | (Omit<RunTombstone, "scope"> & { state: "gone" })
  | { state: "unknown" };

export interface DetachedRunLimits {
  /** How long a result is held after its run finished. */
  resultTtlMs: number;
  maxResults: number;
  maxResultBytes: number;
  maxTombstones: number;
  /** Detached runs still working, per scope, past which a new call isn't started. */
  maxWorking: number;
}

export const DETACHED_RUN_LIMITS: DetachedRunLimits = {
  resultTtlMs: 10 * 60_000,
  maxResults: 20,
  maxResultBytes: 64 * 1024 * 1024,
  // A tombstone is a few dozen bytes; enough to outlast any transcript an agent still acts on.
  maxTombstones: 1_000,
  // The plugin runs one call at a time per file, so a handful already means a long queue.
  maxWorking: 8,
};

/**
 * Every detached run of this process, shared by every MCP server instance in it. `scope` is the
 * caller's own plugin runtime: a handle resolves only for the caller that minted it.
 */
export class DetachedRunRegistry<Run> {
  private readonly working = new Map<RunHandle, WorkingRun<Run>>();
  // In completion order, so the oldest result is always first: expiry and eviction read from the front.
  private readonly finished = new Map<RunHandle, FinishedRun>();
  private readonly tombstones = new Map<RunHandle, RunTombstone>();
  private resultBytes = 0;

  constructor(
    private readonly limits: DetachedRunLimits = DETACHED_RUN_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Handles of `scope`'s detached runs still working. */
  workingHandles(scope: object): RunHandle[] {
    return [...this.working.values()].filter((w) => w.scope === scope).map((w) => w.handle);
  }

  get maxWorking(): number {
    return this.limits.maxWorking;
  }

  get resultTtlMs(): number {
    return this.limits.resultTtlMs;
  }

  /** Take over a run no call waits on any longer. Its outcome is kept once `finished` settles. */
  detach(
    scope: object,
    kind: DetachedRunKind,
    run: Run,
    finished: Promise<DetachedRunOutcome>,
  ): RunHandle {
    const handle = mintRunHandle();
    const entry: WorkingRun<Run> = {
      handle,
      scope,
      kind,
      run,
      finished,
      cancelRequested: false,
    };
    this.working.set(handle, entry);
    finished.then(
      (outcome) => this.complete(entry, outcome),
      // A bug in the run's own path: kept as the failure the original call would have thrown.
      (error: unknown) =>
        this.complete(entry, {
          reply: { isError: true, content: [{ type: "text", text: String(error) }] },
          session: null,
        }),
    );
    return handle;
  }

  /** Mark a working run's outcome as cancelled once it settles. */
  markCancelRequested(working: WorkingRun<Run>): void {
    working.cancelRequested = true;
  }

  lookup(scope: object, handle: RunHandle): DetachedRunLookup<Run> {
    this.sweep();
    const working = this.working.get(handle);
    if (working?.scope === scope) return { state: "working", working };
    const finished = this.finished.get(handle);
    if (finished?.scope === scope)
      return { state: "finished", status: finished.status, outcome: finished.outcome };
    const tombstone = this.tombstones.get(handle);
    if (tombstone?.scope === scope) {
      const { kind, session, reason } = tombstone;
      return { state: "gone", kind, session, reason };
    }
    return { state: "unknown" };
  }

  private complete(entry: WorkingRun<Run>, outcome: DetachedRunOutcome): void {
    this.working.delete(entry.handle);
    const status = !outcome.reply.isError
      ? "completed"
      : entry.cancelRequested
        ? "cancelled"
        : "failed";
    const bytes = replyBytes(outcome.reply);
    this.finished.set(entry.handle, {
      status,
      kind: entry.kind,
      scope: entry.scope,
      outcome,
      completedAt: this.now(),
      bytes,
    });
    this.resultBytes += bytes;
    this.sweep();
    // Oldest first, and a single result over the byte cap evicts even itself.
    while (
      this.finished.size > this.limits.maxResults ||
      this.resultBytes > this.limits.maxResultBytes
    )
      this.bury(this.finished.keys().next().value!, "evicted");
    // Frees an expired result's memory even if nobody asks for anything again.
    setTimeout(() => this.sweep(), this.limits.resultTtlMs).unref();
  }

  private sweep(): void {
    const expiredBefore = this.now() - this.limits.resultTtlMs;
    for (const [handle, finished] of this.finished) {
      if (finished.completedAt > expiredBefore) break;
      this.bury(handle, "expired");
    }
  }

  private bury(handle: RunHandle, reason: RunTombstone["reason"]): void {
    const finished = this.finished.get(handle)!;
    this.finished.delete(handle);
    this.resultBytes -= finished.bytes;
    this.tombstones.set(handle, {
      scope: finished.scope,
      kind: finished.kind,
      session: finished.outcome.session,
      reason,
    });
    if (this.tombstones.size > this.limits.maxTombstones)
      this.tombstones.delete(this.tombstones.keys().next().value!);
  }
}

/** Roughly what a reply holds in memory: its text and its base64 image data. */
function replyBytes(reply: CallToolResult): number {
  let bytes = 0;
  for (const item of reply.content)
    if (item.type === "text") bytes += item.text.length * 2;
    else if (item.type === "image") bytes += item.data.length;
  return bytes;
}
