/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { hmacSha256Hex } from "./hmac-sha256.js";

// The server verifies link proofs with Node's HMAC; any divergence locks every plugin out.
test("matches Node's HMAC-SHA256 across key and message lengths that straddle block boundaries", () => {
  for (const keyLength of [0, 1, 43, 64, 65, 128])
    for (const messageLength of [0, 1, 55, 56, 63, 64, 119, 200]) {
      const key = randomBytes(keyLength).toString("base64url").slice(0, keyLength);
      const message = randomBytes(messageLength).toString("base64url").slice(0, messageLength);
      assert.equal(
        hmacSha256Hex(key, message),
        createHmac("sha256", key).update(message).digest("hex"),
        `key ${keyLength}, message ${messageLength}`,
      );
    }
});

// A grant is keyed by a digest of the project path, which can be any text a filesystem allows.
test("matches Node's HMAC-SHA256 on non-ASCII text, astral characters and lone surrogates included", () => {
  for (const text of ["/Users/zoë/プロジェクト", "café 🎨 design", "lone \ud800 high", "lone \udc00 low", "end \ud83c"])
    assert.equal(hmacSha256Hex(text, text), createHmac("sha256", text).update(text).digest("hex"), JSON.stringify(text));
});
