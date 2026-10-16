/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Link setup: everything between accepting a socket and driving it. HELLO (an exact protocol check),
// then AUTHENTICATE (proof the link holds this state dir's installation credential), and for a link
// that can't prove it yet, the pairing attempt that provisions the credential. Until a link
// authenticates it is sent only this envelope.
import { Logger } from "~/utils/logger.js";
import {
  PROTOCOL_VERSION,
  type LINK_SETUP_REQUEST_TYPES,
  type ReplyFor,
  type ServerRequest,
} from "@framelink/plugin/protocol";
import { LinkCredentialStore, mintLinkNonce, type LinkCredential } from "./link-credential.js";
import { PairingAttempts, normalizePairingCode } from "./link-pairing.js";
import type { RelayConnection } from "./relay-connection.js";
import { refuseProtocolSkew } from "./version.js";

export type LinkSetupRequest = Extract<
  ServerRequest,
  { type: (typeof LINK_SETUP_REQUEST_TYPES)[number] }
>;

/** What an offer to pair put in front of the human: the codes the panels now show. */
export type PairingOffer =
  | { kind: "offered"; attempts: { code: string; expiresAt: number }[] }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "none" };

export type PairingConfirmation =
  | { kind: "paired"; link: RelayConnection }
  | { kind: "unknown-code" }
  | { kind: "failed"; reason: string };

// Links that haven't authenticated, at once. A real one is a plugin instance per open file, so this
// is generous. Past it, a newcomer evicts the oldest one showing no pairing code: a flood of mute
// sockets can't lock out a plugin that redials, and authenticated links never count or go.
const MAX_UNAUTHENTICATED_LINKS = 8;

/**
 * How long a link may sit without authenticating, unless a pairing attempt on it runs longer. The
 * plugin redials at once when closed, so this only recycles links, never strands a real plugin.
 */
export const UNAUTHENTICATED_LINK_MS = 10 * 60 * 1000;

// An offer never names a code with less life than this left: a code about to lapse is replaced, so
// the person (or the agent relaying it) has time to compare and confirm what they're shown.
const MIN_OFFERED_CODE_LIFE_MS = 2 * 60 * 1000;

export interface LinkSetupOptions {
  credentials: LinkCredentialStore;
  unauthenticatedLinkMs: number;
  /** Every link the bridge holds, in accept order. */
  links: () => Iterable<RelayConnection>;
  /** Send a setup frame on the link and await its reply. */
  send: <T extends LinkSetupRequest>(
    link: RelayConnection,
    payload: T,
  ) => Promise<ReplyFor<T["type"]>>;
  onAuthenticated: (link: RelayConnection) => void;
}

/** Sets up every link the bridge accepts, and runs the pairing attempts on those that can't prove themselves. */
export class LinkSetup {
  private readonly attempts = new PairingAttempts<RelayConnection>();
  private readonly deadlines = new Map<RelayConnection, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: LinkSetupOptions) {}

  /** Start setting up a just-accepted link. It settles on its own; nothing here rejects. */
  admit(link: RelayConnection): void {
    this.armDeadline(link, this.options.unauthenticatedLinkMs);
    void this.setUp(link);
  }

  /** Whether a newcomer may join, evicting the oldest silent unauthenticated link if needed. */
  makeRoomForNewcomer(): boolean {
    const waiting = [...this.options.links()].filter(
      (link) => link.isOpen && !link.isAuthenticated,
    );
    if (waiting.length < MAX_UNAUTHENTICATED_LINKS) return true;
    // Oldest first: the set iterates in insertion order.
    const evictable = waiting.find((link) => !this.attempts.of(link));
    if (!evictable) return false;
    Logger.log("Too many plugin links waiting to authenticate — closing the oldest");
    evictable.socket.terminate();
    return true;
  }

  /**
   * Challenge again every link a credential failed: one another server or plugin instance
   * provisioned since may pass now, and a credential file the person fixed is read afresh.
   */
  rechallenge(): void {
    for (const link of this.options.links())
      if (
        link.isOpen &&
        (link.stage.kind === "unpaired" || link.stage.kind === "credential-unusable")
      )
        void this.authenticate(link);
  }

  /** The link is gone: nothing about it stays armed or confirmable. */
  forget(link: RelayConnection): void {
    clearTimeout(this.deadlines.get(link));
    this.deadlines.delete(link);
    this.attempts.end(link);
  }

  /** When the open attempt showing `code` expires, or null if none shows it on an open link. */
  pairingCodeExpiresAt(typedCode: string): number | null {
    const code = normalizePairingCode(typedCode);
    const attempt = code === null ? undefined : this.attempts.showing(code);
    return attempt?.link.isOpen ? attempt.expiresAt : null;
  }

  /**
   * Show a pairing code in every unpaired link's panel: the link's open attempt, or a fresh one.
   * Resolves once each panel acknowledged its code, so the human can see what the agent is told.
   */
  async offer(): Promise<PairingOffer> {
    const unpaired = [...this.options.links()].filter(
      (link) => link.isOpen && link.stage.kind === "unpaired",
    );
    if (!unpaired.length) return { kind: "none" };
    const offered = await Promise.all(unpaired.map((link) => this.offerOn(link)));
    const attempts = offered.filter((attempt) => attempt !== null);
    if (attempts.length) return { kind: "offered", attempts };
    const retryAfterMs = this.attempts.retryAfterMs();
    return retryAfterMs > 0 ? { kind: "rate-limited", retryAfterMs } : { kind: "none" };
  }

  /**
   * The human confirmed that a panel shows `typedCode`: provision the installation credential to the
   * one link showing it, and authenticate that link. Never pairs a link showing any other code.
   */
  async confirm(typedCode: string): Promise<PairingConfirmation> {
    const code = normalizePairingCode(typedCode);
    const attempt = code === null ? undefined : this.attempts.showing(code);
    if (!attempt || !attempt.link.isOpen) return { kind: "unknown-code" };
    const { link } = attempt;
    // One confirmation per code: it is spent here, whatever happens next.
    this.attempts.end(link);
    let credential: LinkCredential;
    try {
      credential = this.options.credentials.readOrCreate();
    } catch (error) {
      return { kind: "failed", reason: (error as Error).message };
    }
    try {
      await this.options.send(link, {
        type: "PAIR_CONFIRMED",
        code: attempt.code,
        credentialId: credential.id,
        secret: credential.secret,
      });
    } catch (error) {
      return { kind: "failed", reason: (error as Error).message };
    }
    await this.authenticate(link);
    // A challenge already in flight (a concurrent call re-challenging) read the plugin's storage
    // before the credential landed, so its LINK_UNPAIRED is stale: ask once more.
    if (link.isOpen && link.stage.kind === "unpaired") await this.authenticate(link);
    if (!link.isAuthenticated)
      return {
        kind: "failed",
        reason: "The plugin stored the pairing but didn't prove it on the next challenge.",
      };
    // Other instances of the same installation share its storage, so they pass now too.
    this.rechallenge();
    return { kind: "paired", link };
  }

  /** The human said a panel doesn't show `typedCode`: that attempt ends, and its panel stops showing it. */
  decline(typedCode: string): void {
    const code = normalizePairingCode(typedCode);
    const attempt = code === null ? undefined : this.attempts.showing(code);
    if (!attempt) return;
    this.attempts.end(attempt.link);
    this.options.send(attempt.link, { type: "PAIRING_CLOSED", code: attempt.code }).catch(() => {});
  }

  private async offerOn(
    link: RelayConnection,
  ): Promise<{ code: string; expiresAt: number } | null> {
    const open = this.attempts.of(link);
    if (open && open.expiresAt - Date.now() >= MIN_OFFERED_CODE_LIFE_MS)
      return { code: open.code, expiresAt: open.expiresAt };
    const attempt = this.attempts.start(link);
    // Rate-limited: a code about to lapse still beats none.
    if (!attempt) return open ? { code: open.code, expiresAt: open.expiresAt } : null;
    const expiresInMs = attempt.expiresAt - Date.now();
    // The link lives at least as long as the code it shows.
    this.armDeadline(link, expiresInMs);
    try {
      await this.options.send(link, { type: "PAIRING_OFFER", code: attempt.code, expiresInMs });
    } catch {
      this.attempts.end(link);
      return null;
    }
    return { code: attempt.code, expiresAt: attempt.expiresAt };
  }

  /**
   * HELLO, then AUTHENTICATE. A plugin predating HELLO answers with an envelope ERROR, a silent one
   * times out, and a malformed answer is refused at parse — each reads as the protocol floor and is
   * refused, so every link settles. A mismatched build was told by HELLO itself to re-import (the
   * plugin words that toast) and is sent nothing more.
   */
  private async setUp(link: RelayConnection): Promise<void> {
    const hello = await this.options
      .send(link, { type: "HELLO", serverProtocol: PROTOCOL_VERSION })
      .catch(() => null);
    if (!link.isOpen) return;
    const refusal = refuseProtocolSkew(hello);
    if (refusal) {
      Logger.log(
        `⚠️ Version skew — plugin reported ${JSON.stringify(hello)}; it will not be driven`,
      );
      link.advance({ kind: "incompatible", refusal });
      return;
    }
    await this.authenticate(link);
  }

  /**
   * Challenge a link for the installation credential, read fresh so a credential another process
   * created is the one checked. A wrong proof or a silent link is closed: neither is a plugin that
   * merely hasn't paired, which answers LINK_UNPAIRED. A credential file this server can't read or
   * create leaves the link `credential-unusable`, so the call waiting on it can say why.
   */
  private async authenticate(link: RelayConnection): Promise<void> {
    if (link.stage.kind === "authenticating") return link.stageChanged;
    link.advance({ kind: "authenticating" });
    const { credentials } = this.options;
    let credential: LinkCredential;
    try {
      credential = credentials.readOrCreate();
    } catch (error) {
      return this.credentialUnusable(link, error);
    }
    const nonce = mintLinkNonce();
    const reply = await this.options
      .send(link, { type: "AUTHENTICATE", credentialId: credential.id, nonce })
      .catch(() => null);
    if (!link.isOpen) return;
    if (reply?.type === "LINK_UNPAIRED") {
      link.advance({ kind: "unpaired" });
      return;
    }
    if (reply?.type !== "LINK_PROOF") return closeUnproven(link);
    let proven: boolean;
    try {
      proven = credentials.verify(credential.id, nonce, reply.proof);
    } catch (error) {
      return this.credentialUnusable(link, error);
    }
    if (!proven) return closeUnproven(link);
    this.forget(link);
    link.advance({ kind: "authenticated", owner: reply.owner });
    Logger.log(
      `Plugin link authenticated (${reply.owner ? reply.owner.name || "a Figma user" : "no Figma user"})`,
    );
    this.options.onAuthenticated(link);
  }

  private credentialUnusable(link: RelayConnection, error: unknown): void {
    const problem = (error as Error).message;
    Logger.log(`The plugin link credential can't be used: ${problem}`);
    link.advance({ kind: "credential-unusable", problem });
  }

  /** Close a link that hasn't authenticated by `ms` from now, unless its pairing attempt runs longer. */
  private armDeadline(link: RelayConnection, ms: number): void {
    clearTimeout(this.deadlines.get(link));
    const timer = setTimeout(() => {
      this.deadlines.delete(link);
      if (link.isAuthenticated || !link.isOpen) return;
      const attempt = this.attempts.of(link);
      if (attempt) return this.armDeadline(link, attempt.expiresAt - Date.now());
      Logger.log("A plugin link didn't authenticate in time — closing it");
      link.socket.terminate();
    }, ms);
    timer.unref();
    this.deadlines.set(link, timer);
  }
}

function closeUnproven(link: RelayConnection): void {
  Logger.log("A plugin link failed its authentication challenge — closing it");
  link.socket.terminate();
}
