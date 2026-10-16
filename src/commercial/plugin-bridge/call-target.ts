/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which document a plugin call runs against, and on which link. Every call resolves to exactly one
// proven document, under a grant the plugin holds for this project:
//
// - A call naming a file runs only there. Its panels prompt for a grant; no other panel is asked,
//   and if no link can be proven to be in that file, the call is refused.
// - A call naming none runs in the one open document already granted to this project. Otherwise
//   every panel is asked: proven ones to pick their file, the rest for their file's link. The first
//   pick wins and the other prompts close, so a late click can't redirect a call already bound.
//
// Documents are counted, not links: one file open in two plugin instances is one document.
import { GRANT_POLL_MS, type GrantPrompt, type GrantState } from "@framelink/plugin/protocol";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import type { DocumentReader, LinkDocument, LinkDocuments } from "./link-documents.js";
import type { RelayConnection } from "./relay-connection.js";

/** The document a call was bound to: what it ran against, and what its reply names. */
export interface CallDocument {
  fileKey: FigmaFileKey;
  fileName: string;
}

/** Why a call got no document. Nothing was submitted in any of them. */
export type CallTargetBlock =
  | { kind: "document-not-open"; fileKey: FigmaFileKey }
  | { kind: "document-unprovable"; fileKey: FigmaFileKey | null; problem: string }
  | { kind: "grant-denied"; fileName: string }
  | { kind: "grant-unavailable"; fileName: string }
  | { kind: "grant-pending"; fileName: string | null };

export type CallTarget =
  | { kind: "targeted"; link: RelayConnection; document: CallDocument }
  | { kind: "blocked"; block: CallTargetBlock };

// Human-scale wait. SDK 1.29 only resets idle timeouts if the CLIENT opts into
// resetTimeoutOnProgress. Caller abort wins. A private client deadline that sends
// neither cancellation nor disconnect is not observable by this server.
export const GRANT_WAIT_MS = 120_000;

export interface CallTargetOptions {
  /** Reads files for proofs: the call's own token, so a proof spends what the call may spend. */
  reader: DocumentReader | null;
  signal: AbortSignal;
  waitMs?: number;
  pollMs?: number;
  /** Called once, when the call starts waiting on the human; what it returns runs when it stops. */
  onWaiting?: () => () => Promise<void>;
}

export interface CallTargetDeps {
  /** The authenticated links now: read afresh each round, so a panel that joins mid-wait is asked. */
  links(): RelayConnection[];
  documents: LinkDocuments;
  askGrant(
    link: RelayConnection,
    fileKey: FigmaFileKey | null,
    prompt: GrantPrompt,
    signal: AbortSignal,
  ): Promise<GrantState>;
  closePrompt(link: RelayConnection): void;
}

/** What counting granted documents reads: each link's document, and its plugin's grant on it. */
export interface GrantedDocumentLookup {
  documentOf(link: RelayConnection): LinkDocument;
  grantStatus(
    link: RelayConnection,
    fileKey: FigmaFileKey,
    prompt: GrantPrompt,
    signal: AbortSignal,
  ): Promise<GrantState>;
}

/** A proven, open document this project holds a grant on, and one link that is in it. */
export interface GrantedOpenDocument {
  link: RelayConnection;
  document: CallDocument;
}

/**
 * The open documents this project may edit, without prompting: every proven link is asked, and
 * documents are counted, not links, so one file in two plugin instances is one entry. A failed ask
 * rejects; the caller decides what that means.
 */
export async function grantedOpenDocuments(
  links: readonly RelayConnection[],
  lookup: GrantedDocumentLookup,
  signal: AbortSignal,
): Promise<Map<FigmaFileKey, GrantedOpenDocument>> {
  const proven = links.flatMap((link) => {
    const document = lookup.documentOf(link);
    return document.kind === "proven"
      ? [{ link, document: { fileKey: document.fileKey, fileName: document.fileName } }]
      : [];
  });
  const states = await Promise.all(
    proven.map(({ link, document }) => lookup.grantStatus(link, document.fileKey, "none", signal)),
  );
  signal.throwIfAborted();
  const granted = new Map<FigmaFileKey, GrantedOpenDocument>();
  proven.forEach((entry, index) => {
    if (states[index] === "granted" && !granted.has(entry.document.fileKey))
      granted.set(entry.document.fileKey, entry);
  });
  return granted;
}

export async function targetPluginCall(
  deps: CallTargetDeps,
  fileKey: FigmaFileKey | null,
  options: CallTargetOptions,
): Promise<CallTarget> {
  await abortable(deps.documents.settled(deps.links()), options.signal);
  return fileKey === null ? targetUnnamed(deps, options) : targetNamed(deps, fileKey, options);
}

/** A call that named its file: prove a link is in it if none is yet, then ask only there. */
async function targetNamed(
  deps: CallTargetDeps,
  fileKey: FigmaFileKey,
  options: CallTargetOptions,
): Promise<CallTarget> {
  const { documents } = deps;
  const provenIn = (link: RelayConnection) => {
    const document = documents.documentOf(link);
    return document.kind === "proven" && document.fileKey === fileKey;
  };
  const holders = () => deps.links().filter(provenIn);
  if (!holders().length) {
    // Only links that might be in it: unclaimed ones, and ones claiming this very file.
    const candidates = deps.links().filter((link) => {
      const document = documents.documentOf(link);
      return (
        document.kind === "unclaimed" ||
        (document.kind === "claimed" && document.fileKey === fileKey)
      );
    });
    if (candidates.length && !options.reader)
      return blocked({
        kind: "document-unprovable",
        fileKey,
        problem: "this server has no Figma token to read the file with",
      });
    if (candidates.length && options.reader) {
      const { problem } = await abortable(
        documents.prove(candidates, fileKey, options.reader),
        options.signal,
      );
      if (!holders().length && problem !== null)
        return blocked({ kind: "document-unprovable", fileKey, problem });
    }
    if (!holders().length) return blocked({ kind: "document-not-open", fileKey });
  }
  return waitForGrant(deps, options, {
    ask: () => holders().map((link) => ({ link, fileKey, prompt: "grant" })),
    onRound(answers) {
      const granted = answers.find((answer) => answer.state === "granted");
      if (granted) return targeted(documents, granted.link);
      const denied = answers.find((answer) => answer.state === "denied");
      if (denied)
        return blocked({
          kind: "grant-denied",
          fileName: documentOf(documents, denied.link).fileName,
        });
      if (answers.length && answers.every((answer) => answer.state === "absent"))
        return blocked({
          kind: "grant-unavailable",
          fileName: documentOf(documents, answers[0].link).fileName,
        });
      if (!answers.length && !holders().length)
        return blocked({ kind: "document-not-open", fileKey });
      return null;
    },
    expired: () => {
      const holder = holders()[0];
      return blocked({
        kind: "grant-pending",
        fileName: holder ? documentOf(documents, holder).fileName : null,
      });
    },
  });
}

/** A call that named no file: the one granted document, else a pick across every panel. */
async function targetUnnamed(
  deps: CallTargetDeps,
  options: CallTargetOptions,
): Promise<CallTarget> {
  const { documents } = deps;
  // A claim no process-wide reader could prove at introduction is proven with the call's reader
  // first, so a file that already holds a grant runs without a click.
  if (options.reader)
    await abortable(documents.proveClaims(deps.links(), options.reader), options.signal);
  const granted = await grantedOpenDocuments(
    deps.links(),
    {
      documentOf: (link) => documents.documentOf(link),
      grantStatus: (link, fileKey, prompt, signal) =>
        deps.askGrant(link, fileKey, prompt, signal).catch(() => "absent" as const),
    },
    options.signal,
  );
  if (granted.size === 1) return targeted(documents, [...granted.values()][0].link);

  const anyProven = deps.links().some((link) => documents.documentOf(link).kind === "proven");
  if (!anyProven && !options.reader)
    return blocked({
      kind: "document-unprovable",
      fileKey: null,
      problem: "this server has no Figma token to read files with",
    });
  return waitForGrant(deps, options, {
    ask: () =>
      deps.links().map((link) => {
        const document = documents.documentOf(link);
        // An unproven panel asks for its file's link; a link the human pasted is proven meanwhile.
        if (document.kind === "claimed" && options.reader && !documents.isBusy(link))
          void documents.prove([link], document.fileKey, options.reader);
        return {
          link,
          fileKey: document.kind === "proven" ? document.fileKey : null,
          prompt: "select",
        };
      }),
    onRound(answers) {
      const picked = answers.find(
        (answer) =>
          answer.state === "granted" && documents.documentOf(answer.link).kind === "proven",
      );
      return picked ? targeted(documents, picked.link) : null;
    },
    expired: () => blocked({ kind: "grant-pending", fileName: null }),
  });
}

/** The document of a link the caller knows is proven. */
function documentOf(documents: LinkDocuments, link: RelayConnection): CallDocument {
  const document = documents.documentOf(link);
  if (document.kind !== "proven") throw new Error("Expected a proven plugin link");
  return { fileKey: document.fileKey, fileName: document.fileName };
}

interface Ask {
  link: RelayConnection;
  fileKey: FigmaFileKey | null;
  prompt: GrantPrompt;
}

interface Answer {
  link: RelayConnection;
  state: GrantState;
}

/**
 * Poll the asked panels until a round decides, or the wait runs out. Every prompt this call opened
 * is closed on the way out, whatever ended it.
 */
async function waitForGrant(
  deps: CallTargetDeps,
  { signal, waitMs = GRANT_WAIT_MS, pollMs = GRANT_POLL_MS, onWaiting }: CallTargetOptions,
  round: {
    ask: () => Ask[];
    onRound: (answers: Answer[]) => CallTarget | null;
    expired: () => CallTarget;
  },
): Promise<CallTarget> {
  const deadline = Date.now() + waitMs;
  const asked = new Set<RelayConnection>();
  let decided: RelayConnection | null = null;
  let stopWaiting: (() => Promise<void>) | undefined;
  try {
    for (;;) {
      const answers = await Promise.all(
        round.ask().map(async ({ link, fileKey, prompt }) => {
          asked.add(link);
          const state = await deps.askGrant(link, fileKey, prompt, signal).catch(() => null);
          return state === null ? [] : [{ link, state }];
        }),
      );
      signal.throwIfAborted();
      const outcome = round.onRound(answers.flat());
      if (outcome) {
        if (outcome.kind === "targeted") decided = outcome.link;
        return outcome;
      }
      if (Date.now() >= deadline) return round.expired();
      stopWaiting ??= onWaiting?.();
      await pause(Math.min(pollMs, Math.max(deadline - Date.now(), 0)), signal);
    }
  } finally {
    for (const link of asked) if (link !== decided && link.isOpen) deps.closePrompt(link);
    await stopWaiting?.();
  }
}

function targeted(documents: LinkDocuments, link: RelayConnection): CallTarget {
  return { kind: "targeted", link, document: documentOf(documents, link) };
}

function blocked(block: CallTargetBlock): CallTarget {
  return { kind: "blocked", block };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(new Promise((resolve) => setTimeout(resolve, ms)), signal);
}
