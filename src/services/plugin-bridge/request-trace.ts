/** Bounded diagnostic metadata, deliberately independent of request promises, clocks and sockets. */
export const HOST_TRACE_STAGES = new Set([
  "received",
  "eval-start",
  "eval-end",
  "operation-start",
  "operation-end",
  "native-start",
  "native-end",
  "native-error",
  "cancel-received",
  "result-sent",
]);
const OPERATIONS = new Set(["page-create", "page-switch", "font-load", "font-list"]);
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
  hostStage?: string;
  lastHostStage?: string;
  hostElapsedMs?: number;
  operation?: string;
}
interface RecordEntry {
  owner: object;
  started: number;
  ended?: number;
  events: TraceEvent[];
  emitted: number;
  lastHostStage?: string;
  lastOperation?: string;
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
  record(
    id: string,
    owner: object,
    stage: Stage,
    hostStage?: unknown,
    hostElapsedMs?: unknown,
    operation?: unknown,
  ): void {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return;
    if (stage === "host" && (typeof hostStage !== "string" || !HOST_TRACE_STAGES.has(hostStage)))
      return;
    if (stage === "late-reply") {
      if (entry.ended === undefined || entry.late) return;
      entry.late = true;
    } else if (entry.ended !== undefined && stage !== "host") return;
    if (stage === "host") entry.lastHostStage = hostStage as string;
    const terminal = [
      "timeout-inactivity",
      "timeout-ceiling",
      "caller-cancelled",
      "disconnected",
      "result",
      "error",
    ].includes(stage);
    const event: TraceEvent = { requestId: id, stage, elapsedMs: this.now() - entry.started };
    if (stage === "host") {
      event.hostStage = hostStage as string;
      if (typeof operation === "string" && OPERATIONS.has(operation)) event.operation = operation;
      entry.lastOperation = event.operation;
      if (
        typeof hostElapsedMs === "number" &&
        Number.isFinite(hostElapsedMs) &&
        hostElapsedMs >= 0 &&
        hostElapsedMs <= 3_600_000
      )
        event.hostElapsedMs = hostElapsedMs;
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
