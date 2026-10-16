/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which document a plugin call runs against, and on which link. Every call resolves to exactly one
// stamped document, under a grant the plugin holds for this project:
//
// - A call naming a session runs only in the plugin run holding it, in the document it is bound to.
//   If no plugin holds it, or the call also names a document or file key that isn't that one, it is
//   refused and never falls through to the rules below.
// - A call naming a document (or a file key, which matches only links that reported it) runs only
//   there, and only that document's panels are asked to Allow.
// - A call naming neither runs in the one open document already granted to this project, once every
//   open plugin's file and grant is known and every plugin still open has had time to redial.
//   Otherwise it is refused with the open documents, for the
//   agent to choose from by name. No panel is asked.
//
// A document is its stamp. One stamp on two links is either one file open twice (both reported the
// same file key) or a copy; when nothing tells them apart, the human picks in those panels.
import {
  GRANT_POLL_MS,
  type GrantPrompt,
  type GrantState,
  type GrantStatusAsk,
} from "@framelink/plugin/protocol";
import type { ExecutionId } from "~/commercial/execution-id.js";
import type { CallIntent } from "./call-intent.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import type { DocumentId } from "./document-id.js";
import type { LinkDocument, OpenFile } from "./link-documents.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionHandle } from "./session-handle.js";

/** The document a call was bound to: what it ran against, and what its reply names. */
export interface CallDocument {
  documentId: DocumentId;
  fileName: string;
  fileKey: FigmaFileKey | null;
}

/** What a call named to run against. Null names nothing: the rules for an unnamed call apply. */
export interface CallTargetRequest {
  /** Minted before targeting: the call's prompts are keyed by it. */
  executionId: ExecutionId;
  /** Shown in any prompt the call raises. It never decides where the call runs. */
  intent: CallIntent;
  session: SessionHandle | null;
  document: DocumentId | null;
  fileKey: FigmaFileKey | null;
}

/** One open document, as an agent chooses from: its names, and where this project stands on it. */
export interface OpenDocument extends OpenFile {
  /** `unknown`: a plugin with it open couldn't be asked. Never read as "not granted". */
  grant: "granted" | "not-granted" | "unknown";
  /** How many open files carry this stamp that nothing tells apart: above 1, a copy is open. */
  copies: number;
}

/**
 * Every open plugin's document, for a refusal or the reference to show. `complete` is false when a
 * plugin hasn't said which file it is in, or couldn't be asked for its grant: then no call defaults.
 */
export interface OpenDocumentSnapshot {
  documents: OpenDocument[];
  /** Why each plugin that couldn't stamp its file can't be used. */
  unidentified: string[];
  complete: boolean;
}

/** Why a call got no document. Nothing was submitted in any of them. */
export type CallTargetBlock =
  | {
      kind: "document-not-open";
      document: DocumentId | null;
      fileKey: FigmaFileKey | null;
      open: OpenDocumentSnapshot;
    }
  // Named nothing, and not exactly one open document is known to be granted: the agent chooses.
  | { kind: "document-unchosen"; reason: NoUnnamedCallDefault; open: OpenDocumentSnapshot }
  // The file the call was waiting on was given a new stamp: the agent chooses again.
  | { kind: "document-changed"; fileName: string; open: OpenDocumentSnapshot }
  | { kind: "grant-denied"; fileName: string }
  | { kind: "grant-unavailable"; fileName: string }
  | { kind: "grant-pending"; fileName: string }
  | { kind: "pick-pending"; fileName: string }
  | { kind: "session-not-found"; session: SessionHandle }
  // An open plugin couldn't be asked whether it holds the session, and none that answered does.
  | { kind: "session-lookup-failed"; session: SessionHandle }
  // Two open plugin runs answered for one handle: a minting collision across plugins. Never guessed.
  | { kind: "session-ambiguous"; session: SessionHandle }
  | {
      kind: "session-document-mismatch";
      session: SessionHandle;
      sessionFileName: string;
      document: DocumentId | null;
      fileKey: FigmaFileKey | null;
    };

type Targeted = { kind: "targeted"; link: RelayConnection; document: CallDocument };

export type CallTarget = Targeted | BlockedCallTarget;

type BlockedCallTarget = { kind: "blocked"; block: CallTargetBlock };

// Human-scale wait. SDK 1.29 only resets idle timeouts if the CLIENT opts into
// resetTimeoutOnProgress. Caller abort wins. A private client deadline that sends
// neither cancellation nor disconnect is not observable by this server.
export const GRANT_WAIT_MS = 120_000;

export interface CallTargetOptions {
  signal: AbortSignal;
  waitMs?: number;
  pollMs?: number;
  /** Called once, when the call starts waiting on the human; what it returns runs when it stops. */
  onWaiting?: () => () => Promise<void>;
}

/** One GRANT_STATUS question: a prompting one shows the intent of the call it asks for. */
export type GrantStatusRequest = GrantStatusAsk<ExecutionId, DocumentId, CallIntent>;

/** What a snapshot reads: each link's document, and its plugin's grant on it. */
export interface OpenDocumentLookup {
  documentOf(link: RelayConnection): LinkDocument;
  /** Rejects when the plugin couldn't be asked. */
  grantStatus(
    link: RelayConnection,
    request: GrantStatusRequest,
    signal: AbortSignal,
  ): Promise<GrantState>;
}

export interface CallTargetDeps extends OpenDocumentLookup {
  /** The authenticated links now: read afresh each round, so a panel that joins mid-wait is seen. */
  links(): RelayConnection[];
  /**
   * When every plugin still open should have dialed this server again, after it started or a link
   * dropped. Until then a plugin missing from links() may only be on its redial backoff.
   */
  linksSettleAt(): number;
  /** Resolves once each of `links` has said which file it is in, or couldn't. */
  documentsSettled(links: readonly RelayConnection[]): Promise<void>;
  closePrompt(link: RelayConnection, executionId: ExecutionId): void;
  /** Whether a link's plugin holds `session` for this project. Rejects when it couldn't be asked. */
  lookupSession(
    link: RelayConnection,
    session: SessionHandle,
    signal: AbortSignal,
  ): Promise<boolean>;
}

function identifiedFile(document: LinkDocument): OpenFile | null {
  return document.kind === "identified" ? document : null;
}

/**
 * The files `links` are in that nothing tells apart: links in one document collapse only when both
 * reported the same file key. A link without one is its own file — it may be a copy.
 */
function distinctFiles(
  links: readonly RelayConnection[],
  documentOf: (link: RelayConnection) => LinkDocument,
): RelayConnection[][] {
  const files = new Map<string, RelayConnection[]>();
  links.forEach((link, index) => {
    const file = identifiedFile(documentOf(link));
    if (!file) return;
    const key = file.fileKey
      ? `${file.documentId}\n${file.fileKey}`
      : `${file.documentId}\n#${index}`;
    files.set(key, [...(files.get(key) ?? []), link]);
  });
  return [...files.values()];
}

/**
 * Every open document, with this project's grant on each, without prompting. Documents are counted
 * by stamp, not by link: one file in two plugin instances is one entry.
 */
export async function openDocumentSnapshot(
  links: readonly RelayConnection[],
  lookup: OpenDocumentLookup,
  executionId: ExecutionId,
  signal: AbortSignal,
): Promise<OpenDocumentSnapshot> {
  const documents = links.map((link) => lookup.documentOf(link));
  const states = await Promise.all(
    links.map((link, index) => {
      const file = identifiedFile(documents[index]);
      return file
        ? lookup
            .grantStatus(link, { executionId, documentId: file.documentId, prompt: "none" }, signal)
            .catch(() => null)
        : null;
    }),
  );
  signal.throwIfAborted();
  const byId = new Map<
    DocumentId,
    { file: OpenFile; links: RelayConnection[]; states: unknown[] }
  >();
  links.forEach((link, index) => {
    const file = identifiedFile(documents[index]);
    if (!file) return;
    const entry = byId.get(file.documentId) ?? { file, links: [], states: [] };
    entry.links.push(link);
    entry.states.push(states[index]);
    byId.set(file.documentId, entry);
  });
  const open = [...byId.values()].map(({ file, links: copies, states: answers }) => ({
    documentId: file.documentId,
    fileName: file.fileName,
    pageNames: file.pageNames,
    fileKey: file.fileKey,
    grant: answers.includes("granted")
      ? ("granted" as const)
      : answers.every((state) => state === "absent")
        ? ("not-granted" as const)
        : ("unknown" as const),
    copies: distinctFiles(copies, (link) => lookup.documentOf(link)).length,
  }));
  return {
    documents: open,
    unidentified: documents.flatMap((document) =>
      document.kind === "unidentified" ? [document.problem] : [],
    ),
    complete:
      documents.every((document) => document.kind !== "unknown") &&
      open.every((document) => document.grant !== "unknown"),
  };
}

/**
 * Where a call naming nothing runs, by `open` alone: the one open document granted to this project,
 * or why there is none. The one rule the binder, its refusal and the reference all read.
 */
export type UnnamedCallDefault =
  | { kind: "default"; document: OpenDocument }
  | { kind: "no-files" }
  // More granted documents can only appear as links arrive, so this never resolves to a default.
  | { kind: "several-granted"; count: number }
  | { kind: "incomplete" }
  | { kind: "none-granted" };

export type NoUnnamedCallDefault = Exclude<UnnamedCallDefault, { kind: "default" }>;

export function unnamedCallDefault(open: OpenDocumentSnapshot): UnnamedCallDefault {
  const granted = open.documents.filter((document) => document.grant === "granted");
  if (!open.documents.length) return { kind: "no-files" };
  if (granted.length > 1) return { kind: "several-granted", count: granted.length };
  // With a plugin whose file or grant is unknown, the one granted document may not be the only one.
  if (!open.complete) return { kind: "incomplete" };
  return granted.length ? { kind: "default", document: granted[0] } : { kind: "none-granted" };
}

export async function targetPluginCall(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: CallTargetOptions,
): Promise<CallTarget> {
  let stopWaiting: (() => Promise<void>) | undefined;
  const waiting = {
    ...options,
    onWaiting: () => {
      stopWaiting ??= options.onWaiting?.();
    },
  };
  try {
    await abortable(deps.documentsSettled(deps.links()), options.signal);
    if (request.session !== null)
      return await targetSession(deps, request, request.session, waiting);
    if (request.document !== null || request.fileKey !== null)
      return await targetNamed(deps, request, waiting);
    return await targetUnnamed(deps, request, waiting);
  } finally {
    await stopWaiting?.();
  }
}

type WaitingOptions = Omit<CallTargetOptions, "onWaiting"> & { onWaiting: () => void };

/** The open documents now, for a refusal: read without prompting, under this call's id. */
function snapshotNow(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  { signal }: WaitingOptions,
): Promise<OpenDocumentSnapshot> {
  return openDocumentSnapshot(deps.links(), deps, request.executionId, signal);
}

/** A call naming its session: the one plugin run holding it, asked for a grant there and nowhere else. */
async function targetSession(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  session: SessionHandle,
  options: WaitingOptions,
): Promise<CallTarget> {
  const found = await findSessionHolder(deps, session, options);
  if (found.kind === "blocked") return found;
  const { holder } = found;
  await abortable(deps.documentsSettled([holder]), options.signal);
  const file = identifiedFile(deps.documentOf(holder));
  if (!file) return blocked({ kind: "session-lookup-failed", session });
  if (
    (request.document !== null && request.document !== file.documentId) ||
    (request.fileKey !== null && request.fileKey !== file.fileKey)
  )
    return blocked({
      kind: "session-document-mismatch",
      session,
      sessionFileName: file.fileName,
      document: request.document,
      fileKey: request.fileKey,
    });
  return waitForGrant(deps, request, [holder], file, options, async () =>
    blocked({ kind: "session-not-found", session }),
  );
}

/**
 * The one open plugin run holding `session`. A miss is final only once every plugin still open has
 * had time to dial in, so a holder on its redial backoff after a server (re)start isn't reported
 * gone. Links are asked until they answer; one that never could makes the miss a failed lookup.
 */
async function findSessionHolder(
  deps: CallTargetDeps,
  session: SessionHandle,
  { signal, waitMs = GRANT_WAIT_MS, pollMs = GRANT_POLL_MS }: WaitingOptions,
): Promise<{ kind: "found"; holder: RelayConnection } | BlockedCallTarget> {
  const settleAt = Math.min(deps.linksSettleAt(), Date.now() + waitMs);
  const answered = new Map<RelayConnection, boolean>();
  const failed = new Set<RelayConnection>();
  for (;;) {
    const unasked = deps.links().filter((link) => !answered.has(link));
    const held = await Promise.all(
      unasked.map((link) => deps.lookupSession(link, session, signal).catch(() => null)),
    );
    signal.throwIfAborted();
    unasked.forEach((link, index) => {
      const answer = held[index];
      if (answer === null) failed.add(link);
      else {
        failed.delete(link);
        answered.set(link, answer);
      }
    });
    const holders = deps.links().filter((link) => answered.get(link) === true);
    if (holders.length > 1) return blocked({ kind: "session-ambiguous", session });
    if (holders.length === 1) return { kind: "found", holder: holders[0] };
    if (Date.now() >= settleAt) {
      const unreachable = deps.links().some((link) => failed.has(link));
      return blocked({
        kind: unreachable ? "session-lookup-failed" : "session-not-found",
        session,
      });
    }
    await pause(Math.min(pollMs, Math.max(settleAt - Date.now(), 0)), signal);
  }
}

/** A call naming a document, a file key, or both: links matching every name given, and no other. */
async function targetNamed(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: WaitingOptions,
): Promise<CallTarget> {
  const matches = (link: RelayConnection) => {
    const file = identifiedFile(deps.documentOf(link));
    return (
      file !== null &&
      (request.document === null || file.documentId === request.document) &&
      (request.fileKey === null || file.fileKey === request.fileKey)
    );
  };
  const candidates = deps.links().filter(matches);
  if (!candidates.length) return documentNotOpen(deps, request, options, request.document);
  return bindFiles(deps, request, distinctFiles(candidates, deps.documentOf), options);
}

/** No open plugin is in the document the call named (or was bound to before its links closed). */
async function documentNotOpen(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: WaitingOptions,
  document: DocumentId | null,
): Promise<BlockedCallTarget> {
  return blocked({
    kind: "document-not-open",
    document,
    fileKey: request.fileKey,
    open: await snapshotNow(deps, request, options),
  });
}

/**
 * A call naming nothing: the one open document granted to this project, or a refusal to choose.
 * Decided only once every plugin still open has had time to redial: one on its backoff may hold
 * the grant (none seen yet) or a second one (one seen).
 */
async function targetUnnamed(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: WaitingOptions,
): Promise<CallTarget> {
  const { signal, pollMs = GRANT_POLL_MS } = options;
  let documentId: DocumentId;
  for (;;) {
    const open = await snapshotNow(deps, request, options);
    const unnamed = unnamedCallDefault(open);
    const settleAt = deps.linksSettleAt();
    const settled = Date.now() >= settleAt;
    if (unnamed.kind === "default" && settled) {
      documentId = unnamed.document.documentId;
      break;
    }
    if (unnamed.kind !== "default" && (settled || unnamed.kind === "several-granted"))
      return blocked({ kind: "document-unchosen", reason: unnamed, open });
    await pause(Math.min(pollMs, settleAt - Date.now()), signal);
  }
  const candidates = deps
    .links()
    .filter((link) => identifiedFile(deps.documentOf(link))?.documentId === documentId);
  return bindFiles(deps, request, distinctFiles(candidates, deps.documentOf), options);
}

/** Run in one of `files` (all one document): picked by the human when nothing tells them apart. */
async function bindFiles(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  files: RelayConnection[][],
  options: WaitingOptions,
): Promise<CallTarget> {
  const file = identifiedFile(deps.documentOf(files[0][0]))!;
  let links = files[0];
  if (files.length > 1) {
    const picked = await waitForPick(deps, request, files, file, options);
    if (picked.kind === "blocked") return picked;
    links = [picked.link];
  }
  return waitForGrant(deps, request, links, file, options, () =>
    documentNotOpen(deps, request, options, file.documentId),
  );
}

interface Answer {
  link: RelayConnection;
  state: GrantState;
}

/**
 * Ask `prompt` of every link in `links()` for this call, round after round, until `decide` settles
 * it, the links all close (`gone`), or the wait runs out (`expired`). A link whose file was given a
 * new stamp ends the wait: the agent chooses again from the refreshed documents. Every prompt this
 * round opened is closed on the way out, but the decided link's.
 */
async function pollPanels<Decided extends { kind: "targeted" | "picked"; link: RelayConnection }>(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  file: OpenFile,
  options: WaitingOptions,
  round: {
    prompt: Exclude<GrantPrompt, "none">;
    links: () => RelayConnection[];
    decide: (answers: Answer[]) => Decided | BlockedCallTarget | null;
    gone: () => Promise<BlockedCallTarget>;
    expired: () => BlockedCallTarget;
  },
): Promise<Decided | BlockedCallTarget> {
  const { signal, waitMs = GRANT_WAIT_MS, pollMs = GRANT_POLL_MS } = options;
  const deadline = Date.now() + waitMs;
  const asked = new Set<RelayConnection>();
  let decided: RelayConnection | null = null;
  const restamped = async () =>
    blocked({
      kind: "document-changed",
      fileName: file.fileName,
      open: await snapshotNow(deps, request, options),
    });
  try {
    for (;;) {
      const live = round.links().filter((link) => link.isOpen && deps.links().includes(link));
      if (
        live.some((link) => identifiedFile(deps.documentOf(link))?.documentId !== file.documentId)
      )
        return await restamped();
      if (!live.length) return await round.gone();
      const answers = await Promise.all(
        live.map(async (link) => {
          asked.add(link);
          const state = await deps
            .grantStatus(
              link,
              {
                executionId: request.executionId,
                documentId: file.documentId,
                prompt: round.prompt,
                intent: request.intent,
              },
              signal,
            )
            .catch(() => null);
          return state === null ? [] : [{ link, state }];
        }),
      );
      signal.throwIfAborted();
      const answered = answers.flat();
      if (answered.some((answer) => answer.state === "other-document")) return await restamped();
      const outcome = round.decide(answered);
      if (outcome) {
        if (outcome.kind !== "blocked") decided = outcome.link;
        return outcome;
      }
      if (Date.now() >= deadline) return round.expired();
      options.onWaiting();
      await pause(Math.min(pollMs, Math.max(deadline - Date.now(), 0)), signal);
    }
  } finally {
    for (const link of asked)
      if (link !== decided && link.isOpen) deps.closePrompt(link, request.executionId);
  }
}

/** Several files carry one stamp: the human picks this call's in one of their panels. */
async function waitForPick(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  files: RelayConnection[][],
  file: OpenFile,
  options: WaitingOptions,
): Promise<{ kind: "picked"; link: RelayConnection } | BlockedCallTarget> {
  return pollPanels(deps, request, file, options, {
    prompt: "pick",
    links: () => files.flat(),
    decide: (answers) => {
      const picked = answers.find((answer) => answer.state === "picked");
      return picked ? { kind: "picked" as const, link: picked.link } : null;
    },
    gone: () => documentNotOpen(deps, request, options, file.documentId),
    expired: () => blocked({ kind: "pick-pending", fileName: file.fileName }),
  });
}

/** Ask `links` (one file) to Allow this call's project, unless it already holds a grant. */
async function waitForGrant(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  links: RelayConnection[],
  file: OpenFile,
  options: WaitingOptions,
  gone: () => Promise<BlockedCallTarget>,
): Promise<CallTarget> {
  return pollPanels(deps, request, file, options, {
    prompt: "allow",
    links: () => links,
    decide: (answers) => {
      const granted = answers.find((answer) => answer.state === "granted");
      if (granted) return targeted(deps, granted.link);
      if (answers.some((answer) => answer.state === "denied"))
        return blocked({ kind: "grant-denied", fileName: file.fileName });
      if (answers.length && answers.every((answer) => answer.state === "absent"))
        return blocked({ kind: "grant-unavailable", fileName: file.fileName });
      return null;
    },
    gone,
    expired: () => blocked({ kind: "grant-pending", fileName: file.fileName }),
  });
}

function targeted(deps: CallTargetDeps, link: RelayConnection): Targeted {
  const file = identifiedFile(deps.documentOf(link))!;
  return {
    kind: "targeted",
    link,
    document: { documentId: file.documentId, fileName: file.fileName, fileKey: file.fileKey },
  };
}

function blocked(block: CallTargetBlock): BlockedCallTarget {
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
