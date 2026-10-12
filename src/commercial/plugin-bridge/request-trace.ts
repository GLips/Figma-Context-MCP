/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { HostTraceStage, NativeOperation, PluginEvent } from "@framelink/plugin/protocol";

/** Bounded diagnostic metadata, deliberately independent of request promises, clocks and sockets. */
type Stage =
  | "submitted"
  | "queued"
  | "running"
  | "timeout-inactivity"
  | "timeout-ceiling"
  | "caller-cancelled"
  | "disconnected"
  | "result"
  | "error"
  | "late-reply"
  | "host";
export interface TraceEvent {
  requestId: string;
  stage: Stage;
  elapsedMs: number;
  hostStage?: HostTraceStage;
  lastHostStage?: HostTraceStage;
  hostElapsedMs?: number;
  operation?: NativeOperation;
}
/** A RUN_TRACE as the protocol admitted it — only a known stage and a bounded elapsed time. */
export type HostTrace = Omit<Extract<PluginEvent, { type: "RUN_TRACE" }>, "type" | "runId">;
interface RecordEntry {
  owner: object;
  started: number;
  ended?: number;
  events: TraceEvent[];
  emitted: number;
  lastHostStage?: HostTraceStage;
  lastOperation?: NativeOperation;
  late: boolean;
}
const REQUEST_LIMIT = 128;
const EVENT_LIMIT = 32;
const RETAIN_MS = 60_000;
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
  record(id: string, owner: object, stage: Exclude<Stage, "host">): void {
    this.append(id, owner, stage);
  }
  recordHost(id: string, owner: object, host: HostTrace): void {
    this.append(id, owner, "host", host);
  }
  private append(id: string, owner: object, stage: Stage, host?: HostTrace): void {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return;
    if (stage === "late-reply") {
      if (entry.ended === undefined || entry.late) return;
      entry.late = true;
    } else if (entry.ended !== undefined && !host) return;
    if (host) entry.lastHostStage = host.stage;
    const terminal = [
      "timeout-inactivity",
      "timeout-ceiling",
      "caller-cancelled",
      "disconnected",
      "result",
      "error",
    ].includes(stage);
    const event: TraceEvent = { requestId: id, stage, elapsedMs: this.now() - entry.started };
    if (host) {
      event.hostStage = host.stage;
      event.hostElapsedMs = host.elapsedMs;
      if (host.operation) event.operation = host.operation;
      entry.lastOperation = host.operation;
    }
    if (terminal && entry.lastHostStage) event.lastHostStage = entry.lastHostStage;
    if (terminal && entry.lastOperation) event.operation = entry.lastOperation;
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
