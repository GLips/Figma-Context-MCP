/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The server's half of session identity. The plugin is the sole arbiter: it owns the durable
// approval decision, and the server only introduces itself so the human in Figma can recognize the
// session they are approving.
//
// SESSION_IDENTITY is the project path the server runs in: a human-readable LABEL the human
// recognizes in the panel ("only approve sessions you started"), never an auth key. Sticky approval
// keys on the plugin-minted session token instead (approval-session.ts).

export const SESSION_IDENTITY = process.cwd();
