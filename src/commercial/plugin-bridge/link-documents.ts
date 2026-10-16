/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which file each authenticated link is in. The plugin can't say for itself (the Community build has
// no figma.fileKey, and a file's name proves nothing), so this server proves it: the link writes a
// fresh nonce into its file root's shared plugin data, and the server reads that file over REST.
// The nonce turning up in file F is the proof the link is in F.
import { documentProofNonces, type ProofOutcome, type ReplyFor } from "@framelink/plugin/protocol";
import type { FigmaService } from "~/services/figma.js";
import { figmaFileKey } from "~/utils/figma-url.js";
import { Logger } from "~/utils/logger.js";
import { mintLinkNonce } from "./link-credential.js";
import type { RelayConnection } from "./relay-connection.js";

/** A file's name and the proof nonces its root holds, as Figma's REST API reports them. */
export interface FileProofRead {
  name: string;
  proofs: readonly string[];
}

/** Read a file's proofs over REST. Rejects when the file can't be read with this token. */
export type DocumentReader = (fileKey: string, signal: AbortSignal) => Promise<FileProofRead>;

export function documentReaderFor(figma: FigmaService): DocumentReader {
  return async (fileKey, signal) => {
    const { name, sharedPluginData } = await figma
      .withSignal(signal)
      .getFileRootSharedPluginData(figmaFileKey(fileKey));
    return { name, proofs: documentProofNonces(sharedPluginData) };
  };
}

/**
 * How long a proof keeps reading the file for its nonces. A plugin's write reaches REST only after
 * Figma saves it, so the first read may miss it; past the deadline, a missing nonce is a refutation.
 */
export interface ProofTiming {
  pollMs: number;
  deadlineMs: number;
}

export const DEFAULT_PROOF_TIMING: ProofTiming = { pollMs: 1_000, deadlineMs: 15_000 };

type DocumentRequest =
  | { type: "INTRODUCE"; project: string; framelinkOrigin: string }
  | { type: "PROVE_DOCUMENT"; nonce: string }
  | { type: "PROOF_SETTLED"; nonce: string; outcome: ProofOutcome };

export interface LinkDocumentsOptions {
  send: <T extends DocumentRequest>(
    link: RelayConnection,
    payload: T,
  ) => Promise<ReplyFor<T["type"]>>;
  /** The process-wide reader, for proofs no call asked for. Null: proofs wait for a call's reader. */
  reader: DocumentReader | null;
  timing: ProofTiming;
  project: string;
  framelinkOrigin: string;
}

/** What a proof found out, beyond the links it settled: why it couldn't read the file, if it couldn't. */
export interface ProofReport {
  problem: string | null;
}

export class LinkDocuments {
  // Each link's introduction or proof still in flight. A call waits these out rather than guess.
  private readonly busy = new Map<RelayConnection, Promise<unknown>>();

  constructor(private readonly options: LinkDocumentsOptions) {}

  /**
   * Tell a just-authenticated link who this server is, and learn which file it claims to be in. A
   * claim is proven at once when this server can read files, so a call rarely waits on it.
   */
  introduce(link: RelayConnection): void {
    this.track([link], this.runIntroduction(link));
  }

  /**
   * The plugin claims a file: a link the human pasted, or the file another server just proved it
   * in. A claim, proven when a reader allows.
   */
  claimed(link: RelayConnection, fileKey: string, reader = this.options.reader): void {
    if (link.document.kind === "proven") return;
    link.document = { kind: "claimed", fileKey, problem: null };
    // After whatever is in flight on it, which would otherwise swallow this proof.
    if (reader)
      void this.settled([link]).then(() => {
        if (claims(link, fileKey)) return this.prove([link], fileKey, reader);
      });
  }

  /** Resolves once none of `links` is being introduced or proven. Never rejects. */
  async settled(links: readonly RelayConnection[]): Promise<void> {
    for (;;) {
      const pending = links.flatMap((link) => this.busy.get(link) ?? []);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  /** Whether a link is being introduced or proven now. */
  isBusy(link: RelayConnection): boolean {
    return this.busy.has(link);
  }

  /**
   * Prove which of `links` are in `fileKey`. A link already being proven is waited out, never
   * challenged twice. Never rejects; each link's `document` says where it landed.
   */
  async prove(
    links: readonly RelayConnection[],
    fileKey: string,
    reader: DocumentReader,
  ): Promise<ProofReport> {
    const waiting = links.flatMap((link) => this.busy.get(link) ?? []);
    const fresh = links.filter(
      (link) => link.isOpen && link.document.kind !== "proven" && !this.busy.has(link),
    );
    const proof = fresh.length
      ? this.track(fresh, this.runProof(fresh, fileKey, reader))
      : Promise.resolve({ problem: null });
    await Promise.allSettled(waiting);
    return proof;
  }

  private track<T>(links: readonly RelayConnection[], work: Promise<T>): Promise<T> {
    for (const link of links) this.busy.set(link, work);
    const release = () => {
      for (const link of links) if (this.busy.get(link) === work) this.busy.delete(link);
    };
    work.then(release, release);
    return work;
  }

  private async runIntroduction(link: RelayConnection): Promise<void> {
    const { project, framelinkOrigin, reader } = this.options;
    const reply = await this.options
      .send(link, { type: "INTRODUCE", project, framelinkOrigin })
      .catch(() => null);
    if (!reply || !link.isOpen) return;
    link.document = reply.claim
      ? { kind: "claimed", fileKey: reply.claim, problem: null }
      : { kind: "unclaimed" };
    // Proven here, not tracked again: this introduction is still the link's busy entry.
    if (reply.claim && reader) await this.runProof([link], reply.claim, reader);
  }

  private async runProof(
    links: readonly RelayConnection[],
    fileKey: string,
    reader: DocumentReader,
  ): Promise<ProofReport> {
    const nonces = new Map<RelayConnection, string>();
    await Promise.all(
      links.map(async (link) => {
        const nonce = mintLinkNonce();
        try {
          await this.options.send(link, { type: "PROVE_DOCUMENT", nonce });
          nonces.set(link, nonce);
        } catch (error) {
          // A view-only file can't be marked, so it can't be proven — and couldn't be edited anyway.
          if (claims(link, fileKey))
            link.document = { kind: "claimed", fileKey, problem: (error as Error).message };
        }
      }),
    );
    if (!nonces.size) return { problem: null };
    const read = await this.readUntilFound(fileKey, new Set(nonces.values()), reader);
    await Promise.all([...nonces].map(([link, nonce]) => this.settle(link, nonce, fileKey, read)));
    return { problem: read.problem };
  }

  /** Read the file until every nonce shows, the deadline passes, or the read fails. */
  private async readUntilFound(
    fileKey: string,
    nonces: ReadonlySet<string>,
    reader: DocumentReader,
  ): Promise<{ name: string | null; found: Set<string>; problem: string | null }> {
    const { pollMs, deadlineMs } = this.options.timing;
    const deadline = Date.now() + deadlineMs;
    const found = new Set<string>();
    let name: string | null = null;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(deadline - Date.now(), 0));
      try {
        const read = await reader(fileKey, controller.signal);
        name = read.name;
        for (const nonce of read.proofs) if (nonces.has(nonce)) found.add(nonce);
      } catch (error) {
        // A deadline cut short a slow read: what was found stands. Any other failure (no access,
        // no such file) won't mend by asking again.
        if (controller.signal.aborted) return { name, found, problem: null };
        Logger.log(
          `Couldn't read Figma file ${fileKey} to prove a plugin link: ${(error as Error).message}`,
        );
        return { name, found, problem: (error as Error).message };
      } finally {
        clearTimeout(timer);
      }
      if (found.size === nonces.size || Date.now() + pollMs >= deadline)
        return { name, found, problem: null };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  private async settle(
    link: RelayConnection,
    nonce: string,
    fileKey: string,
    { name, found, problem }: { name: string | null; found: Set<string>; problem: string | null },
  ): Promise<void> {
    let outcome: ProofOutcome;
    if (found.has(nonce) && name !== null) {
      outcome = { kind: "proven", fileKey, fileName: name };
      link.document = { kind: "proven", fileKey, fileName: name };
    } else if (problem !== null) {
      outcome = { kind: "abandoned" };
      if (claims(link, fileKey)) link.document = { kind: "claimed", fileKey, problem };
    } else if (claims(link, fileKey)) {
      // The file was read and the nonce isn't in it: the claim was wrong — a duplicate, most often.
      outcome = { kind: "refuted", fileKey };
      link.document = { kind: "unclaimed" };
    } else {
      outcome = { kind: "abandoned" };
    }
    if (!link.isOpen) return;
    await this.options.send(link, { type: "PROOF_SETTLED", nonce, outcome }).catch(() => {});
  }
}

function claims(link: RelayConnection, fileKey: string): boolean {
  return link.document.kind === "claimed" && link.document.fileKey === fileKey;
}
