/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The verb table the docs and quick-start print (schema.ts VERBS) names exactly the verbs a sandbox
// author can call (runtime.ts's exports, `page.*` included). runtime.ts's `satisfies Flcm` ties the
// exports to the Flcm interface; VERBS is prose signatures, so only a runtime comparison can tie it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import * as runtime from "./runtime.js";
import { VERBS } from "./schema.js";

createFigmaMock();

test("VERBS documents exactly the runtime's flcm verbs", () => {
  const documented = VERBS.map((verb) => {
    const name = /flcm\.([\w.]+)\(/.exec(verb.signature)?.[1];
    assert.ok(name, `VERBS signature ${JSON.stringify(verb.signature)} names no flcm verb`);
    return name;
  });
  const exported = Object.entries(runtime).flatMap(([name, value]) =>
    typeof value === "function" ? [name] : Object.keys(value).map((member) => name + "." + member),
  );
  assert.deepEqual([...documented].sort(), [...exported].sort());
});
