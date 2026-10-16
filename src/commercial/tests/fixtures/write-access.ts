/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteAccess } from "~/commercial/entitlement/write-access.js";
import { WriteMeter } from "~/commercial/entitlement/write-meter.js";
import { DeviceSignIn } from "~/commercial/entitlement/device-sign-in.js";
import { FramelinkApiClient } from "~/commercial/entitlement/framelink-api.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import { figmaFileKey } from "~/utils/figma-url.js";
import type {
  CallDocument,
  CallTarget,
  LinkResolution,
  PluginLink,
} from "~/commercial/plugin-bridge/bridge.js";
import type { PluginOwner, WriteAccessNotice } from "@framelink/plugin/protocol";

export const TEST_PLUGIN_OWNER: PluginOwner = {
  figmaUserId: "figma-user-1",
  name: "Test Plugin Owner",
};

/** The document fake bridges bind every call to. */
export const TEST_DOCUMENT: CallDocument = {
  fileKey: figmaFileKey("TESTfile1"),
  fileName: "Test file",
};

/** A stand-in authenticated link, for fake bridges that never touch a socket. */
export const TEST_PLUGIN_LINK = { owner: TEST_PLUGIN_OWNER } as unknown as PluginLink;

/** A fake bridge's `resolveLink`: always the one authenticated TEST_PLUGIN_LINK. */
export async function linkedTestResolution(): Promise<LinkResolution> {
  return { kind: "linked", links: [TEST_PLUGIN_LINK] };
}

/** A fake bridge's `targetCall`: every call bound to TEST_DOCUMENT on TEST_PLUGIN_LINK, granted. */
export async function targetedTestCall(): Promise<CallTarget> {
  return { kind: "targeted", link: TEST_PLUGIN_LINK, document: TEST_DOCUMENT };
}

/**
 * Write access over an isolated temp state dir, wired the way the runtime wires it. With no `apiUrl`
 * it points at a closed port, so any request is an outage — tools not about write access still
 * authorize from a fresh allowance.
 */
export function createTestWriteAccess({
  apiUrl = "http://127.0.0.1:9",
  notifyPanel = () => {},
}: { apiUrl?: string; notifyPanel?: (notice: WriteAccessNotice) => void } = {}): {
  writeAccess: WriteAccess;
  writeMeter: WriteMeter;
  signIn: DeviceSignIn;
  store: WriteAccessStore;
} {
  const store = new WriteAccessStore(mkdtempSync(join(tmpdir(), "flcm-write-access-")));
  const api = new FramelinkApiClient(apiUrl);
  const writeAccess = new WriteAccess(api, store);
  return {
    writeAccess,
    writeMeter: new WriteMeter(writeAccess, { notifyPanel }),
    signIn: new DeviceSignIn(api, writeAccess, notifyPanel),
    store,
  };
}
