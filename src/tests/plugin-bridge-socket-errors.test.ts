import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["unhandshaked", "active-error", "disconnect"])(
  "real socket %s cleans up and the bridge process accepts another connection",
  async (mode) => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/channel-socket-process.ts", import.meta.url)),
        mode,
      ],
      { timeout: 10_000 },
    );
    expect(result.stdout).toContain(`PASS ${mode}`);
  },
  15_000,
);
