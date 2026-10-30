/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// How long a call waits for plugins to link: only for the instances an introduction names open, and
// only as long as the grace for one that never comes.
import { afterEach, expect, it } from "vitest";
import type { DocumentReport } from "@framelink/plugin/protocol";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { parseDocumentId } from "~/commercial/plugin-bridge/document-id.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import { connectFakePlugin } from "./fixtures/fake-plugin-socket.js";
import { TEST_DOCUMENT, TEST_DOCUMENT_REPORT, TEST_INTENT } from "./fixtures/write-access.js";

const bridges: PluginBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
});

const SETTINGS_REPORT: DocumentReport = {
  kind: "identified",
  documentId: "s3tt1ngsd0c00002",
  fileName: "Settings",
  pageNames: ["Account"],
};
// A tab closed outright: its storage entry still looks fresh, but it will never link.
const CLOSED_TAB = { instance: "c10s3dtab0000003", documentId: "s3tt1ngsd0c00002" };

async function granted(bridge: PluginBridge, options: Parameters<typeof connectFakePlugin>[1]) {
  const socket = await connectFakePlugin(bridge, options);
  socket.onFrame = (frame) => {
    if (frame.type === "GRANT_STATUS")
      socket.receive({ type: "GRANT", id: frame.id, state: "granted" });
  };
  return socket;
}

function target(bridge: PluginBridge, document: string | null) {
  return bridge.targetCall(
    {
      executionId: mintExecutionId(),
      intent: TEST_INTENT,
      session: null,
      document: document === null ? null : parseDocumentId(document)!,
      fileKey: null,
    },
    { signal: new AbortController().signal, waitMs: 5_000 },
  );
}

it("an unnamed call runs as soon as every plugin named open has linked", async () => {
  // A grace no call could sit out inside the test's timeout: nothing here may wait for it.
  const bridge = new PluginBridge({ linkupGraceMs: 60_000 });
  bridges.push(bridge);
  await granted(bridge, {});

  expect(await target(bridge, null)).toMatchObject({
    kind: "targeted",
    document: { documentId: TEST_DOCUMENT.documentId },
  });
});

it("a plugin named open that never links holds an unnamed call only for the grace", async () => {
  const bridge = new PluginBridge({ linkupGraceMs: 300 });
  bridges.push(bridge);
  await granted(bridge, { otherInstances: [CLOSED_TAB] });

  const started = Date.now();
  // Granted there too, had it linked: then the call would have been refused as ambiguous.
  expect(await target(bridge, null)).toMatchObject({
    kind: "targeted",
    document: { documentId: TEST_DOCUMENT.documentId },
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
});

it("a call naming its document never waits on another plugin, linking or frozen", async () => {
  const bridge = new PluginBridge({ linkupGraceMs: 60_000 });
  bridges.push(bridge);
  await granted(bridge, { document: TEST_DOCUMENT_REPORT, otherInstances: [CLOSED_TAB] });
  await connectFakePlugin(bridge, { document: SETTINGS_REPORT, answersIntroduce: false });

  expect(await target(bridge, TEST_DOCUMENT.documentId)).toMatchObject({
    kind: "targeted",
    document: { documentId: TEST_DOCUMENT.documentId },
  });
});
