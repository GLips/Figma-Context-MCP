/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Mid-run server calls: the plugin→server reverse-request direction. The preamble suspends on an
// await while the server works; this table correlates the plugin-ISSUED requests with the server's
// responses. Deliberately a separate id namespace ("preq-") and a separate table from the server's
// own requests: each side owns its ids, and reverse replies are matched by TYPE (CHANNEL_RESPONSE)
// before the envelope dispatch, so neither end ever has to guess who minted an id.
import { toServer, type ReplyTo } from "./outbound.js";
import type { ConnKey } from "./panel.js";
import type { FlcmErrorKind, ServerFrame } from "./protocol.js";

export interface PendingServerCall {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  executionId: string;
  connKey: ConnKey;
}

export function createServerCallTable(isConnected: (key: ConnKey) => boolean) {
  let nextChannelRequestId = 0;
  const pending = new Map<string, PendingServerCall>();

  return {
    /**
     * Call a capability on the run's server and await its opaque response. Tagged with the run's
     * execution id so the server can (a) suspend the run's inactivity deadline while IT is the side
     * doing the work, and (b) refuse a request for a run it no longer tracks — that refusal rejects
     * this promise, which is what makes a zombie run die at its suspension point instead of resuming
     * into canvas writes.
     *
     * ORDERING RULE a capability must hold to: the sandbox gathers its evidence, the server computes,
     * and any follow-up `figma.*` work happens AFTER the reply. A server handler must not await a
     * fresh plugin request: it queues behind the execution suspended on this call, and both wait
     * forever (the same non-reentrancy preamble/mutation-lock.ts documents for verbs).
     */
    call(to: ReplyTo, capability: string, payload: unknown): Promise<unknown> {
      // Fail closed at issue time: with no live socket for this run's connection, the relay would
      // silently drop the frame and this promise could never settle — wedging the write chain for the
      // life of the plugin. A close rejects the calls already pending; this covers the run that
      // reaches its call only AFTER the drop.
      if (!isConnected(to.connKey)) {
        return Promise.reject(
          runEnded("the server for this run is no longer connected, so the request to it can't be sent and the script stops here."),
        );
      }
      return new Promise((resolve, reject) => {
        const id = "preq-" + ++nextChannelRequestId;
        pending.set(id, { resolve, reject, executionId: to.id, connKey: to.connKey });
        toServer(to.connKey, { type: "CHANNEL_REQUEST", id, executionId: to.id, capability, payload });
      });
    },

    /**
     * Settle a call from the server's response. An unknown id is dropped — that call was already
     * rejected by a CANCEL, a disconnect or a revoke. The reply must arrive on the SAME connection the
     * request went out on: the relay holds a socket per block port, so without this check any other
     * local server (grants gate writes, not this direction) could answer another server's call.
     */
    settle(msg: Extract<ServerFrame, { type: "CHANNEL_RESPONSE" }>, connKey: ConnKey): void {
      const call = pending.get(msg.id);
      if (!call || call.connKey !== connKey) return;
      pending.delete(msg.id);
      if (msg.ok) {
        call.resolve(msg.payload);
        return;
      }
      // A failure crosses opaquely, the same way a success does. The installed plugin is the ONE piece
      // that can't be updated in step with a new capability, so it must not flatten the server's error
      // to prose: a future capability ships a structured failure and a preamble that reads `.detail`.
      call.reject(
        serverCallFailure(
          typeof msg.error === "string"
            ? msg.error
            // eslint-disable-next-line no-restricted-syntax -- a wire field, not an error's text
            : msg.error && typeof msg.error === "object" && "message" in msg.error && typeof msg.error.message === "string"
              // eslint-disable-next-line no-restricted-syntax -- a wire field, not an error's text
              ? msg.error.message
              : "the server couldn't complete the request.",
          msg.error,
        ),
      );
    },

    /**
     * Reject matching calls. A rejected call kills its suspended run at the await — the mechanism
     * behind CANCEL, a closed socket and a revoke, and what keeps the write queue from wedging on a
     * call whose reply can never arrive.
     */
    reject(match: (call: PendingServerCall) => boolean, reason: string): void {
      for (const [id, call] of pending) {
        if (!match(call)) continue;
        pending.delete(id);
        call.reject(runEnded(reason));
      }
    },
  };
}

/**
 * How every call rejects: an Error whose `detail` is wire-shaped data. The preamble judges it by
 * `detail.kind` alone (host.ts serverCall), never by class: it is a separate bundle with its own
 * FlcmError, so a host-made one would fail its instanceof and be blamed on flcm. `message` stays a
 * string only because throwing a non-Error in the sandbox loses the stack.
 */
function serverCallFailure(message: string, detail: unknown): Error {
  // eslint-disable-next-line no-restricted-syntax -- a failure the preamble reads by its detail
  return Object.assign(new Error(message), { detail });
}

/** The plugin's own refusal of a call: the run it belongs to has ended, in the server's error shape. */
function runEnded(message: string): Error {
  const kind: FlcmErrorKind = "run-ended";
  return serverCallFailure(message, { kind, message });
}
