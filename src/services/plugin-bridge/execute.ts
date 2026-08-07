import { z } from "zod";

// The figma_execute_code reply contract + outcome shaping: consent gating and result parsing, with
// the bridge/gate seams injected so it stays testable off-network. Since protocol 2, images are
// fetched MID-RUN (the plugin issues IMAGES_REQUEST over the bridge and the sandbox awaits the
// bytes — see image-requests.ts and PluginBridge.serveImagesRequest), so a script executes exactly
// once; the old fetch-inject-re-run state machine is gone, and with it the possibility of ever
// replaying a mutating script.

// The plugin always replies with this exact shape; parse it once so callers trust the type instead of
// re-checking each field. `result` is absent when the code returns nothing or throws: undefined isn't JSON,
// so it's dropped crossing the WS — optional, not required (a missing key is the error/void path).
//
// `imagesNeeded` is a TRIPWIRE, not a feature: it was the retired two-pass protocol's "fetch and
// re-run me" signal, and only a pre-v2 plugin still emits it. The connect-time skew gate refuses
// such plugins, but a write racing in before that handshake resolves can slip past it — this field
// is how that race still fails loud (see executeAgentCode) instead of silently returning nothing.
export const ExecuteCodeReply = z.object({
  result: z.unknown().optional(),
  console: z.array(z.string()),
  errors: z.string().nullable(),
  imagesNeeded: z.array(z.string()).nullish(),
});

export type ExecuteCodeReplyT = z.infer<typeof ExecuteCodeReply>;

export type GatedResult = { content: { type: "text"; text: string }[] };

export type ExecuteOutcome =
  | { kind: "gated"; result: GatedResult }
  | { kind: "reply"; reply: ExecuteCodeReplyT }
  | { kind: "error"; message: string };

// The seams executeAgentCode drives, injected for off-network tests: `request` runs code in the
// sandbox (one pass — mid-run image fetches ride the bridge underneath it), `gate` maps a consent
// refusal to its agent-facing text (or null).
export interface ExecuteDeps {
  request: (code: string) => Promise<unknown>;
  gate: (reply: unknown) => GatedResult | null;
}

/**
 * Run the agent's code once and shape the outcome: consent gate first, then the parsed reply.
 * A reply carrying the retired `imagesNeeded` sentinel means a pre-v2 plugin ran the code before
 * the skew gate could refuse it — surface the re-import fix loudly rather than returning a result
 * the run never produced.
 */
export async function executeAgentCode(code: string, deps: ExecuteDeps): Promise<ExecuteOutcome> {
  const raw = await deps.request(code);
  const gated = deps.gate(raw);
  if (gated) return { kind: "gated", result: gated };
  const reply = ExecuteCodeReply.parse(raw);
  if (reply.imagesNeeded && reply.imagesNeeded.length > 0) {
    return {
      kind: "error",
      message:
        "The connected Framelink plugin is out of date: it answered with the retired two-pass image " +
        "protocol, which this server no longer speaks. Nothing was rendered. Fix: in Figma desktop, " +
        "re-import the latest plugin (Plugins → Development → Import plugin from manifest…) and retry.",
    };
  }
  return { kind: "reply", reply };
}
