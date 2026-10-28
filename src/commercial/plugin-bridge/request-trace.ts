/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { CallOperation, RunPhase, RunStatus } from "@framelink/plugin/protocol";

/** Bounded diagnostic metadata, deliberately independent of request promises, clocks and sockets. */
type Stage =
  | "submitted"
  | "status"
  | "timeout-inactivity"
  | "timeout-budget"
  | "caller-cancelled"
  | "withdrawn"
  | "disconnected"
  | "result"
  | "error"
  | "late-reply";
const TERMINAL: ReadonlySet<Stage> = new Set([
  "timeout-inactivity",
  "timeout-budget",
  "caller-cancelled",
  "withdrawn",
  "disconnected",
  "result",
  "error",
]);

/** A status reduced to counts and the oldest pending call's name: never agent data. */
interface StatusSummary {
  phase: RunPhase;
  /** Queued: runs in front of it. */
  ahead?: number;
  /** Running: the oldest pending call, and the calls settled. */
  operation?: CallOperation;
  callsSettled?: number;
}
export interface TraceEvent extends Partial<StatusSummary> {
  requestId: string;
  stage: Stage;
  elapsedMs: number;
}
interface RecordEntry {
  owner: object;
  started: number;
  ended?: number;
  events: TraceEvent[];
  emitted: number;
  /** The latest status, repeated on the terminal event so it survives a spent emit budget. */
  lastStatus?: StatusSummary;
  late: boolean;
}
const REQUEST_LIMIT = 128;
const EVENT_LIMIT = 32;
const RETAIN_MS = 60_000;

function summarize(status: RunStatus): StatusSummary {
  if (status.phase === "queued") return { phase: "queued", ahead: status.wait.ahead };
  const { oldestPending, callsSettled } = status.activity;
  const summary: StatusSummary = { phase: "running", callsSettled };
  if (oldestPending) summary.operation = oldestPending.operation;
  return summary;
}

/** A diagnostic log of each run's lifecycle and the statuses the plugin sent for it. */
export class RequestTrace {
  private entries = new Map<string, RecordEntry>();
  constructor(
    private readonly emit: (event: TraceEvent) => void,
    private readonly now = Date.now,
  ) {}
  start(id: string, owner: object): void {
    this.prune();
    while (this.entries.size >= REQUEST_LIMIT)
      this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, { owner, started: this.now(), events: [], emitted: 0, late: false });
    this.record(id, owner, "submitted");
  }
  record(id: string, owner: object, stage: Exclude<Stage, "status">): void {
    this.append(id, owner, stage);
  }
  recordStatus(id: string, owner: object, status: RunStatus): void {
    this.append(id, owner, "status", summarize(status));
  }
  private append(id: string, owner: object, stage: Stage, status?: StatusSummary): void {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return;
    if (stage === "late-reply") {
      if (entry.ended === undefined || entry.late) return;
      entry.late = true;
    } else if (entry.ended !== undefined) return;
    const terminal = TERMINAL.has(stage);
    if (status) entry.lastStatus = status;
    const event: TraceEvent = {
      requestId: id,
      stage,
      elapsedMs: this.now() - entry.started,
      ...(status ?? (terminal ? entry.lastStatus : undefined)),
    };
    entry.events.push(event);
    if (entry.events.length > EVENT_LIMIT) entry.events.shift();
    if (terminal) entry.ended = this.now();
    // A noisy peer cannot flood logs; terminal and first late-reply remain visible after the budget.
    if (entry.emitted < EVENT_LIMIT || terminal || stage === "late-reply") {
      entry.emitted++;
      this.emit(event);
    }
  }
  snapshot(id: string): readonly TraceEvent[] {
    this.prune();
    return this.entries.get(id)?.events.map((event) => ({ ...event })) || [];
  }
  private prune(): void {
    for (const [id, entry] of this.entries)
      if (entry.ended !== undefined && this.now() - entry.ended >= RETAIN_MS)
        this.entries.delete(id);
  }
}
