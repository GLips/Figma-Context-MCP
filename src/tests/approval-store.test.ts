import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalStore,
  TTL_MS,
  isExpired,
  keyForCwd,
} from "~/services/plugin-bridge/approval-store.js";

// The durable-approval store is the imperative shell for a security-adjacent bit of state, so its
// contract earns tests: the token survives (that's the whole feature), expires on schedule (a bounded
// credential), and a corrupt/missing file degrades to "no approval" rather than crashing the server.

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
    store().save("tok-abc", "id", 1000);
    expect(store().load(2000)).toBe("tok-abc");
  });

  it("returns null when nothing is persisted", () => {
    expect(store().load(1000)).toBeNull();
  });

  it("prunes and returns null once the TTL lapses", () => {
    store().save("tok-abc", "id", 1000);
    expect(store().load(1000 + TTL_MS + 1)).toBeNull();
    // The file is gone, not merely ignored — a later load with a valid clock still finds nothing.
    expect(readdirSync(join(dir, "approvals"))).toHaveLength(0);
  });

  it("touch slides the TTL forward so an active session doesn't lapse", () => {
    store().save("tok-abc", "id", 1000);
    // A use just before expiry pushes lastUsedAt forward; the original deadline no longer applies.
    store().touch(1000 + TTL_MS - 1);
    expect(store().load(1000 + TTL_MS + 1)).toBe("tok-abc");
  });

  it("clear forgets the token (revoke)", () => {
    store().save("tok-abc", "id", 1000);
    store().clear();
    expect(store().load(2000)).toBeNull();
  });

  it("degrades to null on a corrupt file rather than throwing", () => {
    store().save("tok-abc", "id", 1000);
    const file = join(dir, "approvals", `${keyForCwd(cwd)}.json`);
    writeFileSync(file, "{ not json");
    expect(() => store().load(2000)).not.toThrow();
    expect(store().load(2000)).toBeNull();
  });
});
