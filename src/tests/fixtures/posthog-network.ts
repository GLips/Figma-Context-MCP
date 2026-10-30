import { vi } from "vitest";
import { closeTelemetry } from "~/telemetry/index.js";

/** One event as it reached PostHog's batch capture API. */
export type SentEvent = {
  event: string;
  distinct_id: string;
  uuid: string;
  timestamp: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read arbitrary properties
  properties: Record<string, any>;
};

const POSTHOG_ORIGIN = "https://us.i.posthog.com/";

/**
 * Stand in for the network at PostHog's capture API: every request to PostHog is recorded and
 * answered, every other request goes to `others` (the real fetch by default). Telemetry's own code,
 * the exporter included, runs for real.
 */
export function stubPostHogNetwork(others: typeof fetch = globalThis.fetch) {
  const events: SentEvent[] = [];
  let route = others;
  let answer: () => Response = () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(POSTHOG_ORIGIN)) return route(input, init);
    const response = answer();
    events.push(...(JSON.parse(String(init?.body)) as { batch: SentEvent[] }).batch);
    return response;
  });
  return {
    events,
    /** Where requests other than PostHog's go from now on. */
    routeOthers(fetchImpl: typeof fetch) {
      route = fetchImpl;
    },
    /** How PostHog answers from now on; a throw is a failed connection. */
    answerPostHog(respond: () => Response) {
      answer = respond;
    },
    /** Close telemetry, so everything queued is delivered, and return what PostHog received. */
    async delivered(): Promise<SentEvent[]> {
      await closeTelemetry(5_000);
      return events;
    },
  };
}
