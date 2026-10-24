/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// write-point — the moment an operation would write. The obligations its fields serve are observed
// then, after every earlier write in the call, and a field is written only while one of them is
// unrealized. That is the guarantee inside an instance, where Figma throws even on a same-value x
// or layoutPositioning, and on a pasted read, where a rewrite pins overrides or flattens text runs.
//
// A field no obligation carries is an injected default some authored word needs to execute, so it
// is always written. Nothing here is decided from a snapshot: the finalizer still checks every
// obligation once the call has landed.

import { liveSublayerId } from "@framelink/core";
import {
  markObligationsWritten, obligationsInCall, patchFieldKey, resolveObligationTarget,
  type Obligation, type ObligationTarget, type PatchFieldKey,
} from "./obligation.js";
import { observeObligation } from "./obligation-observers.js";

/** What one write point writes, and the obligations it writes them for. */
export interface WritePointDecision {
  readonly writes: ReadonlySet<PatchFieldKey>;
  /** Call once the writes have landed: the pending obligations are then written by this call. */
  landed(): void;
}

// Whether `target` names `node`, without walking an instance's tree for a sublayer.
function namesNode(target: ObligationTarget, node: SceneNode): boolean {
  if ("node" in target) return target.node === node;
  const instance = resolveObligationTarget(target.instance);
  return !!instance && liveSublayerId(instance.id, target.path) === node.id;
}

/** Every obligation the call holds against `node` now, or every one of `among` that names it. */
export function obligationsOnNode(node: SceneNode, among: readonly Obligation[] = obligationsInCall()): Obligation[] {
  return among.filter((obligation) => namesNode(obligation.target, node));
}

/**
 * Fields one write states as a whole: once any of `when` is written, so is each of `write` present
 * (a text's runs over its base style; a container's words under the mode it changes to).
 */
export interface WrittenTogether { readonly when: readonly PatchFieldKey[]; readonly write: readonly PatchFieldKey[] }

/** Decide which of `fields` a write on `node` lands now. */
export function realizeAtWritePoint(node: SceneNode, fields: Iterable<PatchFieldKey>, together: readonly WrittenTogether[] = []): WritePointDecision {
  const asked = new Set(fields);
  const carried = new Set<PatchFieldKey>();
  const writes = new Set<PatchFieldKey>();
  const pending: Obligation[] = [];
  for (const obligation of obligationsOnNode(node)) {
    const keys = obligation.carries.map(patchFieldKey).filter((key) => asked.has(key));
    if (!keys.length) continue;
    for (const key of keys) carried.add(key);
    if (observeObligation(obligation).realized) {
      obligation.heldAtWritePoint = true;
      continue;
    }
    pending.push(obligation);
    for (const key of keys) writes.add(key);
  }
  for (const key of asked) if (!carried.has(key)) writes.add(key);
  for (const group of together) {
    if (group.when.some((key) => writes.has(key))) for (const key of group.write) if (asked.has(key)) writes.add(key);
  }
  return { writes, landed: () => markObligationsWritten(pending) };
}
