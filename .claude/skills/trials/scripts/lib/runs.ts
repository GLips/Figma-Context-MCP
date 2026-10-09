import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, RUNS_DIR } from "./paths.ts";
import type { Surface, Track } from "./trial.ts";

// One record per run, written at spawn and updated as the run advances. The
// sidequest slug is the run's identity everywhere: `interview <slug>` and
// `report <slug>` both start from this file.
export interface RunRecord {
  slug: string;
  trial: string;
  track: Track;
  surface: Surface;
  model: string;
  page: string;
  source?: string;
  prompt: string;
  followUp?: string;
  cwd: string;
  sessionId?: string;
  startedAt: string;
  builtAt?: string;
  interviewedAt?: string;
  interview?: string;
}

export interface LocalConfig {
  figmaFileUrl?: string;
}

export function loadLocalConfig(): LocalConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function runPath(slug: string): string {
  return join(RUNS_DIR, `${slug}.json`);
}

export function saveRun(record: RunRecord): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(runPath(record.slug), JSON.stringify(record, null, 2) + "\n");
}

export function loadRun(slug: string): RunRecord {
  const path = runPath(slug);
  if (!existsSync(path)) {
    throw new Error(
      `No run record for "${slug}" at ${path}. Known: ${
        listRuns()
          .map((r) => r.slug)
          .join(", ") || "(none)"
      }`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function listRuns(): RunRecord[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) as RunRecord)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// The page a `needs:` trial works on: the newest run of the needed trial that
// got as far as building. An interview-less run still counts — the page exists.
export function latestBuiltRunOf(trialName: string): RunRecord | undefined {
  return listRuns()
    .filter((r) => r.trial === trialName && r.builtAt)
    .at(-1);
}
