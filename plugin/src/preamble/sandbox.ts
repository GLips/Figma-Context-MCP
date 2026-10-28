/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The three bindings handed to agent code; the host makes `figma` per run, by calling agentFigma.
export * as flcm from "./runtime.js";
export { runSession as session } from "./run-session.js";
export { agentFigma } from "./agent-figma.js";
// Not for the agent — the host calls this one. It hands the agent's code only the three above,
// and keeps the drain for itself (run-executor.ts executeCode), so the reply cannot outrun a queued write.
// committedVerbCount is the host's too: read after the drain, a nonzero count means this run changed
// the document, known synchronously (run-executor.ts ORs it with the observed change events).
export { mutationQueueIdle } from "./mutation-lock.js";
export { committedVerbCount } from "./verb-error.js";

export { warnings } from "./warnings.js";
// The host's too: every result and console line leaves the run through it (egress.ts).
export { projectForEgress } from "./egress.js";
