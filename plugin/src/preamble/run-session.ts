/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The session this run executes in: the agent's `session` binding, and where flcm keeps what must
// outlive the run (session.ts movedIdsOf). Session initialization is pure; only its lifetime needs a host.
import { hostSession } from "./host.js";
import { createSession } from "./session.js";
export const runSession = hostSession(createSession);
