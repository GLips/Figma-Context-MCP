import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalStore,
  TTL_MS,
  isExpired,
  keyForCwd,
} from "~/services/plugin-bridge/approval-store.js";

// The durable-approval store is the imperative shell for a security-adjacent bit of state, so its
// contract earns tests: the token survives (that's the whole feature), is isolated per (cwd, port) so
// concurrent same-cwd servers can't inherit each other's approval, expires on schedule, holds 0600 even
// over a pre-existing file, and degrades to "no approval" (never throws) when the disk misbehaves.

const PORT = 9876;

describe("keyForCwd", () => {
  it("is stable and path-distinct", () => {
    expect(keyForCwd("/a/b")).toBe(keyForCwd("/a/b"));
    expect(keyForCwd("/a/b")).not.toBe(keyForCwd("/a/c"));
    expect(keyForCwd("/a/b")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isExpired", () => {
  const record = { token: "t", identity: "id", createdAt: 0, lastUsedAt: 1000 };
  it("is false within the TTL and true past it", () => {
    expect(isExpired(record, 1000 + TTL_MS)).toBe(false);
    expect(isExpired(record, 1000 + TTL_MS + 1)).toBe(true);
  });
});

describe("ApprovalStore", () => {
  let dir: string;
  const cwd = "/project/root";
  const store = () => new ApprovalStore(cwd, dir);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flcm-approval-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a saved token", () => {
    store().save(PORT, "tok-abc", "id", 1000);
    expect(store().loadRecord(PORT, 2000)?.token).toBe("tok-abc");
  });

  it("isolates by port — a different port on the same cwd reloads nothing", () => {
    store().save(PORT, "tok-abc", "id", 1000);
    // The F1 fix: a concurrent same-cwd server on another port must NOT inherit this token.
    expect(store().loadRecord(PORT + 1, 2000)?.token ?? null).toBeNull();
  });

  it("returns null when nothing is persisted", () => {
    expect(store().loadRecord(PORT, 1000)?.token ?? null).toBeNull();
  });

  it("prunes and returns null once the TTL lapses", () => {
    store().save(PORT, "tok-abc", "id", 1000);
    expect(store().loadRecord(PORT, 1000 + TTL_MS + 1)?.token ?? null).toBeNull();
    // The file is gone, not merely ignored — a later load with a valid clock still finds nothing.
    expect(readdirSync(join(dir, "approvals"))).toHaveLength(0);
  });

  it("hasUnexpiredApproval reports without pruning — a probe must not delete a live peer's file", () => {
    store().save(PORT, "tok-abc", "id", 1000);
    expect(store().hasUnexpiredApproval(PORT, 1000 + TTL_MS + 1)).toBe(false);
    // `load` deletes the file at this point; this must not. The bridge's reclaim probe asks about a
    // port ANOTHER live server may hold, and that peer's `touch` is a compare-and-set that can't
    // rewrite a file which is gone — so pruning from a probe silently costs the peer its durable
    // approval, and it re-prompts its human on the next restart.
    expect(readdirSync(join(dir, "approvals"))).toHaveLength(1);
    expect(store().loadRecord(PORT, 2000)?.token).toBe("tok-abc");
  });

  it("touch slides the TTL forward for the matching token", () => {
    store().save(PORT, "tok-abc", "id", 1000);
    // A use just before expiry pushes lastUsedAt forward; the original deadline no longer applies.
    store().touch(PORT, "tok-abc", 1000 + TTL_MS - 1);
    expect(store().loadRecord(PORT, 1000 + TTL_MS + 1)?.token).toBe("tok-abc");
  });

  it("touch is a no-op when the file holds a different token (no rollback of a peer's write)", () => {
    store().save(PORT, "tok-new", "id", 5000);
    // A slow peer still holding the old token must not roll the file back or resurrect it.
    store().touch(PORT, "tok-old", 6000);
    expect(store().loadRecord(PORT, 6000)?.token).toBe("tok-new");
  });

  it("clear forgets the token (revoke)", () => {
    store().save(PORT, "tok-abc", "id", 1000);
    store().clear(PORT);
    expect(store().loadRecord(PORT, 2000)?.token ?? null).toBeNull();
  });

  it("degrades to null on a corrupt file rather than throwing", () => {
    store().save(PORT, "tok-abc", "id", 1000);
    const file = join(dir, "approvals", `${keyForCwd(cwd)}-${PORT}.json`);
    writeFileSync(file, "{ not json");
    expect(() => store().loadRecord(PORT, 2000)).not.toThrow();
    expect(store().loadRecord(PORT, 2000)?.token ?? null).toBeNull();
  });

  it("enforces 0600 even over a pre-existing looser-mode file", () => {
    const file = join(dir, "approvals", `${keyForCwd(cwd)}-${PORT}.json`);
    mkdirSync(join(dir, "approvals"), { recursive: true });
    writeFileSync(file, "{}", { mode: 0o644 });
    store().save(PORT, "tok-abc", "id", 1000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never throws when the state dir is unwritable — durability is best-effort", () => {
    // Point the base at a path under a regular file: mkdir/write there fails, and save must swallow it.
    const wall = join(dir, "not-a-dir");
    writeFileSync(wall, "x");
    const store = new ApprovalStore(cwd, join(wall, "state"));
    expect(() => store.save(PORT, "tok-abc", "id", 1000)).not.toThrow();
    expect(store.loadRecord(PORT, 2000)?.token ?? null).toBeNull();
  });
});
