/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The installation credential: the secret a state dir shares with every Figma plugin installation
// paired to it, so a plugin link can prove it is ours. One per state dir, so every server on that
// dir authenticates the same plugins and one confirmation pairs them all.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { linkProofMessage } from "@framelink/plugin/protocol";
import { createPrivateFileExclusive, resolveStateDir } from "~/commercial/state-dir.js";

export interface LinkCredential {
  /** Names the credential to the plugin, which stores each one under its own id. Not secret. */
  readonly id: string;
  readonly secret: string;
}

const CREDENTIAL_FILE = "plugin-link-credential.json";

/** The HMAC a plugin holding `credential` answers a challenge for `nonce` with. */
export function linkProof(credential: LinkCredential, nonce: string): string {
  return createHmac("sha256", credential.secret)
    .update(linkProofMessage(credential.id, nonce))
    .digest("hex");
}

/** A fresh challenge nonce. */
export function mintLinkNonce(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The state dir's credential file. Read on every use, never cached, so a credential another process
 * created is the one this process honors. Created only if absent, atomically, so servers starting
 * together on one dir converge on one credential; pairing hands the plugin that one and never mints.
 */
export class LinkCredentialStore {
  // Resolved per use, like the other stores: tests and the contract harness move the state root by env.
  constructor(private readonly stateDir?: string) {}

  private get file(): string {
    return join(this.stateDir ?? resolveStateDir(), CREDENTIAL_FILE);
  }

  /** The credential, created now if this state dir has none yet. */
  readOrCreate(): LinkCredential {
    const existing = this.read();
    if (existing) return existing;
    const minted: LinkCredential = {
      id: randomBytes(12).toString("base64url"),
      secret: randomBytes(32).toString("base64url"),
    };
    // Losing the race is fine: the winner's credential is the one to use.
    createPrivateFileExclusive(this.file, JSON.stringify(minted) + "\n");
    const settled = this.read();
    if (!settled)
      throw new Error(`The plugin link credential at ${this.file} vanished as it was created.`);
    return settled;
  }

  /** Whether `proof` answers `nonce` under the credential named `id`, as this state dir holds it now. */
  verify(id: string, nonce: string, proof: string): boolean {
    const credential = this.read();
    if (!credential || credential.id !== id) return false;
    const expected = Buffer.from(linkProof(credential, nonce), "hex");
    const given = Buffer.from(proof, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private read(): LinkCredential | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    // Never repaired in place: another process may be using it, and replacing it unpairs every
    // plugin. The person deletes it, and pairs again.
    const malformed = new Error(
      `The plugin link credential at ${this.file} is malformed. Delete it and pair the Framelink plugin again.`,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw malformed;
    }
    const { id, secret } = (parsed ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof secret !== "string" || !id || !secret) throw malformed;
    return { id, secret };
  }
}
