/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Targeting against stand-in links, for orderings a real plugin can't be made to produce on cue.
import { expect, it } from "vitest";
import { targetPluginCall, type CallTargetDeps } from "~/commercial/plugin-bridge/call-target.js";
import type { CallIntent } from "~/commercial/plugin-bridge/call-intent.js";
import { parseDocumentId } from "~/commercial/plugin-bridge/document-id.js";
import type { LinkDocument } from "~/commercial/plugin-bridge/link-documents.js";
import type { RelayConnection } from "~/commercial/plugin-bridge/relay-connection.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import { figmaFileKey } from "~/utils/figma-url.js";

it("a call granted in a panel whose file is re-stamped mid-round stays bound to the document it asked about", async () => {
  const named = parseDocumentId("n4medd0c00000001")!;
  const restamped = parseDocumentId("r3stmpd0c0000002")!;
  const file = { fileName: "Pricing", pageNames: ["Home"], fileKey: figmaFileKey("abc123") };
  const fast = { isOpen: true } as RelayConnection;
  const slow = { isOpen: true } as RelayConnection;
  const documents = new Map<RelayConnection, LinkDocument>([
    [fast, { kind: "identified", documentId: named, ...file }],
    [slow, { kind: "identified", documentId: named, ...file }],
  ]);
  const deps: CallTargetDeps = {
    links: () => [fast, slow],
    linksSettleAt: () => 0,
    documentsSettled: async () => {},
    documentOf: (link) => documents.get(link)!,
    closePrompt: () => {},
    lookupSession: async () => false,
    grantStatus: async (link) => {
      if (link === slow) return "pending";
      // The granting plugin reports a new stamp before the slower panel answers this round.
      documents.set(fast, { kind: "identified", documentId: restamped, ...file });
      return "granted";
    },
  };

  const target = await targetPluginCall(
    deps,
    {
      executionId: mintExecutionId(),
      intent: "Test call" as CallIntent,
      session: null,
      document: named,
      fileKey: null,
    },
    { signal: new AbortController().signal, waitMs: 1_000, pollMs: 10 },
  );

  expect(target).toMatchObject({ kind: "targeted", link: fast, document: { documentId: named } });
});
