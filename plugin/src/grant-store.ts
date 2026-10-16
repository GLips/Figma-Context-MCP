/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's grants: "project P may edit document D", for one installation credential and one
// Figma user. The plugin is their only store; a server asks, never keeps a copy.
//
// One clientStorage record per grant, never a shared snapshot: several instances of this plugin (one
// per open file) write at once, and clientStorage has no transactions, so a read-modify-write of one
// list would drop another instance's change. Every operation runs in one ordered chain, and a key
// with an operation in flight answers "unknown": the gate stays shut until it settles.
import { hmacSha256Hex } from "./hmac-sha256.js";

/** Whose grant: the installation credential, the plugin's owner, the server's project, the document. */
export interface GrantScope {
  credentialId: string;
  ownerId: string;
  project: string;
  fileKey: string;
}

export type GrantAnswer = "granted" | "absent" | "unknown";

/** A grant this plugin holds on one document, as the panel lists it. */
export interface DocumentGrant {
  credentialId: string;
  project: string;
}

export interface GrantStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const GRANT_KEY_PREFIX = "code-mode:grant:";

interface GrantRecord {
  project: string;
  grantedAt: number;
}

function isGrantRecord(value: unknown): value is GrantRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GrantRecord).project === "string" &&
    typeof (value as GrantRecord).grantedAt === "number"
  );
}

// A digest, not the path: keys stay short whatever the path, and the record carries the path itself.
function projectDigest(project: string): string {
  return hmacSha256Hex("framelink-grant-project", project).slice(0, 32);
}

function documentPrefix(ownerId: string, fileKey: string): string {
  return `:${ownerId}:${fileKey}:`;
}

export function grantKey({ credentialId, ownerId, project, fileKey }: GrantScope): string {
  return `${GRANT_KEY_PREFIX}${credentialId}${documentPrefix(ownerId, fileKey)}${projectDigest(project)}`;
}

export function createGrantStore(storage: GrantStorage, report: (error: unknown) => void) {
  // What each key read as when last loaded or written. Absent from the map: never loaded.
  const known = new Map<string, boolean>();
  const inFlight = new Map<string, number>();
  let tail: Promise<void> = Promise.resolve();

  function enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    const run = tail.then(operation).finally(() => {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left > 0) inFlight.set(key, left);
      else inFlight.delete(key);
    });
    tail = run.catch(() => {});
    return run;
  }

  function load(key: string): Promise<void> {
    return enqueue(key, async () => {
      try {
        known.set(key, isGrantRecord(await storage.get(key)));
      } catch (error) {
        // Fail closed: a grant that can't be read is no grant.
        known.set(key, false);
        report(error);
      }
    });
  }

  function answer(scope: GrantScope): GrantAnswer {
    const key = grantKey(scope);
    if (inFlight.has(key)) return "unknown";
    const granted = known.get(key);
    if (granted === undefined) {
      void load(key);
      return "unknown";
    }
    return granted ? "granted" : "absent";
  }

  return {
    answer,

    /** The answer once nothing for this grant is in flight. */
    async settledAnswer(scope: GrantScope): Promise<Exclude<GrantAnswer, "unknown">> {
      for (;;) {
        const now = answer(scope);
        if (now !== "unknown") return now;
        await tail;
      }
    },

    /** Record a grant. Rejects, leaving the grant absent, when storage refuses it. */
    grant(scope: GrantScope): Promise<void> {
      const key = grantKey(scope);
      return enqueue(key, async () => {
        const record: GrantRecord = { project: scope.project, grantedAt: Date.now() };
        try {
          await storage.set(key, record);
          known.set(key, true);
        } catch (error) {
          report(error);
          throw error;
        }
      });
    },

    /** Forget a grant. Closed in memory first, and stays closed even when storage fails. */
    revoke(scope: GrantScope): Promise<void> {
      const key = grantKey(scope);
      known.set(key, false);
      return enqueue(key, async () => {
        known.set(key, false);
        try {
          await storage.delete(key);
        } catch (error) {
          report(error);
        }
      });
    },

    /** Read a grant afresh: another instance of this plugin changed it. */
    refresh(scope: GrantScope): Promise<void> {
      return load(grantKey(scope));
    },

    /** Every grant this plugin's owner holds on `fileKey`, under any credential. */
    async grantsOnDocument(ownerId: string, fileKey: string): Promise<DocumentGrant[]> {
      const infix = documentPrefix(ownerId, fileKey);
      const grants: DocumentGrant[] = [];
      for (const key of await storage.keys()) {
        if (!key.startsWith(GRANT_KEY_PREFIX)) continue;
        const at = key.indexOf(infix, GRANT_KEY_PREFIX.length);
        if (at < 0) continue;
        const record = await storage.get(key);
        if (isGrantRecord(record))
          grants.push({ credentialId: key.slice(GRANT_KEY_PREFIX.length, at), project: record.project });
      }
      return grants;
    },
  };
}

export type GrantStore = ReturnType<typeof createGrantStore>;
