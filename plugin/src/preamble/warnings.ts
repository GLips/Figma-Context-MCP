import { looksLikeNode } from "../serialize.js";
import type { WarningRecord } from "@framelink/core";
export type { WarningRecord } from "@framelink/core";

/** Each factory evaluation owns one registry; session state must never retain diagnostics. */
export function createWarningRegistry() {
  const records: WarningRecord[] = [];
  const pending = new Set<WarningRecord>();
  const emitted = new Set<WarningRecord>();
  const identities = new WeakMap<object, string>();
  const nodes = new Map<string, Set<Record<string, unknown>>>();
  function forNode(id: string): WarningRecord[] { return records.filter(record => record.id === id); }
  // Only registered read/handle projections enter here. An agent's own {id} is not an echo.
  function project(value: unknown, seen = new Map<object, unknown>()): unknown {
    if (!value || typeof value !== "object" || looksLikeNode(value)) return value;
    if (seen.has(value)) return seen.get(value);
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    seen.set(value, output);
    for (const [key, item] of Object.entries(value)) {
      if (key !== "warnings") (output as Record<string, unknown>)[key] = project(item, seen);
    }
    const id = identities.get(value) ?? (value as Record<string, unknown>).id;
    if (typeof id === "string") {
      const warnings = forNode(id);
      if (warnings.length) {
        (output as Record<string, unknown>).warnings = warnings;
        warnings.forEach(record => pending.add(record));
      }
    }
    return output;
  }
  return {
    records,
    commitEgress(): void { pending.forEach(record => emitted.add(record)); pending.clear(); },
    discardEgress(): void { pending.clear(); },
    add(record: WarningRecord): void {
      records.push(record);
      if (record.id !== null) for (const node of nodes.get(record.id) ?? []) node.warnings = forNode(record.id);
    },
    observe(value: object, id?: string): void {
      id ??= typeof (value as Record<string, unknown>).id === "string" ? (value as { id: string }).id : undefined;
      if (id !== undefined) {
        identities.set(value, id);
        let copies = nodes.get(id);
        if (!copies) nodes.set(id, copies = new Set());
        copies.add(value as Record<string, unknown>);
        const warnings = forNode(id);
        if (warnings.length) (value as Record<string, unknown>).warnings = warnings;
      }
    },
    discardFrom(index: number): void {
      for (const record of records.splice(index)) { emitted.delete(record); pending.delete(record); }
      for (const [id, copies] of nodes) for (const node of copies) {
        const warnings = forNode(id);
        if (warnings.length) node.warnings = warnings;
        else delete node.warnings;
      }
    },
    project,
    summary(): string[] {
      return records.filter(record => !emitted.has(record)).map(record =>
        "[warn] " + (record.id === null ? "" : record.id + " ") + record.message +
        (record.prop === undefined ? "" : " " + record.prop + ": authored " + JSON.stringify(record.authored) + ", realized " + JSON.stringify(record.realized) + "."));
    },
  };
}

export const warnings = createWarningRegistry();
