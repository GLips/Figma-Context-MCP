/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Read egress: what a value the agent returns or logs looks like once it leaves the run. A read handed
// out by flcm is complete in the sandbox (so it pastes back), and only its egress copy is projected
// down to the compact wire shape — but only while it is still flcm's. An agent that edited a read,
// anywhere inside it, made it its own data, and its own data leaves whole.
//
// The policy ships with the preamble, so it changes with no plugin release; the host only calls
// projectForEgress on the way out and serializes what comes back (run-executor.ts executeCode). State is
// module-level on purpose: a factory evaluation is one run, so registrations die with the run.
import { isPlainData } from "./plain-data.js";
import { warnings } from "./warnings.js";
import { refuseIfRunFinished } from "./host.js";
import { FlcmError } from "./flcm-error.js";
import { TOKEN_ENTRY_MARK, type TokenEntryKind } from "./token-mark.js";

/** Where an egress copy is going. Only the result is read by the server's renderer, so only it is marked. */
export type EgressChannel = "result" | "console";

interface Registration {
  project: () => unknown;
  tokenKind?: TokenEntryKind;
}

const registrations = new WeakMap<object, Registration>();
// Every object reachable from a registration, with its data fields as they were then. Shared across
// registrations, so a read nested in another is captured once (linear in what was handed out). An
// object in here is flcm's shape, never the agent's.
const capturedFields = new WeakMap<object, [string, unknown][]>();

/** Runtime diagnostics arrive after a read is minted; they never make it the agent's data. */
function dataEntries(value: object): [string, unknown][] {
  return Object.entries(value).filter(([key]) => key !== "warnings");
}

function capture(value: unknown): void {
  if (!isPlainData(value) || capturedFields.has(value)) return;
  captureFrom(value);
}

// A registered root is re-captured even if seen before: registering hands it out again, as it is now.
function captureFrom(value: object): void {
  const entries = dataEntries(value);
  capturedFields.set(value, entries);
  for (const [, child] of entries) capture(child);
}

/** Whether `value` and everything under it still holds exactly what it held when handed out. */
function unchangedSinceRead(value: object): boolean {
  const seen = new Set<object>();
  const unchanged = (current: unknown): boolean => {
    if (!isPlainData(current) || seen.has(current)) return true;
    seen.add(current);
    const before = capturedFields.get(current);
    const after = dataEntries(current);
    return (
      !!before &&
      before.length === after.length &&
      before.every(([key, original], i) => key === after[i][0] && Object.is(original, after[i][1]) && unchanged(original))
    );
  };
  return unchanged(value);
}

/**
 * Hand out a read: `project` builds its wire copy at egress, if the agent leaves it untouched. A
 * runtime whose run already replied refuses: nothing will carry the read out, and a stored flcm
 * reading on must fail loud rather than look like it works.
 */
export function registerRead(value: object, project: () => unknown, nodeId?: string): void {
  refuseIfRunFinished();
  warnings.observe(value, nodeId);
  registrations.set(value, { project });
  captureFrom(value);
}

/** A designTokens entry: leaves the run as itself, edited or not, marked with its kind on the result. */
export function registerTokenEntry(value: object, tokenKind: TokenEntryKind): void {
  registrations.set(value, { project: () => value, tokenKind });
  captureFrom(value);
}

/** Register each returned node so extracting a child keeps its diagnostics at egress. */
export function registerResult(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("id" in value && typeof value.id === "string") registerRead(value, () => value);
  for (const [key, item] of Object.entries(value)) if (key !== "warnings") registerResult(item);
}

const UNDEFINED_FIELDS_NAMED = 10;

function undefinedFieldsWarning(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const named = paths.slice(0, UNDEFINED_FIELDS_NAMED).join(", ");
  const more = paths.length > UNDEFINED_FIELDS_NAMED ? ` and ${paths.length - UNDEFINED_FIELDS_NAMED} more` : "";
  return `${paths.length} returned field(s) were undefined and dropped from the result: ${named}${more}.`;
}

/**
 * The egress copy of a returned (`result`) or logged (`console`, the whole argument list) value, with
 * the warnings it carries committed as delivered. Only plain data is copied: any other object (a live
 * node, a style, a Map) passes through by reference, for the host to identify and serialize.
 *
 * A returned field the agent left undefined is named in one warning: JSON drops it, so the agent would
 * see `{ a }` with no sign `b` was returned. Only the agent's own fields count — a read's undefined
 * fields are flcm's shape — and undefined array items are out of scope, since JSON makes them null.
 */
export function projectForEgress(value: unknown, channel: EgressChannel): unknown {
  const dropped: string[] = [];
  try {
    const copy = walk(value, new Set(), channel, channel === "result" ? { at: "", paths: dropped } : undefined);
    warnings.commitEgress();
    const undefinedFields = undefinedFieldsWarning(dropped);
    if (undefinedFields) warnings.add({ id: null, message: undefinedFields });
    return copy;
  } finally {
    warnings.discardEgress();
  }
}

interface DroppedFields {
  at: string;
  paths: string[];
}

function walk(value: unknown, ancestors: Set<object>, channel: EgressChannel, dropped: DroppedFields | undefined): unknown {
  if (!isPlainData(value)) return value;
  if (ancestors.has(value)) {
    throw new FlcmError(
      "authoring",
      "a value your code " + (channel === "result" ? "returned" : "logged") + " contains itself (a cycle), so it can't be sent back. " +
        "Break the cycle, such as by sending just the ids you need.",
    );
  }
  ancestors.add(value);
  const pathOf = (key: string | number): string =>
    typeof key === "number" ? `${dropped!.at}[${key}]` : dropped!.at ? `${dropped!.at}.${key}` : key;
  try {
    const registration = registrations.get(value);
    if (registration) {
      let copy: unknown;
      if (unchangedSinceRead(value)) copy = warnings.project(registration.project());
      else {
        // Only the keys the agent set on the read are its own; nested data under them is not walked.
        const before = new Map(capturedFields.get(value));
        if (dropped)
          for (const [key, item] of dataEntries(value))
            if (item === undefined && (!before.has(key) || before.get(key) !== undefined)) dropped.paths.push(pathOf(key));
        copy = warnings.project(value);
      }
      return registration.tokenKind && channel === "result"
        ? { ...(copy as object), [TOKEN_ENTRY_MARK]: registration.tokenKind }
        : copy;
    }
    const own = dropped && !capturedFields.has(value) ? dropped : undefined;
    if (Array.isArray(value)) return value.map((item, i) => walk(item, ancestors, channel, own && { at: pathOf(i), paths: own.paths }));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (own && item === undefined) own.paths.push(pathOf(key));
        return [key, walk(item, ancestors, channel, own && { at: pathOf(key), paths: own.paths })];
      }),
    );
  } finally {
    ancestors.delete(value);
  }
}
