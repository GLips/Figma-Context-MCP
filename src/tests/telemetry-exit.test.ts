import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTelemetry, initTelemetry, sendIssueReport } from "~/telemetry/index.js";

// Telemetry must never hold a process: whatever the network does, delivery ends at close's deadline.

afterEach(() => vi.unstubAllGlobals());

it("a CLI command exits within its telemetry budget when PostHog's route never answers", async () => {
  // A proxy that accepts every connection and never says a word: the silent-drop network.
  const held: Socket[] = [];
  const blackhole = createServer((socket) => void held.push(socket));
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const { port } = blackhole.address() as { port: number };
  const dir = await mkdtemp(join(tmpdir(), "flcm-exit-"));
  await writeFile(join(dir, ".env"), "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    FRAMELINK_STATE_DIR: join(dir, "state"),
  };
  for (const name of ["NO_PROXY", "no_proxy", "DO_NOT_TRACK", "FRAMELINK_TELEMETRY"])
    delete env[name];
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "reference", "mental-model", "--env", join(dir, ".env")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let printedAt = 0;
    child.stdout.on("data", () => (printedAt ||= Date.now()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    const exitedAt = Date.now();

    expect(code).toBe(0);
    expect(printedAt).toBeGreaterThan(0);
    // The command's event did set out for PostHog, through the proxy that swallowed it.
    expect(held.length).toBeGreaterThan(0);
    expect(exitedAt - printedAt).toBeLessThan(2_500);
  } finally {
    for (const socket of held) socket.destroy();
    blackhole.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

it("a confirmed send still in flight settles as failed when telemetry closes", async () => {
  // A request the network never answers: it ends only when its signal aborts.
  vi.stubGlobal(
    "fetch",
    (_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      ),
  );
  initTelemetry({ enabled: true });
  const report = sendIssueReport(
    { kind: "friction", summary: "Slow", attempted: "Export" },
    { transport: "cli", authMode: "none" },
  );

  const closedAt = Date.now();
  await closeTelemetry(200);
  expect(Date.now() - closedAt).toBeLessThan(1_000);
  expect(await report).toMatchObject({ kind: "failed" });
});
