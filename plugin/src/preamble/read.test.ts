// Target resolution: one node from a key, its bare id, flcm.id(...), or a handle — and FAIL LOUD (naming the
// key/count) on not-found or ambiguous, so a blind agent never silently acts on the wrong node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, render, id } from "./flcm.js";
import { resolveTarget } from "./read.js";

test("resolves the SAME node from its key, bare id, flcm.id(), and a handle", async () => {
  createFigmaMock();
  const out = await render(frame({ key: "root" }, [rect({ key: "card", width: 40, height: 40 })]));
  const cardId = out.keyed.card.id;

  assert.equal(resolveTarget("card").id, cardId);          // by flcm/key
  assert.equal(resolveTarget(cardId).id, cardId);          // by bare id
  assert.equal(resolveTarget(id(cardId)).id, cardId);      // by explicit flcm.id(...)
  assert.equal(resolveTarget(out.keyed.card).id, cardId);  // by handle
});

test("a not-found target throws, naming the target", async () => {
  createFigmaMock();
  await render(frame({ key: "root" }, [rect({ key: "card" })]));
  assert.throws(() => resolveTarget("ghost"), /no node found.*ghost/s);
});

test("flcm.id() to a deleted/absent node fails loud", () => {
  createFigmaMock();
  assert.throws(() => resolveTarget(id("99:99")), /no live node with id.*99:99/s);
});

test("a duplicated key throws, naming the key and the count", async () => {
  createFigmaMock();
  await render(frame({ key: "a" }, [rect({ key: "dup" })]));
  await render(frame({ key: "b" }, [rect({ key: "dup" })]));
  assert.throws(() => resolveTarget("dup"), /ambiguous.*2 nodes.*dup/s);
});

test("a string matching BOTH a live id and an flcm/key fails loud — flcm.id() forces the id lane", async () => {
  createFigmaMock();
  const out = await render(frame({ key: "root" }, [rect({ key: "card", width: 10, height: 10 })]));
  const cardId = out.keyed.card.id;
  await render(frame({ key: cardId })); // a second node whose flcm/key collides with card's id

  assert.throws(() => resolveTarget(cardId), /ambiguous.*BOTH a live node id/s);
  assert.equal(resolveTarget(id(cardId)).id, cardId);
});

test("`within` scopes the key scan to a subtree, disambiguating a page-wide clash", async () => {
  createFigmaMock();
  const a = await render(frame({ key: "a" }, [rect({ key: "target", width: 10, height: 10 })]));
  const b = await render(frame({ key: "b" }, [rect({ key: "target", width: 10, height: 10 })]));

  assert.throws(() => resolveTarget("target"), /ambiguous/); // two on the page
  assert.equal(resolveTarget("target", "a").id, a.keyed.target.id);
  assert.equal(resolveTarget("target", "b").id, b.keyed.target.id);
});
