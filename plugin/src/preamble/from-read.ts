// from-read — `flcm.fromRead(spec)`: the SimplifiedNode a `get` returns, re-authored as constructor
// CALLS. The constructors already speak the read shape's spellings (read-spellings.ts), so all that is
// left for a whole SUBTREE is what a single constructor can't do: pick the constructor by the spec's
// `type`, and recurse into `children`, which arrive as read specs rather than built nodes.
//
// It emits calls, never IR. ADR-0012 makes the constructors the only authoring dialect — render refuses
// any WriteNode they didn't mint — so there is no raw-IR shortcut to take even if it were tempting.
//
// It is a VERB, not a dispatch rule. A `get` result carries a live `id` exactly as a handle does, so
// letting a structural verb rebuild implicitly would mean guessing "copy this" from "move this" —
// the ambiguity that already produced a silent destructive bug. `fromRead` output is constructor-built,
// so `append(other, flcm.fromRead(spec))` classifies as a spec on provenance alone, and a RAW spec keeps
// being refused (structure.ts) with a pointer here.

import type { WriteNode, WriteChild } from "./ir.js";
import { frame, text, rect, ellipse, line } from "./flcm.js";
import type { SimplifiedNode } from "@framelink/core";
import { CLONE_REMEDY, own } from "./read-spellings.js";

// The read types that have an flcm constructor. Read renames VECTOR → IMAGE-SVG and collapses SVG-heavy
// containers into it, so no read type maps to flcm.svg/flcm.path: neither markup nor path data survives
// the read (see UNAUTHORABLE_TYPES).
type AuthorableReadType = "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE";

// Why each non-createable read type has no spec rebuild. Types outside both tables get the generic
// message — the set of node types Figma can produce is open, and a new one is not a fromRead bug.
const UNAUTHORABLE_TYPES: Record<string, string> = {
  "IMAGE-SVG": "the read shape flattens a VECTOR (and SVG-heavy containers) into IMAGE-SVG, which carries no path data or markup to rebuild from",
  GROUP: "a GROUP is a selection wrapper with no flcm constructor — its children carry the layout, so there is nothing to author",
  INSTANCE: "an INSTANCE is bound to its main component, and a rebuild from props would produce a detached lookalike that stops tracking the component",
  COMPONENT: "a COMPONENT is a definition other nodes instantiate — rebuilding its props would produce a plain frame, not a component",
  COMPONENT_SET: "a COMPONENT_SET is a variant container — rebuilding its props would produce a plain frame, not a component set",
};

type Builder = (spec: SimplifiedNode, subject: string) => WriteNode;

const BUILDERS: Record<AuthorableReadType, Builder> = {
  FRAME: (spec, subject) => {
    // Children are rebuilt FIRST, each under its own path, so a refusal deep in the subtree names the
    // node it came from rather than the root.
    const { children, ...props } = spec;
    if (children != null && !Array.isArray(children)) {
      throw new Error(subject + ".children: expected the read shape's array of child specs — got " + JSON.stringify(children) + ".");
    }
    const built = (children ?? []).map((child, i) => buildFromRead(child, childSubject(subject, i, child)));
    return frame(props, built as WriteChild[]);
  },
  TEXT: (spec) => text(spec),
  RECTANGLE: (spec) => rect(spec),
  ELLIPSE: (spec) => ellipse(spec),
  LINE: (spec) => line(spec),
};

/**
 * flcm.fromRead — re-author a `get` result as a constructor-built spec, ready for render/append.
 * The spec is agent input at a system boundary, so every shape assumption is checked here.
 */
export function fromRead(spec: unknown): WriteNode {
  return buildFromRead(spec, "flcm.fromRead");
}

function buildFromRead(spec: unknown, subject: string): WriteNode {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(subject + ": expected a `get` result (a read spec object) — got " + JSON.stringify(spec) + ".");
  }
  const n = spec as SimplifiedNode;
  const type = assertAuthorableType(n.type, subject);
  try {
    return BUILDERS[type](n, subject);
  } catch (e) {
    // The constructor names itself; prefix the path so a deep refusal still says WHICH node. A child's
    // error is already prefixed by its own call, and the frame builder rebuilds children before its own
    // call, so nothing is prefixed twice.
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.startsWith(subject) ? message : subject + ": " + message);
  }
}

function childSubject(subject: string, i: number, child: SimplifiedNode | undefined): string {
  return subject + " > " + JSON.stringify(child?.name ?? child?.type ?? `child[${i}]`);
}

function assertAuthorableType(type: unknown, subject: string): AuthorableReadType {
  if (typeof type !== "string" || !type) {
    throw new Error(subject + ": the spec has no `type` — pass a node from flcm.get (the read shape always names its type).");
  }
  if (own(BUILDERS as Record<string, Builder>, type)) return type as AuthorableReadType;
  const why = own(UNAUTHORABLE_TYPES, type);
  throw new Error(
    subject + ": " + type + " nodes have no authored form — " +
      (why || "flcm's constructors build FRAME/TEXT/RECTANGLE/ELLIPSE/LINE (plus svg/path from markup you supply), and this is none of them") +
      ". " + CLONE_REMEDY,
  );
}
