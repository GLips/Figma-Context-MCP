import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A command whose output didn't all arrive must not report success, however it ended itself.
it("a command that succeeds into a closed pipe exits 141, as `cmd | head` expects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flcm-output-"));
  await writeFile(join(dir, ".env"), "");
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "reference", "mental-model", "--env", join(dir, ".env")],
      {
        env: {
          ...process.env,
          FRAMELINK_TELEMETRY: "off",
          FRAMELINK_STATE_DIR: join(dir, "state"),
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    // The reader is gone before the command writes a byte.
    child.stdout.destroy();
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(141);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
