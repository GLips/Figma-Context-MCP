// Constructor provenance — the ONE home for "did an flcm constructor build this node". The
// compiled IR is NOT an authoring surface: a hand-built POJO can state cross-field combinations
// the constructors' compile can never produce (a percentSize without its "fixed" sizing twin, an
// anchor without its coordinate, a dimension without its sizing), and every one lands as a
// silent partial write — so render refuses any node the constructors didn't mint. Identity is a
// module-private WeakSet, deliberately NOT a property stamp: a stamp is discoverable
// (getOwnPropertyNames) and forgeable, and rides prototype chains (Object.create), while WeakSet
// membership is unfakeable object identity. Constructors also deep-freeze what they mint
// (flcm.ts sealWriteNode), so membership proves the node still IS what the compile validated,
// not merely that it once was.
import { WriteNode } from "./ir.js";

const constructorBuiltNodes = new WeakSet<object>();

export function markConstructorBuilt(wn: object): void {
  constructorBuiltNodes.add(wn);
}

export function isConstructorBuilt(wn: object): boolean {
  return constructorBuiltNodes.has(wn);
}

// Authenticate a whole render tree, children down. Runs in render's PREPARE so a hand-built
// child rejects with this message before any image/font round-trip to the host — and because
// sealed trees are frozen, the tree apply later walks is exactly the one authenticated here.
export function assertConstructorBuiltTree(wn: WriteNode): void {
  if (!isConstructorBuilt(wn)) {
    throw new Error(
      'flcm: nodes come from the flcm constructors — flcm.frame/text/rect/ellipse/line/svg/path — got a hand-built "' +
        wn.type + '" object. (A copy of a constructor node also lands here — a spread or clone is a different object; re-call the constructor instead.)',
    );
  }
  for (const child of wn.children || []) {
    if (child) assertConstructorBuiltTree(child);
  }
}

// ---- The read side's own provenance. Same WeakSet trick, opposite purpose: not "may this be
// built" but "this must never be MISTAKEN for something to build". ----

const readSpecs = new WeakSet<object>();

// Brand what `get` hands back. A read spec and a handle both carry a live string `id` — deliberate,
// one vocabulary at the agent boundary — so a structural verb asked to place one cannot tell them
// apart by shape, and guessing wrong MOVES the node the agent meant to copy. Object identity can
// tell them apart, so it does.
export function markReadSpec(spec: object): void {
  readSpecs.add(spec);
}

export function isReadSpec(value: object): boolean {
  return readSpecs.has(value);
}
