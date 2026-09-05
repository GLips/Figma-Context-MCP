// validate — boundary validation shared across the preamble's agent-input surfaces. Pure (no
// figma.*), so it bundles into the QuickJS sandbox freely: one gate asserting an agent-supplied
// bag is a plain object whose every key is known, shared by the authoring constructors (flcm.ts),
// the locate queries (read.ts), and edit's delta.

const listKeys = (allowed: ReadonlySet<string>): string => [...allowed].map((k) => JSON.stringify(k)).join(", ");

// The reject must never crash while describing bad input — JSON.stringify itself throws on BigInt
// and cycles, and returns undefined for undefined/functions/symbols.
const showValue = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return "a " + typeof v;
  }
};

// Fail loud when `obj` isn't a plain object, or on any own key outside `allowed`, naming the
// offender(s) and the allowed set. ONE gate for every agent-input boundary in the preamble: the
// authoring constructors validate a `prop`, the locate verbs a `query key` — same scan, each
// boundary keeping its own vocabulary via `noun` and locating itself via `subject` ("flcm.frame",
// "flcm.text.textStyle", "flcm.find"). The non-object branch is the BACKSTOP: a call site with a
// richer shape to show (pad's number form, absolute's "none", find's did-you-mean) pre-empts it
// with its own tailored guard — keep those, don't fold them in here. The known set is passed
// pre-built (callers hold it at module scope) and the message lists are built only in the throw
// paths, so the happy path adds no per-call allocation.
export function rejectUnknownKeys(obj: unknown, allowed: ReadonlySet<string>, subject: string, noun = "prop"): void {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    // Object.keys on a string enumerates its character indices — without this branch a string
    // here rejects as unknown keys "0", "1", "2"…: every word true, none naming the actual
    // object-vs-value mistake.
    throw new Error(
      `flcm: ${subject} takes an object (${noun}s: ${listKeys(allowed)}) — got ${showValue(obj)}.`,
    );
  }
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    const label = noun + (unknown.length > 1 ? "s" : "");
    throw new Error(
      `flcm: unknown ${label} ${unknown.map((k) => JSON.stringify(k)).join(", ")} on ${subject} — ` +
        `${subject} takes only ${listKeys(allowed)}.`,
    );
  }
}
