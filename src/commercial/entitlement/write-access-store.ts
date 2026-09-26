/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Write-access state on disk: this install's id, each signed-in Authorizing User's seat and bearer
// token, and the free-allowance ledger. One 0600 file in the same state dir as session approvals.
//
// The FILE is shared state, not any one process's: several servers (one per agent) share it, so every
// change is read → transform → atomic write with no await in between. That shrinks the lost-update
// window to one synchronous read/rename; it doesn't close it. What a lost update or a lost file
// costs, and what gets it back:
//   • Writes already reported: the server's count for the month comes back on the next
//     reconciliation (the effective count takes the server's number when higher).
//   • Writes not yet reported, and bearer tokens: gone. Nothing else holds them — the Writes go
//     uncounted and the Authorizing User signs in again.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Logger } from "~/utils/logger.js";
import {
  resolveStateDir,
  writePrivateFileAtomic,
} from "~/commercial/plugin-bridge/approval-store.js";
import type { CachedSeat } from "./write-authorization.js";
import type { WriteLedger } from "./write-ledger.js";

export interface WriteAccessState {
  installId: string;
  /** Keyed by figmaUserId. */
  seats: Record<string, CachedSeat>;
  ledger: WriteLedger;
}

const WriteAccessStateFile = z.object({
  installId: z.uuid(),
  seats: z.record(
    z.string(),
    z.object({
      token: z.string(),
      seat: z.boolean().nullable(),
      validatedAt: z.string().nullable(),
    }),
  ),
  ledger: z.record(
    z.string(),
    z.object({
      executions: z.array(
        z.object({ executionId: z.string(), at: z.string(), reported: z.boolean() }),
      ),
      serverReported: z
        .object({ month: z.string(), usedThisMonth: z.number(), reportedAt: z.string() })
        .nullable(),
    }),
  ),
});

export class WriteAccessStore {
  readonly file: string;

  constructor(baseDir: string = resolveStateDir()) {
    this.file = join(baseDir, "write-access.json");
  }

  /** The current state, minting and persisting an installId on first use. */
  read(): WriteAccessState {
    const state = this.load();
    if (state) return state;
    return this.persist({ installId: randomUUID(), seats: {}, ledger: {} });
  }

  update(transform: (state: WriteAccessState) => WriteAccessState): WriteAccessState {
    return this.persist(transform(this.read()));
  }

  private load(): WriteAccessState | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = WriteAccessStateFile.safeParse(json);
    if (parsed.success) return parsed.data;
    // Starting over is what a reinstall does: reported Writes come back with the server's count,
    // unreported ones and every bearer token are lost (see the header).
    Logger.log(`Write-access state at ${this.file} is unreadable — starting fresh`);
    return null;
  }

  // A failed write propagates: the caller decides what a lost save costs. WriteAccess keeps Writes
  // that couldn't be saved counted in memory and retries; a sign-in whose token can't be kept fails.
  private persist(state: WriteAccessState): WriteAccessState {
    writePrivateFileAtomic(this.file, JSON.stringify(state));
    return state;
  }
}
