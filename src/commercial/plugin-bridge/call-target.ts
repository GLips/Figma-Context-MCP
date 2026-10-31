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
// - A call naming a document (or a file key, which matches only plugins that reported it) runs only
//   there, and only that document's panels are asked to Allow.
// - A call naming neither runs in the one file with the plugin open, asking to Allow there if this
//   project isn't yet. With two or more open it is refused at once with the list (open-files.ts),
//   for the agent to choose from by name. No panel is asked.
//
// Nothing waits on a plugin still linking but the file a call named or was given: that one is the
// run, so the call waits for it to link. Every wait in a call (linking, the file list, a pick, Allow)
// spends one deadline, set when the call started, and each request it sends ends by it.
//
// A document is its stamp. One stamp on two links is either one file open twice (both reported the
// same file key) or a copy; when nothing tells them apart, the human picks in those panels.
import { GRANT_POLL_MS, type GrantState, type GrantStatusAsk } from "@framelink/plugin/protocol";
import type { ExecutionId } from "~/commercial/execution-id.js";
import type { CallIntent } from "./call-intent.js";
import type { CallWait } from "./call-wait.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import type { DocumentId } from "./document-id.js";
import type { LinkDocument, OpenFile } from "./link-documents.js";
import {
  openDocumentSnapshot,
  type OpenDocument,
  type OpenDocumentSnapshot,
  type OpenFilesLookup,
} from "./open-files.js";
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

/** Why a call got no document. Nothing was submitted in any of them. */
export type CallTargetBlock =
  | {
      kind: "document-not-open";
      document: DocumentId | null;
      fileKey: FigmaFileKey | null;
      open: OpenDocumentSnapshot;
    }
  // Named nothing, and not exactly one file is open: the agent chooses.
  | { kind: "document-unchosen"; reason: NoUnnamedCallDefault; open: OpenDocumentSnapshot }
  // The file the call named or was given is open, but its plugin didn't link within the call's wait.
  | { kind: "document-reconnecting"; wait: Extract<CallWait, { kind: "reconnecting" }> }
  // A named call's file list was still incomplete at its deadline: an unknown plugin may be a copy.
  | { kind: "document-list-incomplete"; wait: Extract<CallWait, { kind: "finding-file" }> }
  // The file the call was waiting on was given a new stamp: the agent chooses again.
  | { kind: "document-changed"; fileName: string; open: OpenDocumentSnapshot }
  | { kind: "grant-denied"; fileName: string }
  | { kind: "grant-unavailable"; fileName: string }
  // The call stopped waiting on a person: the project's Allow prompt stays in the panel; a pick goes.
  | { kind: "grant-pending"; wait: Extract<CallWait, { kind: "allow" }> }
  | { kind: "pick-pending"; wait: Extract<CallWait, { kind: "pick" }> }
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

/** A block that is a wait the call stopped in, not a refusal: it carries what it waited on. */
export type WaitingBlock = Extract<CallTargetBlock, { wait: unknown }>;

type Targeted = { kind: "targeted"; link: RelayConnection; document: CallDocument };

export type CallTarget = Targeted | BlockedCallTarget;

type BlockedCallTarget = { kind: "blocked"; block: CallTargetBlock };

export interface CallTargetOptions {
  /** The caller's cancellation: targeting rejects with its reason. */
  signal: AbortSignal;
  /**
   * When the call stops waiting (epoch ms), whatever it waits on: reaching it answers with that wait,
   * never with an error.
   */
  deadline: number;
  pollMs?: number;
  /**
   * Called when the call starts waiting, and again when what it waits on changes. What the first
   * call returns runs when it stops.
   */
  onWaiting?: (wait: CallWait) => () => Promise<void>;
}

/** One GRANT_STATUS question: a prompting one shows the intent of the call it asks for. */
export type GrantStatusRequest = GrantStatusAsk<ExecutionId, DocumentId, CallIntent>;

export interface CallTargetDeps extends OpenFilesLookup {
  /** This server's project: what an Allow prompt asks to grant. */
  project: string;
  /** The authenticated links now: read afresh each round, so a panel that joins mid-wait is seen. */
  links(): RelayConnection[];
  /** Rejects when the plugin couldn't be asked. */
  grantStatus(
    link: RelayConnection,
    request: GrantStatusRequest,
    signal: AbortSignal,
  ): Promise<GrantState>;
  /** Wait `ms`, or less: until the next plugin introduction or drop. */
  pauseForLinkup(ms: number, signal: AbortSignal): Promise<void>;
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

// How often a call waiting on a plugin to link re-reads the open files: an instance may go stale.
const LINKUP_POLL_MS = 1_000;

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
 * Where a call naming nothing runs, by `open` alone: the one open file, or why there is none. The one
 * rule the binder, its refusal and the reference all read.
 */
export type UnnamedCallDefault =
  | { kind: "default"; document: OpenDocument }
  | { kind: "no-files" }
  | { kind: "several-open"; count: number }
  // A linked plugin hasn't said which file it is in: it may be a second one.
  | { kind: "incomplete" };

export type NoUnnamedCallDefault = Exclude<UnnamedCallDefault, { kind: "default" }>;

export function unnamedCallDefault(open: OpenDocumentSnapshot): UnnamedCallDefault {
  if (open.documents.length > 1) return { kind: "several-open", count: open.documents.length };
  if (!open.complete) return { kind: "incomplete" };
  return open.documents.length
    ? { kind: "default", document: open.documents[0] }
    : { kind: "no-files" };
}

export async function targetPluginCall(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: CallTargetOptions,
): Promise<CallTarget> {
  let stopWaiting: (() => Promise<void>) | undefined;
  let shown: string | undefined;
  const waiting = {
    ...options,
    onWaiting: (wait: CallWait) => {
      const key = JSON.stringify(wait);
      if (key === shown) return;
      shown = key;
      const stop = options.onWaiting?.(wait);
      stopWaiting ??= stop;
    },
  };
  try {
    if (request.session !== null)
      return await targetSession(deps, request, request.session, waiting);
    if (request.document !== null || request.fileKey !== null)
      return await targetNamed(deps, request, waiting);
    return await targetUnnamed(deps, request, waiting);
  } finally {
    await stopWaiting?.();
  }
}

type WaitingOptions = Omit<CallTargetOptions, "onWaiting"> & {
  onWaiting: (wait: CallWait) => void;
};

/** The open files now, for a call to bind by or a refusal to list. */
function snapshotNow(
  deps: CallTargetDeps,
  { signal, deadline }: WaitingOptions,
): Promise<OpenDocumentSnapshot> {
  return openDocumentSnapshot(deps, signal, deadline);
}

function remainingMs(deadline: number): number {
  return Math.max(deadline - Date.now(), 0);
}

/** The caller's signal, also aborted at the deadline: for each request a call sends to a plugin. */
function requestSignal({ signal, deadline }: WaitingOptions): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(remainingMs(deadline))]);
}

/** Wait for `settled` until the deadline; past it, go on with what is known. Caller cancel rejects. */
async function settledByDeadline(settled: Promise<void>, options: WaitingOptions): Promise<void> {
  const bounded = requestSignal(options);
  try {
    await abortable(settled, bounded);
  } catch (error) {
    if (options.signal.aborted || !bounded.aborted) throw error;
  }
}

/** Open instances not linked to this server yet, by file name: what a call still linking waits on. */
function reconnecting(
  names: readonly { fileName: string }[],
): Extract<CallWait, { kind: "reconnecting" }> {
  return { kind: "reconnecting", fileNames: [...new Set(names.map((name) => name.fileName))] };
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
  await settledByDeadline(deps.documentsSettled([holder]), options);
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
 * The one open plugin run holding `session`. A miss is final only once every open plugin instance has
 * linked, so a holder still linking isn't reported gone; that wait is bounded by the call's. Links are
 * asked until they answer; one that never could makes the miss a failed lookup.
 */
async function findSessionHolder(
  deps: CallTargetDeps,
  session: SessionHandle,
  options: WaitingOptions,
): Promise<{ kind: "found"; holder: RelayConnection } | BlockedCallTarget> {
  const { signal, deadline, pollMs = GRANT_POLL_MS } = options;
  const answered = new Map<RelayConnection, boolean>();
  const failed = new Set<RelayConnection>();
  for (;;) {
    const unasked = deps.links().filter((link) => !answered.has(link));
    const asking = requestSignal(options);
    const held = await Promise.all(
      unasked.map((link) => deps.lookupSession(link, session, asking).catch(() => null)),
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
    const linking = (await snapshotNow(deps, options)).instances.filter((i) => i.link === null);
    if (!linking.length || Date.now() >= deadline) {
      const unreachable = deps.links().some((link) => failed.has(link));
      return blocked({
        kind: unreachable ? "session-lookup-failed" : "session-not-found",
        session,
      });
    }
    options.onWaiting(reconnecting(linking));
    await deps.pauseForLinkup(Math.min(pollMs, remainingMs(deadline)), signal);
  }
}

/**
 * A call naming a document, a file key, or both: links matching every name given, and no other. A
 * file-key call learns its document from the first plugin, linked or not, that reported that key.
 */
async function targetNamed(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: WaitingOptions,
): Promise<CallTarget> {
  if (request.document !== null) return targetDocument(deps, request, request.document, options);
  const keyed = (await snapshotNow(deps, options)).instances.find(
    (instance) => instance.fileKey === request.fileKey,
  );
  if (keyed) return targetDocument(deps, request, keyed.documentId, options);
  await settledByDeadline(deps.documentsSettled(deps.links()), options);
  const linked = deps
    .links()
    .map((link) => identifiedFile(deps.documentOf(link)))
    .find((file) => file?.fileKey === request.fileKey);
  return linked
    ? targetDocument(deps, request, linked.documentId, options)
    : documentNotOpen(deps, request, options, null);
}

/**
 * Run in `documentId` (and the call's file key, if it named one). Binding waits until the open files
 * are known: every open instance of it that would be a distinct file has linked, and every linked
 * plugin has said which file it is in and answered. One still linking, or unknown, may be a copy that
 * must be in bindFiles' pick, or the call may write into the wrong copy. A plugin in another document
 * holds it only by not answering: its list may name such a copy.
 */
async function targetDocument(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  documentId: DocumentId,
  options: WaitingOptions,
): Promise<CallTarget> {
  const { signal, deadline } = options;
  const matches = (file: { documentId: DocumentId; fileKey: FigmaFileKey | null } | null) =>
    file !== null &&
    file.documentId === documentId &&
    (request.fileKey === null || file.fileKey === request.fileKey);
  for (;;) {
    const open = await snapshotNow(deps, options);
    const candidates = deps
      .links()
      .filter((link) => matches(identifiedFile(deps.documentOf(link))));
    const linkedKeys = new Set(
      candidates.flatMap((link) => identifiedFile(deps.documentOf(link))?.fileKey ?? []),
    );
    // One reporting the file key of a linked one is that same file open again: nothing to pick.
    const linking = open.instances.filter(
      (instance) =>
        instance.link === null &&
        matches(instance) &&
        !(instance.fileKey !== null && linkedKeys.has(instance.fileKey)),
    );
    if (open.complete && !linking.length)
      return candidates.length
        ? bindFiles(deps, request, distinctFiles(candidates, deps.documentOf), options)
        : documentNotOpen(deps, request, options, documentId, open);
    const expired = Date.now() >= deadline;
    if (linking.length) {
      const wait = reconnecting(linking);
      if (expired) return blocked({ kind: "document-reconnecting", wait });
      options.onWaiting(wait);
    } else {
      const wait = { kind: "finding-file" } as const;
      if (expired) return blocked({ kind: "document-list-incomplete", wait });
      options.onWaiting(wait);
    }
    await deps.pauseForLinkup(Math.min(LINKUP_POLL_MS, remainingMs(deadline)), signal);
  }
}

/** No open plugin is in the document the call named (or was bound to before its links closed). */
async function documentNotOpen(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: WaitingOptions,
  document: DocumentId | null,
  open?: OpenDocumentSnapshot,
): Promise<BlockedCallTarget> {
  return blocked({
    kind: "document-not-open",
    document,
    fileKey: request.fileKey,
    open: open ?? (await snapshotNow(deps, options)),
  });
}

/**
 * A call naming nothing: the one open file, or a refusal to choose. Decided on the open files now,
 * listed or linked: a plugin still linking is a file like any other, and is never waited for to tell.
 */
async function targetUnnamed(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  options: WaitingOptions,
): Promise<CallTarget> {
  await settledByDeadline(deps.documentsSettled(deps.links()), options);
  const open = await snapshotNow(deps, options);
  const unnamed = unnamedCallDefault(open);
  if (unnamed.kind !== "default")
    return blocked({ kind: "document-unchosen", reason: unnamed, open });
  return targetDocument(deps, request, unnamed.document.documentId, options);
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
 * new stamp ends the wait: the agent chooses again from the refreshed documents. On the way out every
 * panel asked but the decided one is told the call stopped waiting: a pick goes, an Allow prompt stays.
 */
async function pollPanels<Decided extends { kind: "targeted" | "picked"; link: RelayConnection }>(
  deps: CallTargetDeps,
  request: CallTargetRequest,
  file: OpenFile,
  options: WaitingOptions,
  round: {
    wait: Extract<CallWait, { kind: "allow" | "pick" }>;
    links: () => RelayConnection[];
    decide: (answers: Answer[]) => Decided | BlockedCallTarget | null;
    gone: () => Promise<BlockedCallTarget>;
    expired: () => BlockedCallTarget;
  },
): Promise<Decided | BlockedCallTarget> {
  const { signal, deadline, pollMs = GRANT_POLL_MS } = options;
  const asked = new Set<RelayConnection>();
  let decided: RelayConnection | null = null;
  const restamped = async () =>
    blocked({
      kind: "document-changed",
      fileName: file.fileName,
      open: await snapshotNow(deps, options),
    });
  try {
    for (;;) {
      const live = round.links().filter((link) => link.isOpen && deps.links().includes(link));
      if (
        live.some((link) => identifiedFile(deps.documentOf(link))?.documentId !== file.documentId)
      )
        return await restamped();
      if (!live.length) return await round.gone();
      const asking = requestSignal(options);
      const answers = await Promise.all(
        live.map(async (link) => {
          asked.add(link);
          const state = await deps
            .grantStatus(
              link,
              {
                executionId: request.executionId,
                documentId: file.documentId,
                prompt: round.wait.kind,
                intent: request.intent,
              },
              asking,
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
      options.onWaiting(round.wait);
      await pause(Math.min(pollMs, remainingMs(deadline)), signal);
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
  const wait = { kind: "pick" as const, fileName: file.fileName, since: Date.now() };
  return pollPanels(deps, request, file, options, {
    wait,
    links: () => files.flat(),
    decide: (answers) => {
      const picked = answers.find((answer) => answer.state === "picked");
      return picked ? { kind: "picked" as const, link: picked.link } : null;
    },
    gone: () => documentNotOpen(deps, request, options, file.documentId),
    expired: () => blocked({ kind: "pick-pending", wait }),
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
  const wait = {
    kind: "allow" as const,
    project: deps.project,
    fileName: file.fileName,
    since: Date.now(),
  };
  return pollPanels(deps, request, file, options, {
    wait,
    links: () => links,
    decide: (answers) => {
      const granted = answers.find((answer) => answer.state === "granted");
      if (granted) return targeted(granted.link, file);
      if (answers.some((answer) => answer.state === "denied"))
        return blocked({ kind: "grant-denied", fileName: file.fileName });
      if (answers.length && answers.every((answer) => answer.state === "absent"))
        return blocked({ kind: "grant-unavailable", fileName: file.fileName });
      return null;
    },
    gone,
    expired: () => blocked({ kind: "grant-pending", wait }),
  });
}

/**
 * Bound to the file the panels were asked about, never the link's document now: a link re-stamped
 * while other panels answered must not carry the call to its new document. The plugin refuses an
 * execution whose document it isn't in.
 */
function targeted(link: RelayConnection, file: OpenFile): Targeted {
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
