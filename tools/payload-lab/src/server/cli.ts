import { root } from "./environment.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { CaptureLibrary, captureLive, captureRequest } from "./captures.js";
import { compareCapture } from "./replay.js";
import { baselineSchema } from "./app.js";
const dataDir = join(root, ".payload-lab"),
  library = new CaptureLibrary(join(dataDir, "captures"));
const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "list":
      console.log(JSON.stringify(await library.list(), null, 2));
      break;
    case "sample":
      console.log(
        JSON.stringify(
          await library.save(
            await readFile(join(root, "tools/payload-lab/samples/grouped-design.json")),
            {
              name: "Sample · rotated groups",
              kind: "sample",
              sourceUrl: "Local synthetic sample",
              fileKey: "sample",
              nodeIds: [],
              endpoint: "local sample",
            },
          ),
          null,
          2,
        ),
      );
      break;
    case "capture":
      console.log(
        JSON.stringify(
          await captureLive(library, captureRequest.parse({ url: args[0], name: args[1] }), {
            apiKey: process.env.FIGMA_API_KEY,
            oauthToken: process.env.FIGMA_OAUTH_TOKEN,
          }),
          null,
          2,
        ),
      );
      break;
    case "compare":
      console.log(
        JSON.stringify(
          await compareCapture(
            root,
            dataDir,
            library,
            args[0],
            baselineSchema.parse({ kind: args[1] ?? "main", ...(args[2] ? { ref: args[2] } : {}) }),
          ),
          null,
          2,
        ),
      );
      break;
    default:
      throw new Error(
        "Usage: runner list | sample | capture <url> <name> | compare <capture-id> <main|merge-base|previous|tag|commit> [ref]",
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Payload Lab failed.");
  process.exitCode = 1;
}
