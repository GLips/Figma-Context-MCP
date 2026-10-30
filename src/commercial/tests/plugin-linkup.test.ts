/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// An unnamed call against the files open on this machine, linked or still linking: it never waits to
// learn how many there are, and waits for a plugin to link only in the file it runs in.
import { afterEach, expect, it } from "vitest";
import type { DocumentReport } from "@framelink/plugin/protocol";
import { callTargetGuidance } from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import { connectFakePlugin, openInstanceOf } from "./fixtures/fake-plugin-socket.js";
import { TEST_DOCUMENT, TEST_INTENT } from "./fixtures/write-access.js";

const bridges: PluginBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
});

const SETTINGS_REPORT = {
  kind: "identified",
  documentId: "s3tt1ngsd0c00002",
  fileName: "Settings",
} as const satisfies DocumentReport;
const SETTINGS_INSTANCE = "s3tt1ngsxnst0003";

/** A plugin whose project is granted, and whose panel picks it when asked to choose a copy. */
function granted(bridge: PluginBridge, options: Parameters<typeof connectFakePlugin>[1]) {
  return connectFakePlugin(bridge, {
    ...options,
    grantState: (prompt) => (prompt === "pick" ? "picked" : "granted"),
  });
}

function unnamedCall(bridge: PluginBridge) {
  return bridge.targetCall(
    {
      executionId: mintExecutionId(),
      intent: TEST_INTENT,
      session: null,
      document: null,
      fileKey: null,
    },
    { signal: new AbortController().signal, waitMs: 5_000 },
  );
}

function newBridge(): PluginBridge {
  const bridge = new PluginBridge();
  bridges.push(bridge);
  return bridge;
}

it("two open files refuse an unnamed call at once, listing both, without waiting for the unlinked one", async () => {
  const bridge = newBridge();
  await granted(bridge, {
    otherInstances: [
      openInstanceOf(SETTINGS_REPORT, SETTINGS_INSTANCE, {
        active: true,
        currentPage: "Billing",
        pageCount: 140,
        selection: { count: 2, names: ["Card", "Header"] },
      }),
    ],
  });

  const started = Date.now();
  const target = await unnamedCall(bridge);
  expect(Date.now() - started).toBeLessThan(500);
  if (target.kind !== "blocked") throw new Error("expected a refusal");
  if (target.block.kind !== "document-unchosen") throw new Error("expected the open-files refusal");
  const text = callTargetGuidance(target.block, "mcp");
  expect(text).toContain("2 Figma files have the Framelink plugin open");
  expect(text).toContain(
    `- "${TEST_DOCUMENT.fileName}": document ${TEST_DOCUMENT.documentId}; fileKey TESTfile1; allowed for this project; background`,
  );
  expect(text).toContain(
    `- "Settings": document ${SETTINGS_REPORT.documentId}; not allowed for this project yet ` +
      `(choosing it asks the user to Allow); active tab; page "Billing" of 140; selection 2 nodes ("Card", "Header")`,
  );
  expect(text).toContain("The session you get back keeps that file");
});

it("the one open file runs an unnamed call once its slow plugin links", async () => {
  const bridge = newBridge();
  // A viewer's plugin can't stamp its file, so the only usable file is the one still linking.
  await connectFakePlugin(bridge, {
    document: { kind: "unidentified", problem: "view only" },
    otherInstances: [openInstanceOf(SETTINGS_REPORT, SETTINGS_INSTANCE)],
  });
  const call = unnamedCall(bridge);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const late = await granted(bridge, { document: SETTINGS_REPORT, instance: SETTINGS_INSTANCE });

  expect(await call).toMatchObject({
    kind: "targeted",
    link: late.link,
    document: { documentId: SETTINGS_REPORT.documentId },
  });
});

it("duplicates of one document are one file, and the human picks the copy", async () => {
  const bridge = newBridge();
  const copyInstance = "c0pyxnstanc00004";
  // Neither reports a file key, so nothing tells the original from its duplicate.
  const unkeyed: DocumentReport = {
    kind: "identified",
    documentId: TEST_DOCUMENT.documentId,
    fileName: TEST_DOCUMENT.fileName,
  };
  await connectFakePlugin(bridge, {
    document: unkeyed,
    otherInstances: [openInstanceOf(unkeyed, copyInstance)],
    grantState: () => "pending",
  });
  const call = unnamedCall(bridge);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const copy = await granted(bridge, { document: unkeyed, instance: copyInstance });

  expect(await call).toMatchObject({ kind: "targeted", link: copy.link });
});
