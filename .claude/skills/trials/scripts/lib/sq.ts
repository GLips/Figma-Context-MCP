// Thin shell over the sidequest CLI. Every spawn/drive/read of the trial
// session goes through `sq` — this skill deliberately owns no tmux or
// transcript logic of its own.

export interface SqResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function sq(args: string[], opts: { stdin?: string } = {}): Promise<SqResult> {
  const proc = Bun.spawn(["sq", ...args], {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

export async function sqOrThrow(args: string[], opts: { stdin?: string } = {}): Promise<string> {
  const r = await sq(args, opts);
  if (r.code !== 0) {
    throw new Error(`sq ${args[0]} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

export interface SqStartResult {
  slug: string;
  child_pane: string;
  session_id: string;
}

export async function sqStart(params: {
  slug: string;
  primePath: string;
  cwd: string;
  model?: string;
}): Promise<SqStartResult> {
  const args = [
    "start",
    "--slug",
    params.slug,
    "--prime",
    params.primePath,
    "--layout",
    "new-window",
    "--cwd",
    params.cwd,
    "--wait",
  ];
  if (params.model) args.push("--model", params.model);
  return JSON.parse(await sqOrThrow(args));
}

// Send a prompt and block until the turn settles. Prompts go via stdin so a
// multi-paragraph brief never fights the shell.
export async function sqSendAndWait(slug: string, prompt: string): Promise<void> {
  await sqOrThrow(["send", slug, "-", "--wait"], { stdin: prompt });
}

export async function sqLastText(slug: string): Promise<string> {
  const out = JSON.parse(await sqOrThrow(["last", slug, "--json"]));
  return out.last_text ?? "";
}

// Raw `sq tail` text for the whole session, tool blocks only — parsed by
// transcript-stats. `--last` is a block cap, set far above any real session.
export async function sqToolBlocks(slug: string): Promise<string> {
  return sqOrThrow(["tail", slug, "--type", "tool_use,tool_result", "--last", "100000"]);
}
