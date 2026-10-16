/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomInt } from "node:crypto";
import { isSessionHandle } from "@framelink/plugin/protocol";
import { SESSION_HANDLE_WORDS } from "./session-handle-words.js";

declare const SESSION_HANDLE: unique symbol;

/**
 * A handle naming one agent's flcm `session` in the plugin: minted here, or passed back by an agent
 * and checked at the edge. Not a credential — it separates agents that cooperate.
 */
export type SessionHandle = string & { readonly [SESSION_HANDLE]: true };

// Four words of 11 bits each: about 44 bits, so a handle left in an old transcript doesn't name a
// new session by chance.
const SESSION_HANDLE_WORD_COUNT = 4;

export function mintSessionHandle(): SessionHandle {
  return Array.from(
    { length: SESSION_HANDLE_WORD_COUNT },
    () => SESSION_HANDLE_WORDS[randomInt(SESSION_HANDLE_WORDS.length)],
  ).join("-") as SessionHandle;
}

/** An agent's or a command line's handle, or null when it isn't shaped like one. */
export function parseSessionHandle(raw: string): SessionHandle | null {
  return isSessionHandle(raw) ? (raw as SessionHandle) : null;
}
