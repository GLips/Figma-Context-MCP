import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TRIAL_DEFS_DIR } from "./paths.ts";

export type Track = "ergo" | "craft";
export type Surface = "create" | "read" | "edit" | "component" | "cross-session";

const SURFACES: Surface[] = ["create", "read", "edit", "component", "cross-session"];

export interface TrialDefinition {
  name: string;
  path: string;
  surface: Surface;
  // Another trial whose latest run produced the page this one works on.
  needs?: string;
  // A literal page name a designer made by hand (messy-file, design-system trials).
  page?: string;
  // Ticket ref the trial waits on; `run` refuses while set.
  blocked?: string;
  brief: string;
  followUp?: string;
  rubric?: string;
}

export function parseTrial(text: string, name: string, path: string): TrialDefinition {
  const { frontmatter, body } = splitFrontmatter(text, name);
  const sections = splitSections(body);

  const surface = frontmatter.surface;
  if (!SURFACES.includes(surface as Surface)) {
    throw new Error(`${name}: surface must be one of ${SURFACES.join("|")}, got "${surface}"`);
  }
  const brief = sections.get("Brief");
  if (!brief) throw new Error(`${name}: missing "## Brief" section`);

  return {
    name,
    path,
    surface: surface as Surface,
    needs: frontmatter.needs,
    page: frontmatter.page,
    blocked: frontmatter.blocked,
    brief,
    followUp: sections.get("Follow-up"),
    rubric: sections.get("Rubric"),
  };
}

export function loadTrial(name: string): TrialDefinition {
  const path = join(TRIAL_DEFS_DIR, `${name}.md`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    const known = listTrials()
      .map((t) => t.name)
      .join(", ");
    throw new Error(`No trial named "${name}". Known: ${known}`);
  }
  return parseTrial(text, name, path);
}

export function listTrials(): TrialDefinition[] {
  return readdirSync(TRIAL_DEFS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const path = join(TRIAL_DEFS_DIR, f);
      return parseTrial(readFileSync(path, "utf8"), basename(f, ".md"), path);
    });
}

function splitFrontmatter(
  text: string,
  name: string,
): { frontmatter: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${name}: missing frontmatter block`);
  const frontmatter: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    if (!line.trim()) continue;
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) throw new Error(`${name}: bad frontmatter line "${line}"`);
    frontmatter[kv[1]!] = kv[2]!.trim();
  }
  return { frontmatter, body: m[2]! };
}

function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, buf.join("\n").trim());
  };
  for (const line of body.split("\n")) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      flush();
      current = h[1]!.trim();
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}
