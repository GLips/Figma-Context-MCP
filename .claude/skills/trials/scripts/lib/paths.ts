import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SKILL_DIR = resolve(import.meta.dir, "../..");
export const REPO_ROOT = resolve(SKILL_DIR, "../../..");

// Trial definitions ship with the skill (version-controlled). Everything a run
// produces lands under the repo's gitignored `trials/` scratchpad — reports are
// Graham's triage artifacts, like `docs/`, not part of the shipped package.
export const TRIAL_DEFS_DIR = join(SKILL_DIR, "definitions");
export const REFERENCES_DIR = join(SKILL_DIR, "references");
export const LOCAL_DIR = join(REPO_ROOT, "trials");
export const REPORTS_DIR = join(LOCAL_DIR, "reports");
export const RUNS_DIR = join(LOCAL_DIR, "runs");
export const CONFIG_PATH = join(LOCAL_DIR, "config.json");

// The trial agent's cwd. Lives outside every repo so the agent can't read the
// plugin source or schema, and is a fixed path so Graham trusts it in Claude
// Code once — project settings in an untrusted folder are ignored, which is
// what made a per-run tmp dir prompt for MCP approval on every run.
export const SCRATCH_DIR = join(homedir(), ".framelink", "trials");
export const RENDERS_DIR = join(SCRATCH_DIR, "renders");

export const DEFAULT_MCP_URL = "http://127.0.0.1:3333/mcp";
export const MCP_SERVER_NAME = "framelink-mcp";
