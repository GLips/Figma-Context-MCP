/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which document a plugin call runs against, and on which link. Every call resolves to exactly one
// proven document, under a grant the plugin holds for this project:
//
// - A call naming a session runs only in the plugin run holding it, in the document the session is
//   bound to. If no plugin holds it once every open one has had time to dial in, or the call names
//   another file, it is refused and never falls through to the rules below.
// - A call naming a file runs only there. Its panels prompt for a grant; no other panel is asked,
//   and if no link can be proven to be in that file, the call is refused.
// - A call naming none runs in the one open document already granted to this project, once every
//   panel's file and grant is known. Otherwise every panel is asked: proven ones to pick their file, the rest for their file's link. The first
//   pick wins and the other prompts close, so a late click can't redirect a call already bound.
//
// Documents are counted, not links: one file open in two plugin instances is one document.
import { GRANT_POLL_MS, type GrantPrompt, type GrantState } from "@framelink/plugin/protocol";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import type { DocumentReader, LinkDocument, LinkDocuments } from "./link-documents.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionHandle } from "./session-handle.js";

/** The document a call was bound to: what it ran against, and what its reply names. */
export interface CallDocument {
  fileKey: FigmaFileKey;
  fileName: string;
}

/** What a call named to run against. Null names nothing: the rules for an unnamed call apply. */
export interface CallTargetRequest {
  fileKey: FigmaFileKey | null;
  session: SessionHandle | null;
}

/** Why a call got no document. Nothing was submitted in any of them. */
export type CallTargetBlock =
  | { kind: "document-not-open"; fileKey: FigmaFileKey }
  | { kind: "document-unprovable"; fileKey: FigmaFileKey | null; problem: string }
  | { kind: "grant-denied"; fileName: string }
  | { kind: "grant-unavailable"; fileName: string }
  | { kind: "grant-pending"; fileName: string | null }
  | { kind: "session-not-found"; session: SessionHandle }
  // An open plugin couldn't be asked whether it holds the session, and none that answered does.
  | { kind: "session-lookup-failed"; session: SessionHandle }
  // Two open plugin runs answered for one handle: a minting collision across plugins. Never guessed.
  | { kind: "session-ambiguous"; session: SessionHandle }
  | {
      kind: "session-document-mismatch";
      session: SessionHandle;
      sessionFileName: string;
      fileKey: FigmaFileKey;
    };

export type CallTarget =
  | { kind: "targeted"; link: RelayConnection; document: CallDocument }
  | BlockedCallTarget;

type BlockedCallTarget = { kind: "blocked"; block: CallTargetBlock };

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
  /**
   * When every plugin still open should have dialed this server again, after it started or a link
   * dropped. Until then a plugin missing from links() may only be on its redial backoff.
   */
  linksSettleAt(): number;
  documents: LinkDocuments;
  askGrant(
    link: RelayConnection,
    fileKey: FigmaFileKey | null,
    prompt: GrantPrompt,
    signal: AbortSignal,
  ): Promise<GrantState>;
  closePrompt(link: RelayConnection): void;
  /**
   * Whether a link's plugin holds `session` for this project, in its proven document. Rejects when
   * the plugin couldn't be asked.
   */
  lookupSession(
    link: RelayConnection,
    session: SessionHandle,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/** What counting granted documents reads: each link's document, and its plugin's grant on it. */
export interface GrantedDocumentLookup {
  documentOf(link: RelayConnection): LinkDocument;
  /** Rejects when the plugin couldn't be asked. */
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

export interface GrantedOpenDocuments {
  granted: Map<FigmaFileKey, GrantedOpenDocument>;
  /**
   * Whether `granted` is the whole answer. False when some link's file is unknown, or its claim is
   * unproven for a reason that may pass, or its plugin couldn't be asked for its grant: that link
   * could be in another granted document.
   */
  complete: boolean;
}

/**
 * The open documents this project may edit, without prompting: every proven link is asked, and
 * documents are counted, not links, so one file in two plugin instances is one entry.
 */
export async function grantedOpenDocuments(
  links: readonly RelayConnection[],
  lookup: GrantedDocumentLookup,
  signal: AbortSignal,
): Promise<GrantedOpenDocuments> {
  const documents = links.map((link) => lookup.documentOf(link));
  const proven = links.flatMap((link, index) => {
    const document = documents[index];
    return document.kind === "proven"
      ? [{ link, document: { fileKey: document.fileKey, fileName: document.fileName } }]
      : [];
  });
  const states = await Promise.all(
    proven.map(({ link, document }) =>
      lookup.grantStatus(link, document.fileKey, "none", signal).catch(() => null),
    ),
  );
  signal.throwIfAborted();
  const granted = new Map<FigmaFileKey, GrantedOpenDocument>();
  proven.forEach((entry, index) => {
    if (states[index] === "granted" && !granted.has(entry.document.fileKey))
      granted.set(entry.document.fileKey, entry);
  });
  const complete = documents.every(isDocumentSettled) && !states.includes(null);
  return { granted, complete };
}

/**
 * Whether this server knows a link isn't in some editable file it hasn't proven. An unclaimed link
 * isn't in a granted file: proving a file writes its claim into the root, so a fresh run there
 * claims it.
 */
function isDocumentSettled(document: LinkDocument): boolean {
  return (
    document.kind === "proven" ||
    document.kind === "unclaimed" ||
    (document.kind === "claimed" && document.problem?.kind === "unmarkable")
  );
}

export async function targetPluginCall(
  deps: CallTargetDeps,
  { fileKey, session }: CallTargetRequest,
  options: CallTargetOptions,
): Promise<CallTarget> {
  await abortable(deps.documents.settled(deps.links()), options.signal);
  if (session !== null) return targetSession(deps, session, fileKey, options);
  return fileKey === null ? targetUnnamed(deps, options) : targetNamed(deps, fileKey, options);
}

/**
 * A call naming its session: the one plugin run holding it, asked for a grant on the session's
 * document and nowhere else.
 */
async function targetSession(
  deps: CallTargetDeps,
  session: SessionHandle,
  fileKey: FigmaFileKey | null,
  options: CallTargetOptions,
): Promise<CallTarget> {
  const { documents } = deps;
  const found = await findSessionHolder(deps, session, options);
  if (found.kind === "blocked") return found;
  const { holder } = found;
  await abortable(documents.settled([holder]), options.signal);
  // The plugin answers only for its proven document, but another server may be the one that proved
  // it: this server proves the plugin's claim itself before running there.
  if (documents.documentOf(holder).kind !== "proven" && options.reader)
    await abortable(documents.proveClaims([holder], options.reader), options.signal);
  const document = documents.documentOf(holder);
  if (document.kind !== "proven")
    return blocked({
      kind: "document-unprovable",
      fileKey,
      problem: !options.reader
        ? "this server has no Figma token to read the file with"
        : document.kind === "claimed" && document.problem
          ? document.problem.message
          : "the plugin holding the session didn't name a file this server could read",
    });
  if (fileKey !== null && fileKey !== document.fileKey)
    return blocked({
      kind: "session-document-mismatch",
      session,
      sessionFileName: document.fileName,
      fileKey,
    });
  const open = () => deps.links().includes(holder);
  return waitForGrant(deps, options, {
    ask: () => (open() ? [{ link: holder, fileKey: document.fileKey, prompt: "grant" }] : []),
    onRound: (answers) =>
      grantDecision(documents, answers) ??
      (open() ? null : blocked({ kind: "session-not-found", session })),
    expired: () => blocked({ kind: "grant-pending", fileName: document.fileName }),
  });
}

/**
 * The one open plugin run holding `session`. A miss is final only once every plugin still open has
 * had time to dial in, so a holder on its redial backoff after a server (re)start isn't reported
 * gone. Links are asked until they answer; one that never could makes the miss a failed lookup.
 */
async function findSessionHolder(
  deps: CallTargetDeps,
  session: SessionHandle,
  { signal, waitMs = GRANT_WAIT_MS, pollMs = GRANT_POLL_MS }: CallTargetOptions,
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
    onRound: (answers) =>
      grantDecision(documents, answers) ??
      (!answers.length && !holders().length
        ? blocked({ kind: "document-not-open", fileKey })
        : null),
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
  const { granted, complete } = await grantedOpenDocuments(
    deps.links(),
    { documentOf: (link) => documents.documentOf(link), grantStatus: deps.askGrant },
    options.signal,
  );
  // With a link whose file or grant is unknown, the one granted document may not be the only one.
  if (complete && granted.size === 1) return targeted(documents, [...granted.values()][0].link);

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
        // A claim that already failed isn't re-proven each round: each try reads the file over
        // REST, and a file this token can't read would spend the token's rate limit.
        if (
          document.kind === "claimed" &&
          document.problem === null &&
          options.reader &&
          !documents.isBusy(link)
        )
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

/**
 * One round of asking the panels of a document the call named for a grant: decided, or null to ask
 * again.
 */
function grantDecision(documents: LinkDocuments, answers: readonly Answer[]): CallTarget | null {
  const granted = answers.find((answer) => answer.state === "granted");
  if (granted) return targeted(documents, granted.link);
  const denied = answers.find((answer) => answer.state === "denied");
  if (denied)
    return blocked({ kind: "grant-denied", fileName: documentOf(documents, denied.link).fileName });
  if (answers.length && answers.every((answer) => answer.state === "absent"))
    return blocked({
      kind: "grant-unavailable",
      fileName: documentOf(documents, answers[0].link).fileName,
    });
  return null;
}

function targeted(documents: LinkDocuments, link: RelayConnection): CallTarget {
  return { kind: "targeted", link, document: documentOf(documents, link) };
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
