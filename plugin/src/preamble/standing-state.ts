/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Words written to a live node are a delta against the node as it stands: a word equal to what a
// read of it reports is no change. A pasted read, or a value copied out of one, therefore states
// nothing — an echoed binding declares nothing, an echoed sublayer value pins no override. Every
// verb that writes live words (placement's live identities, edit, editMany) asks this one module.
//
// Only while the call leaves alone what the read described the word against: a parent re-flowing,
// a sibling restacking, an instance swapping, a property being renamed, a text's runs rewritten.
// Then restating is a write.
import { stableStringify, type SimplifiedNode } from "@framelink/core";
import { readStandingState } from "./read.js";
import { liveSublayerIdOf } from "./instance.js";

/** One live node a verb writes words to, and its parent within the call (a node id, or any key). */
interface StatedNode {
  node: SceneNode;
  words: Record<string, unknown>;
  parent?: string;
}

interface StandingState {
  /** Read `node` (and its subtree) unless an ancestor's read already covers it. */
  load(node: SceneNode): Promise<void>;
  /**
   * Each node's words that change it, in `stated` order, judged across the whole call.
   * `restacked`: parents a new node in the call lands under with a zIndex of its own.
   */
  changesInCall(stated: readonly StatedNode[], restacked?: Iterable<string>): Record<string, unknown>[];
}

// Judged at prepare, not at the seal: a user edit landing in between keeps the user's value for a
// restated word, since the agent's value came from a read older still.
export function createStandingState(): StandingState {
  const reads = new Map<string, SimplifiedNode[]>();
  const changes = (node: SceneNode, words: Record<string, unknown>, context: CallContext): Record<string, unknown> => {
    const standing = reads.get(node.id) ?? [];
    const changed = changedWords(words, standing, { ...context, held: runVariedWords(words, standing) });
    if (node.type !== "INSTANCE") return changed;
    // A swap or a variant change replaces what the instance is, so its read describes the
    // component it is leaving: none of its words or overrides can be judged against it.
    if (retargets(node, changed)) return words;
    if (isBag(changed.overrides) && Object.keys(changed.overrides).length) {
      const overrides = changedOverrides(node.id, changed.overrides, reads);
      if (Object.keys(overrides).length) changed.overrides = overrides;
      else delete changed.overrides;
    }
    return changed;
  };
  return {
    async load(node) {
      if (!reads.has(node.id)) for (const [id, read] of await readStandingState(node)) reads.set(id, read);
    },
    changesInCall(stated, restacked = []) {
      // First pass in isolation, to learn what the call changes around each node; then each node
      // again against that.
      const alone = stated.map(({ node, words }) => changes(node, words, NO_CONTEXT));
      const reflowing = new Set(stated.flatMap(({ node }, i) => reflowsChildren(alone[i]) ? [node.id] : []));
      const restacking = new Set([...restacked, ...stated.flatMap(({ parent }, i) => parent !== undefined && isBag(alone[i].layout) && "zIndex" in alone[i].layout ? [parent] : [])]);
      const redefined = stated.flatMap(({ node }, i) => redefinedProperties(node, alone[i]));
      return stated.map(({ node, words, parent }) => changes(node, words, {
        parentReflows: parent !== undefined && reflowing.has(parent),
        siblingsRestack: parent !== undefined && restacking.has(parent),
        redefined: redefined.filter(({ owner }) => isInside(node, owner)).flatMap(({ names }) => names),
        held: [],
      }));
    },
  };
}

interface CallContext { parentReflows: boolean; siblingsRestack: boolean; redefined: readonly string[]; held: readonly string[] }
const NO_CONTEXT: CallContext = { parentReflows: false, siblingsRestack: false, redefined: [], held: [] };

// A run-styled text reads `text` as runs, each naming the words it varies. Its textStyle is the base
// those runs override, but a written textStyle sets the whole node: a base word a run varies
// restates only beside the very runs it is the base of, so without them it flattens the runs.
function runVariedWords(words: Record<string, unknown>, standing: readonly SimplifiedNode[]): string[] {
  const runs = standing.map(read => read.text).find(Array.isArray);
  if (!runs || standing.some(read => sameReadValue(read.text, words.text))) return [];
  const varied = runs.flatMap(run => Array.isArray(run) && isBag(run[1]) ? Object.keys(run[1]) : []);
  return varied.some(word => FONT_IDENTITY_WORDS.includes(word)) ? [...varied, ...FONT_IDENTITY_WORDS] : varied;
}

/** Does this delta change the flow its children are laid out in? */
function reflowsChildren(changes: Record<string, unknown>): boolean {
  return isBag(changes.layout) ? changes.layout.mode !== undefined : "layout" in changes;
}

// The property names a component's delta renames (`{ name }`) or deletes (`null`): a binding naming
// one was read against a definition this call changes.
function redefinedProperties(node: SceneNode, changes: Record<string, unknown>): { owner: SceneNode; names: string[] }[] {
  if (!isBag(changes.propertyDefinitions)) return [];
  const names = Object.entries(changes.propertyDefinitions).flatMap(([name, def]) => def === null || (isBag(def) && "name" in def) ? [name] : []);
  return names.length ? [{ owner: node, names }] : [];
}

function isInside(node: BaseNode, ancestor: BaseNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

// A null is the read's word for a field at its default, so it equals absence. Only plain JSON data
// can restate: an undefined is an unset variable and NaN serializes as null, and the compile refuses
// both by name.
function sameReadValue(read: unknown, authored: unknown): boolean {
  return isJsonData(authored) && stableStringify(read ?? null) === stableStringify(authored ?? null);
}

function isJsonData(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonData);
  return isBag(value) && Object.values(value).every(isJsonData);
}

function changedWords(words: Record<string, unknown>, standing: readonly SimplifiedNode[], context: CallContext): Record<string, unknown> {
  const held = new Set([...(context.parentReflows ? PARENT_RELATIVE_WORDS : []), ...(context.siblingsRestack ? ["zIndex"] : []), ...context.held]);
  const changed: Record<string, unknown> = {};
  for (const [word, value] of Object.entries(words)) {
    const reads = standing.map(read => (read as unknown as Record<string, unknown>)[word]);
    // An empty bag states nothing rather than restating something: kept, so the compile refuses it.
    if (PARTIAL_BAGS.has(word) && isBag(value) && Object.keys(value).length) {
      const bag = changedBagWords(word, value, reads.filter(isBag), held, context.redefined);
      if (Object.keys(bag).length) changed[word] = bag;
    } else if (held.has(word) || !reads.some(read => sameReadValue(read, value))) changed[word] = value;
  }
  return changed;
}

// Bags written word by word, so a spread read with one word changed restates the rest, and each
// restated word is no change too. Re-sent, `alignItems` would un-stretch every fill child.
const PARTIAL_BAGS = new Set(["layout", "textStyle", "componentProperties", "componentPropertyReferences"]);

// A font is one identity: changing one member re-resolves the others (edit-plan.ts
// enrichFontIdentity), so a restated family beside a new weight anchors the change.
const FONT_IDENTITY_WORDS = ["fontFamily", "fontWeight", "fontStyle", "fontVariantName"];

// A child's words about its parent's flow. When the same call re-flows that parent, the read
// described the old flow, so restating them is a write. A read's zIndex is the derived stacking
// order, so a sibling restacking stales it the same way.
const PARENT_RELATIVE_WORDS = [
  "width", "height", "position", "left", "top", "right", "bottom", "alignSelf", "justifySelf", "gridColumn", "gridRow", "zIndex",
];

function isBag(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function changedBagWords(
  bag: string, words: Record<string, unknown>, standing: readonly Record<string, unknown>[], held: ReadonlySet<string>, redefined: readonly string[],
): Record<string, unknown> {
  const stays = (word: string, value: unknown): boolean =>
    held.has(word) || (bag === "componentPropertyReferences" && redefined.indexOf(value as string) !== -1) ||
    !standing.some(read => sameReadValue(read[word], value));
  const changed: Record<string, unknown> = {};
  for (const [word, value] of Object.entries(words)) if (stays(word, value)) changed[word] = value;
  // A new mode re-reads every container word: the read described them under the old one.
  if (bag === "layout" && "mode" in changed) return words;
  if (bag === "textStyle" && FONT_IDENTITY_WORDS.some(word => word in changed)) {
    for (const word of FONT_IDENTITY_WORDS) if (word in words) changed[word] = words[word];
  }
  return changed;
}

function retargets(instance: InstanceNode, words: Record<string, unknown>): boolean {
  if (words.componentId !== undefined) return true;
  const properties = isBag(words.componentProperties) ? Object.keys(words.componentProperties) : [];
  return properties.some(name => instance.componentProperties[name]?.type === "VARIANT");
}

// Each override path is a delta against the live sublayer it names, so a pasted instance's echoed
// children (lifted into overrides by compile-tree.ts) don't pin their inherited values as overrides.
function changedOverrides(instanceId: string, overrides: Record<string, unknown>, standing: ReadonlyMap<string, SimplifiedNode[]>): Record<string, unknown> {
  // A nested swap retargets every path beneath it, as a top-level swap does the whole instance.
  const swapped = Object.entries(overrides).flatMap(([path, delta]) =>
    isBag(delta) && delta.componentId !== undefined && !standing.get(liveSublayerIdOf(instanceId, path))?.some(read => sameReadValue(read.componentId, delta.componentId)) ? [path + ";"] : []);
  const changed: Record<string, unknown> = {};
  for (const [path, delta] of Object.entries(overrides)) {
    const sublayer = standing.get(liveSublayerIdOf(instanceId, path));
    const retargeted = swapped.some(prefix => path.startsWith(prefix));
    if (!sublayer || retargeted || !isBag(delta) || !Object.keys(delta).length) { changed[path] = delta; continue; }
    const words = changedWords(delta, sublayer, NO_CONTEXT);
    if (Object.keys(words).length) changed[path] = words;
  }
  return changed;
}
