/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// instance-write-authorization — the one decision point for whether a write may run where it lands
// inside an instance; instance-write-policy.ts holds the rules as data. Every route that writes a
// node's words asks here, after compiling them and planning its sizing, and gets back a value only
// this module can mint. The appliers accept nothing else, so a route that skips authorization fails
// to type-check.
//
// A word the policy forbids writing is realize-only: never handed to an applier, and owed all the
// same, so it has to hold without a write (call-obligations.ts refuses it at the gate when nothing
// in the call can make it hold; the finalizer checks it after). The one static refusal is an
// instance root's direction differing from its component's. Each write point mints again, against
// the node and its context as they stand then (mintAuthorizedWriteSubset).

import type { BuiltNode, ComponentEditWords, InstanceEditWords, WriteLayout, WriteProps } from "./ir.js";
import type { EditPlan, EditPlanLanding } from "./edit-plan.js";
import { LAYOUT_MODES, AXES, type Axis, type ChildLayout, type LayoutMode } from "./layout-mode.js";
import { describeNodeIdentity, instanceContextOf, instanceContextUnder, type InstanceContextFacts } from "./identity.js";
import {
  planNodeSizing, builtNodeSizingFacts, liveNodeSizingFacts, type AxisResize, type NodeSizingPlan, type ResolvedLiveLayout,
} from "./sizing-plan.js";
import {
  INSTANCE_WRITE_PROP_VERDICTS, INSTANCE_WRITE_LAYOUT_VERDICTS, describeInstanceWriteRule,
  type InstanceWriteRuleId,
} from "./instance-write-policy.js";
import type { PatchFieldKey } from "./obligation.js";

// Only this module holds the token, so only its mint functions can construct the values below.
const MINT: unique symbol = Symbol("instance-write-authorization");

function assertMinted(token: typeof MINT): void {
  if (token !== MINT) throw new Error("flcm: an authorized write was constructed outside instance-write-authorization. This is an internal error; report it.");
}

/** A field the policy forbids writing where it lands: the rule, and the word as a refusal names it. */
export interface RealizeOnlyField { readonly rule: InstanceWriteRuleId; readonly word: string }
export type RealizeOnlyFields = ReadonlyMap<PatchFieldKey, RealizeOnlyField>;

type Refusals = readonly { readonly rule: InstanceWriteRuleId; readonly words: readonly string[] }[];

/** What the policy makes of one patch where it lands. */
export interface InstanceWriteClassification {
  readonly refused: Refusals;
  readonly realizeOnly: RealizeOnlyFields;
}

/** A node's layout words, authorized where it lands, with the sizing plan the appliers carry out. */
export class AuthorizedLayout {
  // A private member makes the class nominal: no object literal or spread of one passes for it.
  private readonly authorizedBy = "instance-write-authorization";
  constructor(token: typeof MINT, readonly child: ChildLayout, readonly sizing: NodeSizingPlan, readonly context: InstanceContextFacts) {
    assertMinted(token);
  }
}

/** A node the walk builds: its layout, and the rotation judged beside it. */
export class AuthorizedBuiltLayout extends AuthorizedLayout {
  constructor(token: typeof MINT, child: ChildLayout, sizing: NodeSizingPlan, context: InstanceContextFacts, readonly rotation: number | undefined) {
    super(token, child, sizing, context);
  }
}

/** The same, bound to the live node it was judged against. */
export class AuthorizedLiveLayout extends AuthorizedLayout {
  constructor(token: typeof MINT, child: ChildLayout, sizing: NodeSizingPlan, context: InstanceContextFacts, readonly node: SceneNode) {
    super(token, child, sizing, context);
  }
}

/**
 * One edit plan, authorized on the live node it writes: its writable fields, with layout and
 * rotation minted beside `patch`. `source` and `landing` are what a write point re-authorizes a
 * subset of; `realizeOnly` is what the plan owes but never writes.
 */
export class AuthorizedEditPlan {
  private readonly authorizedBy = "instance-write-authorization";
  constructor(
    token: typeof MINT,
    readonly node: SceneNode,
    readonly patch: Omit<WriteProps, "layout" | "rotation">,
    readonly rotation: number | undefined,
    readonly layout: AuthorizedLiveLayout | null,
    readonly instanceWords: InstanceEditWords | undefined,
    readonly componentWords: ComponentEditWords | undefined,
    readonly context: InstanceContextFacts,
    readonly realizeOnly: RealizeOnlyFields,
    readonly subject: string,
    readonly source: EditPlan,
    readonly landing: EditPlanLanding,
  ) {
    assertMinted(token);
  }
}

const PROP_WORD: Partial<Record<keyof WriteProps, string>> = { rotation: "rotation", children: "children" };
const LAYOUT_WORD: Partial<Record<keyof WriteLayout, string>> = {
  mode: "layout.mode", aspectRatio: "aspectRatio", left: "left", top: "top", percentPos: 'left/top "N%"',
  position: "position", constraints: "constraints", zIndex: "layout.zIndex",
};
const PLAN_AXES: readonly Axis[] = ["horizontal", "vertical"];

// The instance-root direction rule's one comparison: the refused word, or null when `mode` keeps the
// component's direction.
function rootModeRefusal(mode: NonNullable<WriteLayout["mode"]>, componentMode: LayoutMode): string | null {
  if (LAYOUT_MODES[mode].native === componentMode.native) return null;
  return "layout.mode " + JSON.stringify(mode) + " (its component's direction is " + JSON.stringify(componentMode.word) + ")";
}

// How a refusal names one axis's resize. A px also says when the layer doesn't hold a fixed size:
// the "fixed" a number compiles with is then a sizing change, not only a measure.
function resizeWord(node: any, axis: Axis, resize: AxisResize): string {
  const dim = AXES[axis].dimension;
  if (resize.kind === "percent") return dim + ' "' + resize.percent + '%"';
  if (resize.kind === "cover") return dim + ' "fill" (out of flow, a resize to the parent)';
  const now = node?.[AXES[axis].sizing];
  return now === "HUG" || now === "FILL" ? dim + " (a fixed size where the layer " + (now === "HUG" ? "hugs" : "fills") + ")" : dim;
}

/**
 * What the policy makes of `patch` (its layout resolved and sized as `sizing`) where `context` puts
 * it. `node` is the layer it was compiled against (the live one, or a definition's sublayer), null
 * for a node the walk builds.
 */
function classifyInstanceWrites(node: any, patch: WriteProps, sizing: NodeSizingPlan, context: InstanceContextFacts): InstanceWriteClassification {
  const realizeOnly = new Map<PatchFieldKey, RealizeOnlyField>();
  const layout = patch.layout ?? {};
  if (context.ownWritesLockedBy) {
    for (const key of Object.keys(patch) as (keyof WriteProps)[]) {
      const verdict = INSTANCE_WRITE_PROP_VERDICTS[key];
      if (patch[key] !== undefined && verdict.kind === "rule") realizeOnly.set(`prop:${key}`, { rule: verdict.rule, word: PROP_WORD[key] ?? key });
    }
    for (const key of Object.keys(layout) as (keyof WriteLayout)[]) {
      const verdict = INSTANCE_WRITE_LAYOUT_VERDICTS[key];
      if (layout[key] === undefined || verdict.kind !== "rule") continue;
      realizeOnly.set(`layout:${key}`, { rule: verdict.rule, word: key === "bounds" ? Object.keys(layout.bounds!).join("/") : LAYOUT_WORD[key] ?? key });
    }
    // The by-sizing-plan words, per axis: fill, hug and a text's auto-resize land; an explicit
    // resize is ignored there, so it has to hold already.
    for (const axis of PLAN_AXES) {
      const resize = sizing[axis].resize;
      if (resize) realizeOnly.set(`axis:${axis}`, { rule: "instance.explicit-resize", word: resizeWord(node, axis, resize) });
    }
    return { refused: [], realizeOnly };
  }
  if (context.isInstanceRoot && layout.mode !== undefined) {
    const word = rootModeRefusal(layout.mode, sizing.baseMode);
    if (word) return { refused: [{ rule: "instance.root-layout-mode", words: [word] }], realizeOnly };
    // Equal to the component's direction: Figma refuses even that write, and it already holds.
    realizeOnly.set("layout:mode", { rule: "instance.root-layout-mode", word: "layout.mode " + JSON.stringify(layout.mode) });
  }
  return { refused: [], realizeOnly };
}

/** The policy's refusal for `refused` words of `who`, in `context`. */
export function instanceWriteRefusal(subject: string, who: string, context: InstanceContextFacts, refused: Refusals): Error {
  const owner = context.ownWritesLockedBy;
  const where = !owner
    ? who + " is an instance, and an instance's own words follow its component where Figma keeps them"
    : who + " sits inside " + (owner.projected ? "the instance of " + describeNodeIdentity(owner.node) + " this call creates or re-points" : "instance " + describeNodeIdentity(owner.node)) +
      ", where a layer's look is yours to override and its geometry is the component's";
  const parts = refused.map(({ rule: id, words }) => words.join(", ") + ": " + describeInstanceWriteRule(id) + ".");
  return new Error(subject + ": " + where + ". " + parts.join(" ") + " Nothing was applied.");
}

function classifyOrRefuse(subject: string, who: string, node: any, patch: WriteProps, sizing: NodeSizingPlan, context: InstanceContextFacts): InstanceWriteClassification {
  const classification = classifyInstanceWrites(node, patch, sizing, context);
  if (classification.refused.length) throw instanceWriteRefusal(subject, who, context, classification.refused);
  return classification;
}

const AXIS_PARTS = { horizontal: "width", vertical: "height" } as const;

/** `layout` minus its realize-only fields. An axis takes its sizing, px, percent and designed size with it. */
function withoutRealizeOnlyLayout(layout: WriteLayout, realizeOnly: RealizeOnlyFields): WriteLayout {
  const out: WriteLayout = { ...layout };
  for (const key of Object.keys(out) as (keyof WriteLayout)[]) if (realizeOnly.has(`layout:${key}`)) delete out[key];
  for (const axis of PLAN_AXES) {
    if (!realizeOnly.has(`axis:${axis}`)) continue;
    const dim = AXIS_PARTS[axis];
    if (out.sizing) out.sizing = withoutPart(out.sizing, axis);
    for (const bag of ["dimensions", "percentSize", "designedSize"] as const) if (out[bag]) (out as any)[bag] = withoutPart(out[bag]!, dim);
  }
  for (const bag of ["sizing", "dimensions", "percentSize", "designedSize"] as const) if (out[bag] && !Object.keys(out[bag]!).length) delete out[bag];
  return out;
}

function withoutPart<T extends object>(bag: T, part: string): T {
  const out = { ...bag } as Record<string, unknown>;
  delete out[part];
  return out as T;
}

const NO_LAYOUT: ChildLayout = { kind: "free", layout: {} };

/**
 * Classify an edit plan whose apply runs on another node (a definition's override, a clone's source,
 * a placed live node before its destination exists). Throws on a refusal; nothing is minted.
 */
export function preflightInstanceWrites(subject: string, plan: EditPlan, resolved: ResolvedLiveLayout | null, context: InstanceContextFacts): InstanceWriteClassification {
  const sizing = planNodeSizing(resolved ? resolved.child : NO_LAYOUT, resolved ? resolved.sizingFacts : liveNodeSizingFacts(plan.node));
  const patch = resolved ? { ...plan.patch, layout: resolved.child.layout } : plan.patch;
  return classifyOrRefuse(subject, describeNodeIdentity(plan.node), plan.node, patch, sizing, context);
}

/**
 * The instance-root direction rule on its own, for a gate that has no plan for the root yet (render's
 * INSTANCE, a live instance a tree places, a clone): `node` null names the instance this call creates.
 */
export function assertInstanceRootLayoutMode(subject: string, node: SceneNode | null, mode: WriteLayout["mode"], componentMode: LayoutMode): void {
  const word = mode === undefined ? null : rootModeRefusal(mode, componentMode);
  if (!word) return;
  const context: InstanceContextFacts = { basis: "live", ownWritesLockedBy: null, childListClosedBy: null, isInstanceRoot: true };
  throw instanceWriteRefusal(subject, node ? describeNodeIdentity(node) : "the INSTANCE this call creates", context, [{ rule: "instance.root-layout-mode", words: [word] }]);
}

function mintPlan(
  subject: string, source: EditPlan, patch: WriteProps, resolved: ResolvedLiveLayout | null, context: InstanceContextFacts, landing: EditPlanLanding,
): AuthorizedEditPlan {
  if (context.basis !== "live") throw new Error("flcm: an edit plan is minted only against a live node; a projected plan is preflight. This is an internal error; report it.");
  const node = source.node;
  const facts = resolved ? resolved.sizingFacts : liveNodeSizingFacts(node);
  const child = resolved ? resolved.child : NO_LAYOUT;
  const { realizeOnly } = classifyOrRefuse(subject, describeNodeIdentity(node), node, { ...patch, layout: child.layout }, planNodeSizing(child, facts), context);
  const writable: WriteProps = { ...patch };
  delete writable.layout;
  for (const key of Object.keys(writable) as (keyof WriteProps)[]) if (realizeOnly.has(`prop:${key}`)) delete writable[key];
  const rotation = writable.rotation;
  delete writable.rotation;
  let layout: AuthorizedLiveLayout | null = null;
  if (resolved) {
    const words = withoutRealizeOnlyLayout(child.layout, realizeOnly);
    if (Object.keys(words).length) {
      const kept: ChildLayout = { ...child, layout: words };
      layout = new AuthorizedLiveLayout(MINT, kept, planNodeSizing(kept, facts), context, node);
    }
  }
  return new AuthorizedEditPlan(MINT, node, writable, rotation, layout, source.instanceWords, source.componentWords, context, realizeOnly, subject, source, landing);
}

/**
 * Authorize an edit plan on the live node it writes. `resolved` is its layout words resolved where it
 * lands (bridge.resolveLiveLayoutDelta, or assertLiveNodeLandsUnderParent for a placed node);
 * `context` is where it will sit when the writes run.
 */
export function mintAuthorizedEditPlan(
  subject: string, plan: EditPlan, resolved: ResolvedLiveLayout | null, context: InstanceContextFacts, landing: EditPlanLanding,
): AuthorizedEditPlan {
  return mintPlan(subject, plan, plan.patch, resolved, context, landing);
}

/**
 * Re-authorize the fields one write point writes (`patch`, a subset of `plan.source`'s), against the
 * node and its instance context as they stand now. `resolved` is the subset's layout, resolved now.
 */
export function mintAuthorizedWriteSubset(plan: AuthorizedEditPlan, patch: WriteProps, resolved: ResolvedLiveLayout | null): AuthorizedEditPlan {
  return mintPlan(plan.subject, plan.source, patch, resolved, instanceContextOf(plan.node), plan.landing);
}

/** Authorize a live node's layout words alone: what a moved or placed node re-applies where it lands. */
export function mintAuthorizedLiveLayout(subject: string, node: SceneNode, resolved: ResolvedLiveLayout, context: InstanceContextFacts): AuthorizedLiveLayout {
  const { realizeOnly } = classifyOrRefuse(subject, describeNodeIdentity(node), node, { layout: resolved.child.layout }, planNodeSizing(resolved.child, resolved.sizingFacts), context);
  const kept: ChildLayout = { ...resolved.child, layout: withoutRealizeOnlyLayout(resolved.child.layout, realizeOnly) };
  return new AuthorizedLiveLayout(MINT, kept, planNodeSizing(kept, resolved.sizingFacts), context, node);
}

/**
 * Authorize a node the walk is about to build under `parent` (a live node, or the facts of a frame
 * the walk is still assembling). `componentMode` is an INSTANCE's component's direction.
 */
export function mintAuthorizedBuiltLayout(
  subject: string, wn: BuiltNode, child: ChildLayout, parent: (BaseNode & ChildrenMixin) | InstanceContextFacts, componentMode?: LayoutMode,
): AuthorizedBuiltLayout {
  const context = instanceContextUnder(parent as any, wn) as InstanceContextFacts;
  const facts = builtNodeSizingFacts(wn, componentMode);
  const who = wn.type + (wn.name ? " " + JSON.stringify(wn.name) : "");
  const { realizeOnly } = classifyOrRefuse(subject, who, null, { layout: child.layout, rotation: wn.rotation }, planNodeSizing(child, facts), context);
  // A fresh node holds nothing yet, so only the root direction its component already has can hold.
  const unheld = [...realizeOnly].filter(([key]) => key !== "layout:mode" || !context.isInstanceRoot);
  if (unheld.length) {
    const byRule = new Map<InstanceWriteRuleId, string[]>();
    for (const [, { rule, word }] of unheld) byRule.set(rule, [...(byRule.get(rule) ?? []), word]);
    throw instanceWriteRefusal(subject, who, context, [...byRule].map(([rule, words]) => ({ rule, words })));
  }
  const kept: ChildLayout = { ...child, layout: withoutRealizeOnlyLayout(child.layout, realizeOnly) };
  return new AuthorizedBuiltLayout(MINT, kept, planNodeSizing(kept, facts), context, wn.rotation);
}
