// Delivers telemetry events to PostHog's batch capture API (POST /batch/), shaped like
// OpenTelemetry's BatchSpanProcessor: `send` only enqueues into a bounded queue, a timer and a
// size threshold flush it in batches, and `close` gives delivery one deadline, then aborts every
// request and retry timer, so nothing it started outlives it.
//
// Silent by design: a failed delivery drops its events and never prints. Telemetry that writes to
// the console corrupts the output it rides along with (stdio MCP, a CLI's piped stdout).
import { randomUUID } from "node:crypto";

/** One event as the capture API takes it; the exporter adds `uuid` and `timestamp`. */
export type ExportedEvent = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
};

export type ConfirmedSend = { kind: "sent" } | { kind: "off" } | { kind: "failed"; reason: string };

export interface TelemetryExporter {
  /** Queue an event for the next batch. Never blocks, never throws; dropped when the queue is full. */
  send(event: ExportedEvent): void;
  /**
   * Post one event now and say whether PostHog took it, within `deadlineMs`. Settles `failed`
   * when the deadline passes or `close` cuts it off first.
   */
  sendConfirmed(
    event: ExportedEvent,
    deadlineMs: number,
  ): Promise<Exclude<ConfirmedSend, { kind: "off" }>>;
  /** Deliver what is queued within `deadlineMs`, then abort whatever is still going. Idempotent. */
  close(deadlineMs: number): Promise<void>;
}

// PostHog takes up to 1 MB per event and 20 MB per request; the queue bounds what a process holds
// while the network is down.
const MAX_EVENT_BYTES = 1_000_000;
const MAX_QUEUE_EVENTS = 1_000;
const MAX_QUEUE_BYTES = 5_000_000;
const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 2_000_000;
const FLUSH_AT_EVENTS = 20;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

type QueuedEvent = { json: string; bytes: number };

type PostOutcome = { kind: "sent" } | { kind: "failed"; reason: string; transient: boolean };

export function createPostHogExporter({
  host,
  apiKey,
  flushIntervalMs,
}: {
  host: string;
  apiKey: string;
  /** How often the queue is flushed while the process runs; `close` flushes the rest. */
  flushIntervalMs: number;
}): TelemetryExporter {
  const url = `${host}/batch/`;
  const queue: QueuedEvent[] = [];
  let queuedBytes = 0;
  let flushing: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  const confirmedInFlight = new Set<Promise<unknown>>();
  // Aborted once close's deadline passes: every request and retry sleep listens to it.
  const closed = new AbortController();
  // Unref'd: an idle timer must never keep a process alive.
  const timer = setInterval(() => void flush(), flushIntervalMs);
  timer.unref();

  function serialize(event: ExportedEvent): QueuedEvent {
    // The uuid is fixed here, so a retried batch is deduplicated rather than counted twice.
    const json = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
      uuid: randomUUID(),
    });
    return { json, bytes: Buffer.byteLength(json) };
  }

  function flush(): Promise<void> {
    flushing ??= drain().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0 && !closed.signal.aborted) {
      const batch: QueuedEvent[] = [];
      let bytes = 0;
      while (
        queue.length > 0 &&
        batch.length < MAX_BATCH_EVENTS &&
        (batch.length === 0 || bytes + queue[0].bytes <= MAX_BATCH_BYTES)
      ) {
        const next = queue.shift()!;
        queuedBytes -= next.bytes;
        bytes += next.bytes;
        batch.push(next);
      }
      // A batch that fails for good is dropped: best-effort events are never re-queued.
      await postWithRetries(batch, closed.signal);
    }
  }

  async function postWithRetries(batch: QueuedEvent[], signal: AbortSignal): Promise<PostOutcome> {
    for (let attempt = 1; ; attempt++) {
      const outcome = await postOnce(batch, signal);
      if (outcome.kind === "sent" || !outcome.transient || attempt >= MAX_ATTEMPTS) return outcome;
      if (!(await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal)))
        return { kind: "failed", reason: abortReason(signal), transient: false };
    }
  }

  async function postOnce(batch: QueuedEvent[], signal: AbortSignal): Promise<PostOutcome> {
    if (signal.aborted) return { kind: "failed", reason: abortReason(signal), transient: false };
    const body = `{"api_key":${JSON.stringify(apiKey)},"sent_at":${JSON.stringify(new Date().toISOString())},"batch":[${batch.map((event) => event.json).join(",")}]}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      // Read to the end, so the connection is released rather than held by an unread body.
      await response.arrayBuffer();
      if (response.ok) return { kind: "sent" };
      const { status } = response;
      return {
        kind: "failed",
        reason: `HTTP ${status}`,
        transient: status === 408 || status === 429 || status >= 500,
      };
    } catch (error) {
      if (signal.aborted) return { kind: "failed", reason: abortReason(signal), transient: false };
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : String(error);
      return { kind: "failed", reason, transient: true };
    }
  }

  return {
    send(event) {
      if (closing) return;
      const queued = serialize(event);
      if (queued.bytes > MAX_EVENT_BYTES) return;
      queue.push(queued);
      queuedBytes += queued.bytes;
      // Oldest first: when the network is down, the newest events say most about now.
      while (queue.length > MAX_QUEUE_EVENTS || queuedBytes > MAX_QUEUE_BYTES) {
        queuedBytes -= queue.shift()!.bytes;
      }
      if (queue.length >= FLUSH_AT_EVENTS) void flush();
    },

    sendConfirmed(event, deadlineMs) {
      if (closing) return Promise.resolve({ kind: "failed", reason: "telemetry is closed" });
      const queued = serialize(event);
      const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(deadlineMs)]);
      const settled = postWithRetries([queued], signal).then(
        (outcome): Exclude<ConfirmedSend, { kind: "off" }> =>
          outcome.kind === "sent" ? outcome : { kind: "failed", reason: outcome.reason },
      );
      confirmedInFlight.add(settled);
      void settled.finally(() => confirmedInFlight.delete(settled));
      return settled;
    },

    close(deadlineMs) {
      closing ??= (async () => {
        clearInterval(timer);
        const deadline = setTimeout(
          () => closed.abort(new Error("telemetry closed before it was sent")),
          deadlineMs,
        );
        try {
          await Promise.all([flush(), ...confirmedInFlight]);
        } finally {
          clearTimeout(deadline);
          closed.abort(new Error("telemetry closed before it was sent"));
        }
      })();
      return closing;
    },
  };
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError")
    return "no answer before its deadline";
  return reason instanceof Error ? reason.message : "aborted";
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
