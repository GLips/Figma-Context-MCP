/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { ConnKey } from "./panel.js";
import type { PluginFrame, PluginReply } from "./protocol.js";

/** Post one frame to a server, on the socket generation it belongs to. */
export function toServer(connKey: ConnKey, frame: PluginFrame): void {
  figma.ui.postMessage({ to: "server", connKey, frame });
}

/**
 * Everything a reply inherits from its request, derived once at dispatch: the correlation `id`, and
 * `connKey` — the socket generation the request arrived on, which the reply goes out on.
 *
 * Negative space: nothing else crosses over, and there is deliberately no pass-through namespace to
 * put it in. The server correlates by `id` alone, and each session already has its own socket, so a
 * reply being a function of the handler's body is what makes it structurally impossible for a field
 * the sandbox CONSUMES to ride back out as if a newer server had attached it. Don't reintroduce a
 * general echo without a consumer that demands one.
 */
export interface ReplyTo {
  id: string;
  connKey: ConnKey;
}

/**
 * The single reply path: the handler's body, with the correlation `id` (the frozen-envelope
 * Invariant) stamped last so a body field can't clobber it.
 */
export function reply(to: ReplyTo, body: PluginReply): void {
  toServer(to.connKey, { ...body, id: to.id });
}
