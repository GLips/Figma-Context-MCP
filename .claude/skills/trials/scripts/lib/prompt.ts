import type { Track } from "./trial.ts";

// Placeholders a trial brief may use. Anything else in braces is left alone —
// briefs legitimately contain JSON-ish text.
export interface PromptVars {
  page: string;
  source?: string;
  file?: string;
  renders: string;
}

const PLACEHOLDER_HELP: Record<keyof PromptVars, string> = {
  page: "the new page this run creates (always available)",
  source:
    "the page this trial works from — set `needs: <trial>` (page from that trial's latest run) or `page: <literal>` in the trial's frontmatter",
  file: "the Figma file URL — set `figmaFileUrl` in trials/config.json",
  renders: "the renders directory (always available)",
};

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(/\{(page|source|file|renders)\}/g, (_, key: keyof PromptVars) => {
    const value = vars[key];
    if (value === undefined) {
      throw new Error(`brief uses {${key}} but it is unresolved: ${PLACEHOLDER_HELP[key]}`);
    }
    return value;
  });
}

// The craft track's framing. Names screenshots as the feedback loop without
// naming any tool — the agent still has to find `get_screenshot` on its own.
export const CRAFT_FRAMING = `Do your best work — this is a real brief someone would pay for. Iterate: look at what you have made, critique it honestly against the brief, and refine it. Produce two or three genuinely different variations, each on its own top-level frame, and finish by saying which one you would ship and why.`;

export function buildTrialPrompt(params: {
  brief: string;
  track: Track;
  vars: PromptVars;
}): string {
  const brief = renderPrompt(params.brief, params.vars);
  return params.track === "craft" ? `${brief}\n\n${CRAFT_FRAMING}` : brief;
}
