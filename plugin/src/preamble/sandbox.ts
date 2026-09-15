// The two bindings handed to agent code. Session initialization is pure; only its lifetime needs a host.
import { hostSession } from "./host.js";
import { createSession } from "./session.js";
export * as flcm from "./runtime.js";
export const session = hostSession(createSession);
