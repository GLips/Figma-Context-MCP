/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The key a designTokens entry gains on its way out of a run, naming which kind of entry it is. The
// server renders each marked object as one token line, so a listing reads as a compact tree while
// everything else in the reply stays JSON. Shared by name: the preamble adds the key, the server
// (src/commercial/tools/token-tree.ts) reads and drops it.
//
// The mark is added only by the entry's registered read projection (runtime.ts), so it rides an entry
// object designTokens returned, untouched, wherever the agent put it — never a copy the agent built,
// and never an object that merely looks like an entry. Inside the script the entries stay plain data.

export const TOKEN_ENTRY_MARK = "__flcmToken";
export type TokenEntryKind = "variable" | "style";
