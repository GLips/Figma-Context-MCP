/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { Interface } from "node:readline/promises";
import type { PairingCodeAsker } from "~/commercial/plugin-bridge/plugin-call-link.js";

/**
 * Ask at a terminal whether the panel shows each code. Only `y`/`yes` is a Yes; EOF, the code's
 * expiry and anything else are a No. The person is right there, so nothing is left unanswered.
 */
export function terminalPairingCodeAsker(lines: Interface): PairingCodeAsker {
  return async (code, expiresInMs, signal) => {
    const expired = AbortSignal.timeout(Math.max(0, expiresInMs));
    const closed = new Promise<string>((resolve) => lines.once("close", () => resolve("")));
    const answer = await Promise.race([
      lines.question(
        `Does the Framelink plugin panel in Figma show the pairing code ${code}? [y/N] `,
        { signal: AbortSignal.any([signal, expired]) },
      ),
      closed,
    ]).catch(() => {
      if (signal.aborted) throw signal.reason;
      return "";
    });
    return /^\s*y(es)?\s*$/i.test(answer) ? "shown" : "not-shown";
  };
}
