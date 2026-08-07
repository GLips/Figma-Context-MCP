// The frozen envelope's reply shape: how one inbound server message becomes the reply that goes
// back out. Pure (no figma.*) so the non-leak invariant below is unit-testable; code.ts owns the
// postMessage that carries it.

export type ConnKey = number;

export interface InboundMessage {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * Everything needed to reply to one inbound message, derived from it once at dispatch: the
 * correlation `id`, and `connKey` — the local source-port tag ui.html attached, stamped back onto
 * the reply so ui.html sends it out on the socket the message arrived on.
 *
 * Negative space: nothing else from the inbound message reaches the reply, and no pass-through
 * namespace exists to put it in. The server correlates purely by `id`, and each session already has
 * its own socket (ui.html holds one per block port), so no message-level routing tag is needed.
 * Keeping a reply a function of the handler's body alone is what makes it structurally impossible
 * for a field the sandbox CONSUMES to ride back out onto the wire as if a newer server had attached
 * it — don't reintroduce a general echo without a consumer that demands one.
 */
export interface ReplyTo {
  id: string | undefined;
  connKey: ConnKey | undefined;
}

/** The source-port tag ui.html attached, or undefined if absent — one parse site for the routing
 * key, so the "is it a number" check and its absent-sentinel are defined once. */
export function connKeyOf(msg: InboundMessage): ConnKey | undefined {
  return typeof msg.__connKey === "number" ? msg.__connKey : undefined;
}

/** The single derivation site: the two — and only two — things a reply inherits from its request. */
export function replyTarget(msg: InboundMessage): ReplyTo {
  return { id: msg.id, connKey: connKeyOf(msg) };
}

/**
 * The outbound envelope for one reply: the handler's body, with the correlation `id` and
 * `__connKey` stamped last so a body field can't clobber either — every reply carries the id back
 * (frozen-envelope Invariant) and the source-port tag so ui.html routes it to the right socket.
 * `__connKey` is LOCAL: it never reaches a server, because ui.html strips it before ws.send.
 */
export function replyEnvelope(to: ReplyTo, body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, id: to.id, __connKey: to.connKey };
}
