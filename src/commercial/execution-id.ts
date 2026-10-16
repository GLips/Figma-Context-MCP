/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomUUID } from "node:crypto";

declare const EXECUTION_ID: unique symbol;

/**
 * One execution's name, end to end: the run's id on the wire, the key its cancellation, reverse calls
 * and late events are matched by, and the id its Write is recorded and reported under. Minted once per
 * call by this server, and never resubmitted once the plugin admitted the run.
 */
export type ExecutionId = string & { readonly [EXECUTION_ID]: true };

export function mintExecutionId(): ExecutionId {
  return randomUUID() as ExecutionId;
}
