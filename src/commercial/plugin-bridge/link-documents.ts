/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which file each authenticated link is in. The plugin can't say for itself (the Community build has
// no figma.fileKey, and a file's name proves nothing), so this server proves it: the link writes a
// fresh nonce into its file root's shared plugin data, and the server reads that file over REST.
// The nonce turning up in file F is the proof the link is in F.
import {
  documentProofNonces,
  type ProofOutcome,
  type ReplyFor,
  type ServerRequest,
} from "@framelink/plugin/protocol";
import type { FigmaService } from "~/services/figma.js";
import { figmaFileKey, type FigmaFileKey } from "~/utils/figma-url.js";
import { Logger } from "~/utils/logger.js";
import { mintLinkNonce } from "./link-credential.js";
import type { RelayConnection } from "./relay-connection.js";

/**
 * Which file an authenticated link is in, as far as this server knows. `claimed` is the plugin's
 * word, from an earlier proof or a pasted link (with why it couldn't be proven, if it couldn't);
 * only `proven` is this server's own finding, read back from the file over REST. A proof holds for
 * the plugin incarnation, which is the link's socket.
 */
export type LinkDocument =
  | { kind: "unknown" }
  | { kind: "unclaimed" }
  | { kind: "claimed"; fileKey: FigmaFileKey; problem: string | null }
  | { kind: "proven"; fileKey: FigmaFileKey; fileName: string };

/** A file's name and the proof nonces its root holds, as Figma's REST API reports them. */
export interface FileProofRead {
  name: string;
  proofs: readonly string[];
}

/** Read a file's proofs over REST. Rejects when the file can't be read with this token. */
export type DocumentReader = (fileKey: FigmaFileKey, signal: AbortSignal) => Promise<FileProofRead>;

export function documentReaderFor(figma: FigmaService): DocumentReader {
  return async (fileKey, signal) => {
    const { name, sharedPluginData } = await figma
      .withSignal(signal)
      .getFileRootSharedPluginData(fileKey);
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

type DocumentRequest = Extract<
  ServerRequest,
  { type: "INTRODUCE" | "PROVE_DOCUMENT" | "PROOF_SETTLED" }
>;

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

interface ProofRead {
  name: string | null;
  found: Set<string>;
  problem: string | null;
}

const UNKNOWN_DOCUMENT: LinkDocument = { kind: "unknown" };

export class LinkDocuments {
  // The only record of which file each link is in. Weak: a dropped link takes its entry with it.
  private readonly documents = new WeakMap<RelayConnection, LinkDocument>();
  // Each link's introduction or proof still in flight. A call waits these out rather than guess.
  private readonly busy = new Map<RelayConnection, Promise<unknown>>();

  constructor(private readonly options: LinkDocumentsOptions) {}

  /** Which file `link` is in, as far as this server knows. */
  documentOf(link: RelayConnection): LinkDocument {
    return this.documents.get(link) ?? UNKNOWN_DOCUMENT;
  }

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
  claimed(link: RelayConnection, fileKey: FigmaFileKey, reader = this.options.reader): void {
    if (this.documentOf(link).kind === "proven") return;
    this.documents.set(link, { kind: "claimed", fileKey, problem: null });
    // After whatever is in flight on it, which would otherwise swallow this proof.
    if (reader)
      void this.settled([link]).then(() => {
        if (this.claims(link, fileKey)) return this.prove([link], fileKey, reader);
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
   * challenged twice. Never rejects; `documentOf` says where each link landed.
   */
  async prove(
    links: readonly RelayConnection[],
    fileKey: FigmaFileKey,
    reader: DocumentReader,
  ): Promise<ProofReport> {
    const waiting = links.flatMap((link) => this.busy.get(link) ?? []);
    const fresh = links.filter(
      (link) => link.isOpen && this.documentOf(link).kind !== "proven" && !this.busy.has(link),
    );
    const proof = fresh.length
      ? this.track(fresh, this.runProof(fresh, fileKey, reader))
      : Promise.resolve({ problem: null });
    await Promise.allSettled(waiting);
    return proof;
  }

  /**
   * Prove every link that claims a file and isn't being proven already, each against its own claim.
   * Resolves once every such proof has settled.
   */
  async proveClaims(links: readonly RelayConnection[], reader: DocumentReader): Promise<void> {
    const byClaim = new Map<FigmaFileKey, RelayConnection[]>();
    for (const link of links) {
      const document = this.documentOf(link);
      if (document.kind !== "claimed" || this.busy.has(link)) continue;
      byClaim.set(document.fileKey, [...(byClaim.get(document.fileKey) ?? []), link]);
    }
    await Promise.all(
      [...byClaim].map(([fileKey, claiming]) => this.prove(claiming, fileKey, reader)),
    );
  }

  private claims(link: RelayConnection, fileKey: FigmaFileKey): boolean {
    const document = this.documentOf(link);
    return document.kind === "claimed" && document.fileKey === fileKey;
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
    // The plugin's word, already admitted as a wire file key by the protocol's parser.
    const claim = reply.claim === null ? null : figmaFileKey(reply.claim);
    this.documents.set(
      link,
      claim ? { kind: "claimed", fileKey: claim, problem: null } : { kind: "unclaimed" },
    );
    // Proven here, not tracked again: this introduction is still the link's busy entry.
    if (claim && reader) await this.runProof([link], claim, reader);
  }

  private async runProof(
    links: readonly RelayConnection[],
    fileKey: FigmaFileKey,
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
          if (this.claims(link, fileKey))
            this.documents.set(link, {
              kind: "claimed",
              fileKey,
              problem: (error as Error).message,
            });
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
    fileKey: FigmaFileKey,
    nonces: ReadonlySet<string>,
    reader: DocumentReader,
  ): Promise<ProofRead> {
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
        // A deadline cut short a slow read: what an earlier read found stands. With no read ever
        // finished, nothing was looked at, so nothing is refuted. Any other failure (no access, no
        // such file) won't mend by asking again.
        if (controller.signal.aborted)
          return {
            name,
            found,
            problem: name === null ? `timed out reading Figma file ${fileKey}` : null,
          };
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
    fileKey: FigmaFileKey,
    { name, found, problem }: ProofRead,
  ): Promise<void> {
    let outcome: ProofOutcome;
    if (found.has(nonce) && name !== null) {
      outcome = { kind: "proven", fileKey, fileName: name };
      this.documents.set(link, { kind: "proven", fileKey, fileName: name });
    } else if (problem !== null) {
      outcome = { kind: "abandoned" };
      if (this.claims(link, fileKey))
        this.documents.set(link, { kind: "claimed", fileKey, problem });
    } else if (this.claims(link, fileKey)) {
      // The file was read and the nonce isn't in it: the claim was wrong — a duplicate, most often.
      outcome = { kind: "refuted", fileKey };
      this.documents.set(link, { kind: "unclaimed" });
    } else {
      outcome = { kind: "abandoned" };
    }
    if (!link.isOpen) return;
    await this.options.send(link, { type: "PROOF_SETTLED", nonce, outcome }).catch(() => {});
  }
}
