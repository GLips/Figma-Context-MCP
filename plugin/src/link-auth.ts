/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's half of link authentication and pairing. A server challenges every new socket to
// prove this installation holds its credential; the plugin answers with an HMAC, never the secret.
// Until one is stored, the socket is unpaired, and the panel shows the code of any pairing attempt
// the server opened so the human can compare it with what their agent shows.
//
// Credentials live in clientStorage under one key per credential id, never one shared record: each
// state dir pairs separately, and two plugin instances storing at once must not overwrite each other.
import { hmacSha256Hex } from "./hmac-sha256.js";
import { reply, type ReplyTo } from "./outbound.js";
import type { ConnKey, PanelPairing } from "./panel.js";
import { linkProofMessage, type PluginOwner } from "./protocol.js";

const LINK_CREDENTIAL_STORAGE_PREFIX = "code-mode:link-credential:";

/** The Figma user signed in to this plugin: the owner every write through its links is charged to. */
export function currentPluginOwner(): PluginOwner | null {
  const user = figma.currentUser;
  return user?.id ? { figmaUserId: user.id, name: user.name } : null;
}

interface PairingOffer {
  code: string;
  expiry: ReturnType<typeof setTimeout>;
}

export function createLinkAuth({ show }: { show: (expandTo?: boolean) => void }) {
  // Sockets this plugin told it holds no credential for. A socket that proved itself leaves the set.
  const unpaired = new Set<ConnKey>();
  // The credential each socket last proved: grants are scoped to it, so each state dir has its own.
  const proved = new Map<ConnKey, string>();
  const offers = new Map<ConnKey, PairingOffer>();

  function dropOffer(key: ConnKey): void {
    const offer = offers.get(key);
    if (!offer) return;
    clearTimeout(offer.expiry);
    offers.delete(key);
  }

  return {
    /**
     * Answer a challenge. Read from storage every time, never cached: another instance of this
     * plugin (another file) may have just been paired with the credential this server names.
     */
    async authenticate(to: ReplyTo, credentialId: string, nonce: string): Promise<void> {
      const secret: unknown = await figma.clientStorage.getAsync(LINK_CREDENTIAL_STORAGE_PREFIX + credentialId);
      if (typeof secret !== "string") {
        unpaired.add(to.connKey);
        proved.delete(to.connKey);
        reply(to, { type: "LINK_UNPAIRED" });
      } else {
        unpaired.delete(to.connKey);
        proved.set(to.connKey, credentialId);
        dropOffer(to.connKey);
        reply(to, {
          type: "LINK_PROOF",
          proof: hmacSha256Hex(secret, linkProofMessage(credentialId, nonce)),
          owner: currentPluginOwner(),
        });
      }
      show();
    },

    /** Show an attempt's code until it closes, expires, or its socket goes. */
    offer(to: ReplyTo, code: string, expiresInMs: number): void {
      dropOffer(to.connKey);
      offers.set(to.connKey, {
        code,
        expiry: setTimeout(() => {
          if (offers.get(to.connKey)?.code !== code) return;
          offers.delete(to.connKey);
          show();
        }, expiresInMs),
      });
      reply(to, { type: "PAIRING_OFFER_ACK" });
      show(true);
    },

    closeOffer(to: ReplyTo, code: string): void {
      if (offers.get(to.connKey)?.code === code) dropOffer(to.connKey);
      reply(to, { type: "PAIRING_CLOSED_ACK" });
      show();
    },

    /**
     * Store the credential a confirmed attempt hands over — only on the socket showing that code, so
     * a confirmation can never land on a socket the human wasn't shown.
     */
    async storeCredential(to: ReplyTo, code: string, credentialId: string, secret: string): Promise<void> {
      if (offers.get(to.connKey)?.code !== code) {
        reply(to, { type: "ERROR", error: `This plugin isn't showing pairing code ${code}, so it stored nothing.` });
        return;
      }
      dropOffer(to.connKey);
      try {
        await figma.clientStorage.setAsync(LINK_CREDENTIAL_STORAGE_PREFIX + credentialId, secret);
        reply(to, { type: "CREDENTIAL_STORED" });
      } catch (error) {
        reply(to, { type: "ERROR", error: `The plugin could not store its pairing: ${String(error)}` });
      }
      show();
    },

    closed(key: ConnKey): void {
      unpaired.delete(key);
      proved.delete(key);
      dropOffer(key);
    },

    /** The credential this socket proved, or null while it hasn't. */
    credentialOf(key: ConnKey): string | null {
      return proved.get(key) ?? null;
    },

    /** Every socket that proved a credential. */
    authenticatedConnections(): ConnKey[] {
      return [...proved.keys()];
    },

    /** One row per unpaired socket, with the code it is showing, if any. */
    pairingRows(): PanelPairing[] {
      return [...unpaired].map((key) => ({ key, code: offers.get(key)?.code ?? null }));
    },
  };
}
