// Every authoring verb shares this boundary; pure value guards stay independent of the compiler.
import { readyLayout } from "./compile-tree.js";
import { KNOWN_KEYS } from "./flcm.js";
import { hasContainerLayout } from "./ir.js";
import { normalizeInputAliases } from "./input-aliases.js";
import { rejectUnknownKeys, READ_ONLY_WORDS } from "./validate.js";

export interface AuthoringEntry {
  /** The node kind the bag is authored FOR: a compiler's own type, or the live target's under edit. */
  type: string;
  verb: "create" | "edit";
  /** The entry's closed vocabulary — everything left after the identity words is judged by it. */
  known: ReadonlySet<string>;
  subject: string;
}

/**
 * The prelude every props-taking entry runs: fold the read shape's read-only words, then the closed-set
 * gate. Returns the bag with them gone. A non-object goes straight to the gate's own backstop.
 */
export function acceptAuthoringProps(bag: unknown, entry: AuthoringEntry): Record<string, unknown> {
  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) rejectUnknownKeys(bag, entry.known, entry.subject);
  const src = normalizeInputAliases(bag as Record<string, unknown>, entry.subject, entry.type);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const value = src[key];
    if (key === "designedWidth" || key === "designedHeight" || key === "warnings") continue;
    // An explicitly-undefined read-only word is absence, not a claim (`{ ...node, children: undefined }`).
    if (value == null && READ_ONLY_WORDS.has(key)) continue;
    if (key === "type") {
      if (value !== entry.type) {
        throw new Error(
          entry.subject + ": the node is a " + String(value) + ", not a " + entry.type + ". " +
            (entry.verb === "create" ? "Use the node's own type." : "Edit the node it was read from, or pass only the fields to change."),
        );
      }
      continue;
    }
    if (key === "children") {
      throw new Error(entry.subject + ": children belong in a placement spec or an instance slot override. Use append to change a tree and remove to delete nodes.");
    }
    out[key] = value;
  }
  for (const [axis, designed] of [["width", "designedWidth"], ["height", "designedHeight"]] as const) {
    if (out[axis] !== "contextual") continue;
    if (src[designed] == null) delete out[axis];
    else out[axis] = src[designed];
  }
  if (out.layout != null) {
    const layout = readyLayout(out.layout, entry.subject);
    const keys = hasContainerLayout(entry.type) ? KNOWN_KEYS.layout : KNOWN_KEYS.childLayout;
    rejectUnknownKeys(layout, new Set(keys), entry.subject + ".layout");
    out.layout = layout;
  }
  rejectUnknownKeys(out, entry.known, entry.subject);
  return out;
}
