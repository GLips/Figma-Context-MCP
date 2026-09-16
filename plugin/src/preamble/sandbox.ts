// The two bindings handed to agent code. Session initialization is pure; only its lifetime needs a host.
import { hostSession } from "./host.js";
import { createSession } from "./session.js";
export * as flcm from "./runtime.js";
export const session = hostSession(createSession);
// Not for the agent — the host calls this one. It hands the agent's code only `flcm` and `session`,
// and keeps the drain for itself (code.ts executeCode), so the reply cannot outrun a queued write.
export { mutationQueueIdle } from "./mutation-lock.js";

export { warnings } from "./warnings.js";
