/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Pairing attempts: compare-and-confirm, one per unpaired plugin link. The server mints a code, the
// plugin panel shows it, and the human confirms with their agent that the panel shows that same
// code. A confirmation names its code and pairs only the link showing it, never "whatever is
// pending", so a page posing as the plugin beside the real one stays unconfirmed.
import { randomInt } from "node:crypto";
import { PAIRING_CODE_PATTERN } from "@framelink/plugin/protocol";

/** How long a code stays confirmable. Long enough to read it off the panel and answer; no longer. */
export const PAIRING_ATTEMPT_MS = 5 * 60 * 1000;

// Attempts opened per process in a sliding window. An agent that keeps calling reuses the open
// attempt, so only an attempt that expired, was declined or lost its socket spends one.
const PAIRING_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 10;

// Crockford base32: no I, L, O or U, so a code survives being read aloud or retyped.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A fresh `7QKM-X2D9`-shaped code: 40 random bits. */
export function mintPairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A code as a person or agent typed it, in canonical form, or null when it can't be one. Case,
 * spacing and the dash are forgiven, and so are the letters Crockford reads as digits (O→0, I/L→1).
 */
export function normalizePairingCode(typed: string): string | null {
  const compact = typed
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return compact.length === 8 && PAIRING_CODE_PATTERN.test(code) ? code : null;
}

export interface PairingAttempt<Link> {
  readonly code: string;
  readonly link: Link;
  readonly expiresAt: number;
}

/** The open attempts, at most one per link, and the rate limit on opening more. */
export class PairingAttempts<Link> {
  private readonly open = new Map<Link, PairingAttempt<Link>>();
  private readonly openedAt: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** The link's live attempt, if it has one. */
  of(link: Link): PairingAttempt<Link> | undefined {
    const attempt = this.open.get(link);
    if (attempt && attempt.expiresAt <= this.now()) this.open.delete(link);
    return this.open.get(link);
  }

  /** The live attempt showing `code`, matched exactly: it is the confirmation's whole meaning. */
  showing(code: string): PairingAttempt<Link> | undefined {
    for (const link of [...this.open.keys()]) {
      const attempt = this.of(link);
      if (attempt?.code === code) return attempt;
    }
    return undefined;
  }

  /** Open an attempt for `link`, or null when the rate limit is spent. */
  start(link: Link): PairingAttempt<Link> | null {
    const now = this.now();
    while (this.openedAt.length && this.openedAt[0] <= now - PAIRING_ATTEMPT_WINDOW_MS)
      this.openedAt.shift();
    if (this.openedAt.length >= MAX_PAIRING_ATTEMPTS_PER_WINDOW) return null;
    this.openedAt.push(now);
    const attempt = { code: mintPairingCode(), link, expiresAt: now + PAIRING_ATTEMPT_MS };
    this.open.set(link, attempt);
    return attempt;
  }

  /** How long until the rate limit admits another attempt. */
  retryAfterMs(): number {
    const oldest = this.openedAt[0];
    return oldest === undefined ? 0 : Math.max(0, oldest + PAIRING_ATTEMPT_WINDOW_MS - this.now());
  }

  /** End the link's attempt: confirmed, declined, or its socket gone. Each code covers one attempt. */
  end(link: Link): void {
    this.open.delete(link);
  }
}
