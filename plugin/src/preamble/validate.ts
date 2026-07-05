// validate — boundary validation shared across the preamble's agent-input surfaces. Pure (no figma.*), so
// it bundles into the QuickJS sandbox freely. Today it holds the one closed-set unknown-key gate that both
// the authoring constructors (flcm.ts) and the locate query (read.ts) fail loud with — and the future
// `edit` verb will reuse for its up-front spec validation.

// Fail loud on any own key of `obj` outside `allowed`, naming the offender(s) and the allowed set. ONE gate
// for every agent-input boundary in the preamble: the authoring constructors validate a `prop`, the locate
// verbs a `query key` — same closed-set scan, each boundary keeping its own vocabulary via `noun`. `subject`
// locates the object in the message ("flcm.frame", "flcm.text.textStyle", "flcm.find"). The known set is
// passed pre-built (callers hold it at module scope) so the reject adds no per-call allocation.
export function rejectUnknownKeys(obj: object, allowed: ReadonlySet<string>, subject: string, noun = "prop"): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    const label = noun + (unknown.length > 1 ? "s" : "");
    throw new Error(
      `flcm: unknown ${label} ${unknown.map((k) => JSON.stringify(k)).join(", ")} on ${subject} — ` +
        `${subject} takes only ${[...allowed].map((k) => JSON.stringify(k)).join(", ")}.`,
    );
  }
}
