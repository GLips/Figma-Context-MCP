/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { MAX_INTENT_LENGTH, parseIntent, type IntentProblem } from "@framelink/plugin/protocol";

declare const CALL_INTENT: unique symbol;

/**
 * What a plugin call says it is for, in one short line the human sees in the plugin panel: in the
 * activity feed and in any prompt the call raises. Display text only — it never selects a file or
 * grants anything.
 */
export type CallIntent = string & { readonly [CALL_INTENT]: true };

/** An agent's or a command line's intent, trimmed, or why it can't be one. */
export function parseCallIntent(
  raw: string | undefined,
): { kind: "intent"; intent: CallIntent } | { kind: "invalid"; problem: IntentProblem } {
  const parsed = parseIntent(raw);
  return parsed.kind === "intent"
    ? { kind: "intent", intent: parsed.intent as CallIntent }
    : parsed;
}

const INTENT_PROBLEM_TEXT: Record<IntentProblem, string> = {
  missing: "is required",
  empty: "is blank",
  "not-one-line": "has a line break or control character",
  "too-long": `is longer than ${MAX_INTENT_LENGTH} characters`,
};

/** Why `name` (the param or flag) was refused, and what a good one looks like. */
export function intentProblemText(problem: IntentProblem, name: string): string {
  return (
    `${name} ${INTENT_PROBLEM_TEXT[problem]}. It must be one line of plain text, at most ` +
    `${MAX_INTENT_LENGTH} characters, saying what this call is for, e.g. "Rebuild the pricing card ` +
    `with the new tokens". The user sees it in the Framelink plugin panel.`
  );
}
