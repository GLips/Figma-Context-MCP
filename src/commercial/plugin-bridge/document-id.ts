/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { isDocumentId } from "@framelink/plugin/protocol";

declare const DOCUMENT_ID: unique symbol;

/**
 * A Figma file's stamp: the id the plugin wrote into the file root, which tells open files apart and
 * keys grants. Never a file name, never a connection, and never proof of edit access.
 */
export type DocumentId = string & { readonly [DOCUMENT_ID]: true };

/** An agent's or a command line's document id, or null when it isn't shaped like one. */
export function parseDocumentId(raw: string): DocumentId | null {
  return isDocumentId(raw) ? (raw as DocumentId) : null;
}
