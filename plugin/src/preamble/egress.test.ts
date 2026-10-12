/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectForEgress, registerRead, registerTokenEntry } from "./egress.js";
import { TOKEN_ENTRY_MARK } from "./token-mark.js";
import { warnings } from "./warnings.js";

function undefinedFieldsWarningOf(raw: unknown): string | null {
  const before = warnings.records.length;
  projectForEgress(raw, "result");
  return warnings.records.slice(before).find((record) => /undefined and dropped/.test(record.message))?.message ?? null;
}

test("an untouched read leaves projected; an edit anywhere inside it makes it the agent's, whole", () => {
  const nested = { id: "1:2", shape: { d: "M0 0 L8 0" } };
  registerRead(nested, () => ({ id: "1:2", elided: { d: 9 } }));
  assert.deepEqual(projectForEgress({ nested }, "result"), { nested: { id: "1:2", elided: { d: 9 } } });
  nested.shape.d = "M0 0 L1 1";
  assert.deepEqual(projectForEgress({ nested }, "result"), { nested: { id: "1:2", shape: { d: "M0 0 L1 1" } } });
});

test("undefined fields of the agent's own return are named by path; a read's own are not, unless the agent set them", () => {
  const read: Record<string, unknown> = { id: "1:2", name: "Card", fill: { scalingFactor: undefined } };
  registerRead(read, () => read);
  const raw = { cardId: "1:2", slotId: undefined, slot: { name: undefined }, items: [{ ref: undefined }, undefined], read, fill: read.fill };
  assert.equal(
    undefinedFieldsWarningOf(raw),
    "3 returned field(s) were undefined and dropped from the result: slotId, slot.name, items[0].ref.",
  );
  read.name = undefined;
  assert.equal(undefinedFieldsWarningOf({ read }), "1 returned field(s) were undefined and dropped from the result: read.name.");
  assert.equal(undefinedFieldsWarningOf({ a: 1, b: null }), null);
});

test("a token entry is marked on the result, edited or not, and never inside a console line", () => {
  const entry: Record<string, unknown> = { name: "color/brand" };
  registerTokenEntry(entry, "variable");
  assert.equal((projectForEgress(entry, "result") as Record<string, unknown>)[TOKEN_ENTRY_MARK], "variable");
  entry.uses = 3;
  assert.deepEqual(projectForEgress([entry], "console"), [{ name: "color/brand", uses: 3 }]);
});
