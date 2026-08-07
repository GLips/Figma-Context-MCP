import { z } from "zod";

// The figma_execute_code reply contract. Since protocol 2, images are fetched MID-RUN (the plugin
// issues IMAGES_REQUEST over the bridge and the sandbox awaits the bytes — see image-requests.ts
// and PluginBridge.serveImagesRequest), so a script executes exactly once and this reply is the
// whole story — no re-run signals, no second pass.

// The plugin always replies with this exact shape; parse it once so callers trust the type instead
// of re-checking each field. `result` is absent when the code returns nothing or throws: undefined
// isn't JSON, so it's dropped crossing the WS — optional, not required (a missing key is the
// error/void path).
export const ExecuteCodeReply = z.object({
  result: z.unknown().optional(),
  console: z.array(z.string()),
  errors: z.string().nullable(),
});
