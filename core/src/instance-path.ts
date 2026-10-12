/**
 * The grammar of Figma's instance sublayer ids, owned here so every reader and writer of them
 * spells it once.
 *
 * A node inside an instance has a composite id: `I<instance>;<segment>;…`, with exactly ONE
 * leading `I` however deep the nesting. A nested instance's own id already carries that `I`
 * (`I19:1;16:2`), a top-level instance's does not (`11:12`), and both address their sublayers the
 * same way. The segments after the instance are the node's COMPONENT-RELATIVE path, which is the
 * same string in every instance of a component and, with one leading `I` iff it crosses an
 * instance boundary, the id the node has inside the definition itself.
 */

/**
 * A Figma node id as an agent may pass it: colon form from the API (`1234:5678`), dash form from
 * a URL's `node-id` (`1234-5678`), or an instance sublayer chain (`I5666:180910;1:10515`).
 */
export const FIGMA_NODE_ID_PATTERN = /^I?\d+[:-]\d+(?:;\d+[:-]\d+)*$/;

/** Whether `id` names a node inside an instance — a composite id, rather than a plain one. */
export function isSublayerId(id: string): boolean {
  return id.startsWith("I");
}

/** The prefix every sublayer of `instanceId` starts with: its own id with one leading `I`, then `;`. */
export function sublayerPrefix(instanceId: string): string {
  return (isSublayerId(instanceId) ? instanceId : `I${instanceId}`) + ";";
}

/** The live sublayer a component-relative `path` names inside one instance (`I<instance>;<path>`). */
export function liveSublayerId(instanceId: string, path: string): string {
  return sublayerPrefix(instanceId) + path;
}

/**
 * A node's component-relative path. With `instanceId`, a sublayer of that instance loses its
 * prefix. Otherwise the id is read as already in a definition's id space and only its leading `I`
 * goes, so three shapes collapse to one path: a plain descendant of a definition (`11:9`), a
 * sublayer of a nested instance inside a definition (`I11:9;11:14`), and a sublayer of the
 * instance being diffed (`I11:12;11:9;11:14` under `11:12`).
 */
export function componentPath(id: string, instanceId?: string): string {
  const prefix = instanceId === undefined ? undefined : sublayerPrefix(instanceId);
  if (prefix && id.startsWith(prefix)) return id.slice(prefix.length);
  return isSublayerId(id) ? id.slice(1) : id;
}

/** `componentPath`'s inverse onto the definition's own id space: one leading `I` iff the path crosses an instance. */
export function definitionId(path: string): string {
  return path.includes(";") ? `I${path}` : path;
}

/** The outermost instance a sublayer id sits in (`11:12` for `I11:12;4:5`), or undefined for a plain id. */
export function outermostInstanceId(id: string): string | undefined {
  if (!isSublayerId(id)) return undefined;
  const end = id.indexOf(";");
  return end === -1 ? undefined : id.slice(1, end);
}

/** A node's own guid: the last segment of its id, whatever instance path leads to it. */
export function guidOf(id: string): string {
  return id.slice(id.lastIndexOf(";") + 1);
}
