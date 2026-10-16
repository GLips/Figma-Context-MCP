/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { PROTOCOL_VERSION, type PluginOwner } from "@framelink/plugin/protocol";
import { LinkCredentialStore, linkProof } from "~/commercial/plugin-bridge/link-credential.js";
import { TEST_PLUGIN_OWNER } from "./write-access.js";

/**
 * Answer the link-setup envelope the way a plugin paired with the current state dir would (or, with
 * `paired: false`, one never paired), for tests that drive a real socket. The introduction claims no
 * file. Returns whether `frame` was a setup frame it answered.
 */
export function answerLinkSetup(
  send: (frame: Record<string, unknown>) => void,
  frame: Record<string, unknown>,
  {
    credentials = new LinkCredentialStore(),
    owner = TEST_PLUGIN_OWNER,
    paired = true,
  }: { credentials?: LinkCredentialStore; owner?: PluginOwner | null; paired?: boolean } = {},
): boolean {
  if (frame.type === "HELLO") {
    send({ type: "HELLO_RESULT", id: frame.id, protocolVersion: PROTOCOL_VERSION });
    return true;
  }
  if (frame.type === "AUTHENTICATE" && !paired) {
    send({ type: "LINK_UNPAIRED", id: frame.id });
    return true;
  }
  if (frame.type === "AUTHENTICATE") {
    const credential = credentials.readOrCreate();
    send({
      type: "LINK_PROOF",
      id: frame.id,
      proof: linkProof(credential, String(frame.nonce)),
      owner,
    });
    return true;
  }
  if (frame.type === "INTRODUCE") {
    send({ type: "INTRODUCED", id: frame.id, claim: null });
    return true;
  }
  return false;
}
