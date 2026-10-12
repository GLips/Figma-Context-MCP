/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The two bindings handed to agent code. Session initialization is pure; only its lifetime needs a host.
import { hostSession } from "./host.js";
import { createSession } from "./session.js";
export * as flcm from "./runtime.js";
export const session = hostSession(createSession);
// Not for the agent — the host calls this one. It hands the agent's code only `flcm` and `session`,
// and keeps the drain for itself (run-executor.ts executeCode), so the reply cannot outrun a queued write.
// committedVerbCount is the host's too: read after the drain, a nonzero count means this run changed
// the document, known synchronously (run-executor.ts ORs it with the observed change events).
export { mutationQueueIdle } from "./mutation-lock.js";
export { committedVerbCount } from "./verb-error.js";

export { warnings } from "./warnings.js";
// The host's too: every result and console line leaves the run through it (egress.ts).
export { projectForEgress } from "./egress.js";
