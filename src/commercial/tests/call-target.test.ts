/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Targeting against stand-in links, for orderings a real plugin can't be made to produce on cue.
import { expect, it } from "vitest";
import {
  targetPluginCall,
  type CallTargetDeps,
  type CallTargetOptions,
} from "~/commercial/plugin-bridge/call-target.js";
import type { CallIntent } from "~/commercial/plugin-bridge/call-intent.js";
import { parseDocumentId } from "~/commercial/plugin-bridge/document-id.js";
import type { LinkDocument } from "~/commercial/plugin-bridge/link-documents.js";
import type { RelayConnection } from "~/commercial/plugin-bridge/relay-connection.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import { figmaFileKey } from "~/utils/figma-url.js";

it("a call granted in a panel whose file is re-stamped mid-round stays bound to the document it asked about", async () => {
  const named = parseDocumentId("n4medd0c00000001")!;
  const restamped = parseDocumentId("r3stmpd0c0000002")!;
  const file = { fileName: "Pricing", fileKey: figmaFileKey("abc123") };
  const fast = { isOpen: true } as RelayConnection;
  const slow = { isOpen: true } as RelayConnection;
  const documents = new Map<RelayConnection, LinkDocument>([
    [fast, { kind: "identified", documentId: named, ...file }],
    [slow, { kind: "identified", documentId: named, ...file }],
  ]);
  const deps: CallTargetDeps = {
    project: "/work/app",
    links: () => [fast, slow],
    instanceOf: () => undefined,
    openInstances: async () => [],
    pauseForLinkup: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    { signal: new AbortController().signal, deadline: Date.now() + 1_000, pollMs: 10 },
  );

  expect(target).toMatchObject({ kind: "targeted", link: fast, document: { documentId: named } });
});

const DOCUMENT = parseDocumentId("d0c00000000000aa")!;

/** Stand-in links that all answer, in the files `documents` says, asked for grants by `grantStatus`. */
function standInDeps(
  documents: Map<RelayConnection, LinkDocument>,
  grantStatus: CallTargetDeps["grantStatus"],
): CallTargetDeps {
  return {
    project: "/work/app",
    links: () => [...documents.keys()],
    instanceOf: () => undefined,
    openInstances: async () => [],
    pauseForLinkup: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    documentsSettled: async () => {},
    documentOf: (link) => documents.get(link)!,
    closePrompt: () => {},
    lookupSession: async () => false,
    grantStatus,
  };
}

function namedCall(deps: CallTargetDeps, options: CallTargetOptions) {
  return targetPluginCall(
    deps,
    {
      executionId: mintExecutionId(),
      intent: "Test call" as CallIntent,
      session: null,
      document: DOCUMENT,
      fileKey: null,
    },
    options,
  );
}

it("a pick answered late leaves the Allow wait only what is left of the call's one deadline", async () => {
  const original = { isOpen: true } as RelayConnection;
  const copy = { isOpen: true } as RelayConnection;
  // Two files with one stamp and no file key: nothing tells them apart, so the human picks.
  const file: LinkDocument = {
    kind: "identified",
    documentId: DOCUMENT,
    fileName: "Pricing",
    fileKey: null,
  };
  const documents = new Map<RelayConnection, LinkDocument>([
    [original, file],
    [copy, file],
  ]);
  const startedAt = Date.now();
  const deps = standInDeps(documents, async (link, { prompt }) => {
    if (prompt === "pick")
      return link === original && Date.now() - startedAt > 300 ? "picked" : "pending";
    return "pending";
  });

  const target = await namedCall(deps, {
    signal: new AbortController().signal,
    deadline: startedAt + 400,
    pollMs: 10,
  });

  expect(target).toMatchObject({ kind: "blocked", block: { kind: "grant-pending" } });
  expect(Date.now() - startedAt).toBeLessThan(500);
});

it("a named call doesn't bind while a linked plugin hasn't said which file it is in", async () => {
  const known = { isOpen: true } as RelayConnection;
  const unknown = { isOpen: true } as RelayConnection;
  const documents = new Map<RelayConnection, LinkDocument>([
    [known, { kind: "identified", documentId: DOCUMENT, fileName: "Pricing", fileKey: null }],
    // It may be another copy of DOCUMENT: binding to `known` now could edit the wrong one.
    [unknown, { kind: "unknown" }],
  ]);
  const asked: unknown[] = [];
  const deps = standInDeps(documents, async (_link, request) => {
    asked.push(request);
    return "granted";
  });

  const target = await namedCall(deps, {
    signal: new AbortController().signal,
    deadline: Date.now() + 150,
    pollMs: 10,
  });

  expect(target).toMatchObject({
    kind: "blocked",
    block: { kind: "document-list-incomplete", wait: { kind: "finding-file" } },
  });
  expect(asked).toEqual([]);
});
