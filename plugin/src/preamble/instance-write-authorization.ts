/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// instance-write-authorization — the one decision point for every write that lands inside an
// instance; instance-write-policy.ts holds the rules as data. Every route that writes a node's words
// asks here, after compiling them and planning its sizing, and gets back a value only this module can
// mint. The appliers accept nothing else, so a route that skips authorization fails to type-check.
// A word that only restates the live value is stripped, never refused and never written.
//
// A plan judged against a component definition (an override compiled before its instance exists) is
// preflight only: once the instance holds the sublayer, it is authorized again on the live node.

import type { BuiltNode, ComponentEditWords, InstanceEditWords, VariableRef, WriteLayout, WriteProps } from "./ir.js";
import { isTokenRef } from "./ir.js";
import { variableFor, type ResolvedTokens } from "./tokens.js";
import type { EditPlan } from "./edit-plan.js";
import { CONSTRAINT_H, CONSTRAINT_V, LAYOUT_MODES, type ChildLayout, type LayoutMode } from "./layout-mode.js";
import { describeNodeIdentity, instanceContextUnder, type InstanceContextFacts } from "./identity.js";
import {
  planNodeSizing, builtNodeSizingFacts, liveNodeSizingFacts, type NodeSizingPlan, type ResolvedLiveLayout,
} from "./sizing-plan.js";
import {
  INSTANCE_WRITE_RULES, INSTANCE_WRITE_PROP_VERDICTS, INSTANCE_WRITE_LAYOUT_VERDICTS,
  type InstanceWriteRule, type InstanceWriteRuleId,
} from "./instance-write-policy.js";
import { unrotatedCornerOf } from "./pivot.js";
import { aspectRatioAgrees } from "./aspect-ratio.js";

// Only this module holds the token, so only its mint functions can construct the values below.
const MINT: unique symbol = Symbol("instance-write-authorization");

function assertMinted(token: typeof MINT): void {
  if (token !== MINT) throw new Error("flcm: an authorized write was constructed outside instance-write-authorization. This is an internal error; report it.");
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

/** One edit plan, authorized on the live node it writes. Layout and rotation ride beside `patch`, minted. */
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
  ) {
    assertMinted(token);
  }
}

type Refusals = readonly { readonly rule: InstanceWriteRuleId; readonly words: readonly string[] }[];

/** What a judgement strips, by where the word lives on the compiled patch. */
interface Restatements {
  props: Set<keyof WriteProps>;
  layout: Set<keyof WriteLayout>;
  dimensions: Set<"width" | "height">;
  sizing: Set<"horizontal" | "vertical">;
}

const RULE_BY_ID = new Map<InstanceWriteRuleId, InstanceWriteRule>(INSTANCE_WRITE_RULES.map((rule) => [rule.id, rule]));

const PROP_WORD: Partial<Record<keyof WriteProps, string>> = { rotation: "rotation", children: "children" };
const LAYOUT_WORD: Partial<Record<keyof WriteLayout, string>> = {
  mode: "layout.mode", aspectRatio: "aspectRatio", left: "left", top: "top", percentPos: 'left/top "N%"',
  position: "position", constraints: "constraints", zIndex: "layout.zIndex",
};
const AXES = [["horizontal", "width"], ["vertical", "height"]] as const;
type Axis = (typeof AXES)[number][0];

// The axes a position word measures on; none for a word that is not a measurement.
function positionAxesOf(key: keyof WriteLayout, layout: WriteLayout): Axis[] {
  if (key === "left") return ["horizontal"];
  if (key === "top") return ["vertical"];
  if (key !== "percentPos") return [];
  return [...(layout.percentPos!.x != null ? ["horizontal" as const] : []), ...(layout.percentPos!.y != null ? ["vertical" as const] : [])];
}

// Whether a definition sublayer's measured size or position on one axis moves with its instance's
// box: it reflows with its parent (a constraint other than MIN for a position, STRETCH or SCALE for
// a size, a fill in flow, any position in flow), and so does every frame up to the component.
function followsInstanceBox(node: any, axis: Axis, measured: "size" | "position"): boolean {
  let what = measured;
  for (let n = node; n.parent && n.type !== "COMPONENT"; n = n.parent) {
    const parent = n.parent;
    const inFlow = !!parent.layoutMode && parent.layoutMode !== "NONE" && n.layoutPositioning !== "ABSOLUTE";
    const constraint = n.constraints?.[axis];
    const follows = inFlow
      ? what === "position" || n[axis === "horizontal" ? "layoutSizingHorizontal" : "layoutSizingVertical"] === "FILL"
      : what === "position" ? constraint !== "MIN" : constraint === "STRETCH" || constraint === "SCALE";
    if (!follows) return false;
    what = "size";
  }
  return true;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;

// Whether a variable written to `field` is the one the live layer already binds there. Without the
// resolved tokens (prepare's hint, before any lookup) a bound field can't be compared yet: undefined
// leaves the word to the gate, which judges it again with them.
function bindsSameVariable(live: any, field: string, ref: VariableRef, tokens: ResolvedTokens | undefined): boolean | undefined {
  const bound: string | undefined = live.boundVariables?.[field]?.id;
  if (!bound) return false;
  return tokens ? variableFor(ref, tokens).id === bound : undefined;
}

// Whether a px (a number or a variable) is the value the live field already holds. A number restates
// the measured value; a variable restates only the same binding.
function pxRestates(live: any, field: string, value: number | VariableRef, tokens: ResolvedTokens | undefined): boolean | undefined {
  return isTokenRef(value) ? bindsSameVariable(live, field, value, tokens) : live[field] != null && near(live[field], value);
}

// The instance-root direction rule's one comparison: the refused word, or null when `mode` keeps the
// component's direction (a restatement).
function rootModeRefusal(mode: NonNullable<WriteLayout["mode"]>, componentMode: LayoutMode): string | null {
  if (LAYOUT_MODES[mode].native === componentMode.native) return null;
  return "layout.mode " + JSON.stringify(mode) + " (its component's direction is " + JSON.stringify(componentMode.word) + ")";
}

// How the live layer sizes one axis. A node without sizing modes only has a fixed box; a text's
// height follows its auto-resize, which is what Figma reports as HUG.
function liveAxisSizing(live: any, axis: "horizontal" | "vertical"): "FIXED" | "HUG" | "FILL" {
  const mode = live[axis === "horizontal" ? "layoutSizingHorizontal" : "layoutSizingVertical"];
  if (mode === "HUG" || mode === "FILL") return mode;
  if (live.type === "TEXT" && axis === "vertical" && live.textAutoResize !== "NONE" && live.textAutoResize !== "TRUNCATE") return "HUG";
  return "FIXED";
}

// Whether one refused layout word only restates the live node; undefined when that can't be told
// without the resolved tokens. `live` is the node the plan was compiled against: the live layer, or
// a definition's sublayer for a projected plan.
function layoutWordRestates(key: keyof WriteLayout, layout: WriteLayout, live: any, sizing: NodeSizingPlan, tokens: ResolvedTokens | undefined): boolean | undefined {
  switch (key) {
    case "mode": return LAYOUT_MODES[layout.mode!].native === sizing.baseMode.native;
    case "bounds": {
      let undecided = false;
      for (const [bound, value] of Object.entries(layout.bounds!)) {
        const restates = value === "none" ? live[bound] == null : pxRestates(live, bound, value!, tokens);
        if (restates === false) return false;
        if (restates === undefined) undecided = true;
      }
      return undecided ? undefined : true;
    }
    case "aspectRatio": {
      const lock = live.targetAspectRatio;
      return layout.aspectRatio === "none" ? !lock : !!lock && aspectRatioAgrees(lock.x, lock.y, layout.aspectRatio as number);
    }
    case "left": return near(unrotatedCornerOf(live).x, layout.left!);
    case "top": return near(unrotatedCornerOf(live).y, layout.top!);
    case "percentPos": {
      const corner = unrotatedCornerOf(live), parent = live.parent;
      const pp = layout.percentPos!;
      return !!parent && (pp.x == null || near(corner.x, (pp.x / 100) * parent.width)) && (pp.y == null || near(corner.y, (pp.y / 100) * parent.height));
    }
    // "absolute" is inert under a free-form parent (applyChildPosition), so there it restates too.
    case "position": {
      const absolute = live.layoutPositioning === "ABSOLUTE";
      if (layout.position === "none") return !absolute;
      return absolute || !live.parent || !live.parent.layoutMode || live.parent.layoutMode === "NONE";
    }
    case "constraints": {
      const c = layout.constraints!, now = live.constraints;
      return !!now && (c.x == null || CONSTRAINT_H[c.x] === now.horizontal) && (c.y == null || CONSTRAINT_V[c.y] === now.vertical);
    }
    case "zIndex": return !!live.parent && live.parent.children.indexOf(live) === layout.zIndex;
    default: return false;
  }
}

function sameAngle(cssDegrees: number, figmaDegrees: number): boolean {
  const diff = ((-cssDegrees - figmaDegrees) % 360 + 360) % 360;
  return diff <= 0.01 || diff >= 359.99;
}

function judge(live: any, patch: WriteProps, sizing: NodeSizingPlan, context: InstanceContextFacts, tokens: ResolvedTokens | undefined): { refused: Refusals; strip: Restatements } {
  const refused = new Map<InstanceWriteRuleId, string[]>();
  const strip: Restatements = { props: new Set(), layout: new Set(), dimensions: new Set(), sizing: new Set() };
  const refuse = (rule: InstanceWriteRuleId, word: string) => refused.set(rule, [...(refused.get(rule) ?? []), word]);
  const layout = patch.layout ?? {};
  // A projected plan is judged against the definition's sublayer, but the instance may be sized
  // differently (a resized render, a retarget). A measured px or position that disagrees with the
  // definition, on a layer that reflows with the instance's box, is undecided until the sublayer
  // exists: applyOverridePlans authorizes it again on the materialized node, before its writes.
  const undecided = (restates: boolean | undefined, axes: readonly Axis[], measured: "size" | "position") =>
    restates === false && context.basis === "projected" && axes.some((axis) => followsInstanceBox(live, axis, measured));
  if (context.ownWritesLockedBy) {
    for (const key of Object.keys(patch) as (keyof WriteProps)[]) {
      const verdict = INSTANCE_WRITE_PROP_VERDICTS[key];
      if (patch[key] === undefined || verdict.kind !== "rule") continue;
      if (key === "rotation" && live && sameAngle(patch.rotation!, live.rotation ?? 0)) { strip.props.add(key); continue; }
      refuse(verdict.rule, PROP_WORD[key] ?? key);
    }
    for (const key of Object.keys(layout) as (keyof WriteLayout)[]) {
      const verdict = INSTANCE_WRITE_LAYOUT_VERDICTS[key];
      if (layout[key] === undefined || verdict.kind !== "rule") continue;
      const word = key === "bounds" ? Object.keys(layout.bounds!).join("/") : LAYOUT_WORD[key] ?? key;
      const restates = live ? layoutWordRestates(key, layout, live, sizing, tokens) : false;
      if (restates === undefined || undecided(restates, positionAxesOf(key, layout), "position")) continue;
      if (restates) { strip.layout.add(key); continue; }
      refuse(verdict.rule, word);
    }
    // The by-sizing-plan words, per axis: fill, hug and a text's auto-resize land; an explicit
    // resize is ignored. A px (a number, or the variable the axis already binds) restates only a
    // FIXED axis that already has it: the "fixed" it compiles with would turn a hugging or filling
    // axis fixed, a real change, so it is refused.
    for (const [axis, dim] of AXES) {
      const resize = sizing[axis].resize;
      if (!resize) continue;
      const restates = resize.kind === "px" && live ? pxRestates(live, dim, resize.value, tokens) : false;
      if (restates === undefined || (resize.kind === "px" && !isTokenRef(resize.value) && undecided(restates, [axis], "size"))) continue;
      if (restates) {
        const now = liveAxisSizing(live, axis);
        if (now === "FIXED") { strip.dimensions.add(dim); strip.sizing.add(axis); continue; }
        refuse("instance.explicit-resize", dim + " (a fixed size where the layer " + (now === "HUG" ? "hugs" : "fills") + ")");
        continue;
      }
      refuse("instance.explicit-resize", resize.kind === "px" ? dim : resize.kind === "percent" ? dim + ' "' + resize.percent + '%"' : dim + ' "fill" (out of flow, a resize to the parent)');
    }
  } else if (context.isInstanceRoot && layout.mode !== undefined) {
    const word = rootModeRefusal(layout.mode, sizing.baseMode);
    if (word) refuse("instance.root-layout-mode", word);
    else strip.layout.add("mode");
  }
  return { refused: [...refused].map(([rule, words]) => ({ rule, words })), strip };
}

function refusal(subject: string, who: string, context: InstanceContextFacts, refused: Refusals): Error {
  const owner = context.ownWritesLockedBy;
  const where = !owner
    ? who + " is an instance, and an instance's own words follow its component where Figma keeps them"
    : who + " sits inside " + (owner.projected ? "the instance of " + describeNodeIdentity(owner.node) + " this call creates or re-points" : "instance " + describeNodeIdentity(owner.node)) +
      ", where a layer's look is yours to override and its geometry is the component's";
  const parts = refused.map(({ rule: id, words }) => {
    const rule = RULE_BY_ID.get(id)!;
    return words.join(", ") + ": Figma " + (rule.figma === "ignores" ? "silently ignores this" : "throws on this") +
      (rule.scope === "instance-root" ? " on an instance" : " inside an instance") + " — " + rule.reason + " (" + id + "). Instead, " + rule.remedy + ".";
  });
  return new Error(subject + ": " + where + ". " + parts.join(" ") + " Nothing was applied.");
}

function judgeOrRefuse(
  subject: string, who: string, live: any, patch: WriteProps, sizing: NodeSizingPlan, context: InstanceContextFacts, tokens: ResolvedTokens | undefined,
): Restatements {
  const { refused, strip } = judge(live, patch, sizing, context, tokens);
  if (refused.length) throw refusal(subject, who, context, refused);
  return strip;
}

function withoutRestatements(layout: WriteLayout, strip: Restatements): WriteLayout {
  const out: WriteLayout = { ...layout };
  for (const key of strip.layout) delete out[key];
  if (strip.dimensions.size && out.dimensions) {
    out.dimensions = { ...out.dimensions };
    for (const dim of strip.dimensions) delete out.dimensions[dim];
    if (!Object.keys(out.dimensions).length) delete out.dimensions;
  }
  if (strip.sizing.size && out.sizing) {
    out.sizing = { ...out.sizing };
    for (const axis of strip.sizing) delete out.sizing[axis];
    if (!Object.keys(out.sizing).length) delete out.sizing;
  }
  return out;
}

const NO_LAYOUT: ChildLayout = { kind: "free", layout: {} };

/**
 * Judge an edit plan whose apply runs on another node (a definition's override, a clone's source,
 * a placed live node before its destination exists). Throws on a refusal; nothing is minted.
 * Without `tokens` (prepare's hint) a variable that may restate a binding is left to the gate.
 */
export function preflightInstanceWrites(
  subject: string, plan: EditPlan, resolved: ResolvedLiveLayout | null, context: InstanceContextFacts, tokens: ResolvedTokens | undefined,
): void {
  const sizing = planNodeSizing(resolved ? resolved.child : NO_LAYOUT, resolved ? resolved.sizingFacts : liveNodeSizingFacts(plan.node));
  const patch = resolved ? { ...plan.patch, layout: resolved.child.layout } : plan.patch;
  judgeOrRefuse(subject, describeNodeIdentity(plan.node), plan.node, patch, sizing, context, tokens);
}

/**
 * The instance-root direction rule on its own, for a gate that has no plan for the root yet (render's
 * INSTANCE, a live instance a tree places, a clone): `node` null names the instance this call creates.
 */
export function assertInstanceRootLayoutMode(subject: string, node: SceneNode | null, mode: WriteLayout["mode"], componentMode: LayoutMode): void {
  const word = mode === undefined ? null : rootModeRefusal(mode, componentMode);
  if (!word) return;
  const context: InstanceContextFacts = { basis: "live", ownWritesLockedBy: null, childListClosedBy: null, isInstanceRoot: true };
  throw refusal(subject, node ? describeNodeIdentity(node) : "the INSTANCE this call creates", context, [{ rule: "instance.root-layout-mode", words: [word] }]);
}

/**
 * Authorize an edit plan on the live node it writes. `resolved` is its layout words resolved where it
 * lands (bridge.resolveLiveLayoutDelta, or assertLiveNodeLandsUnderParent for a placed node);
 * `context` is where it will sit when the writes run.
 */
export function mintAuthorizedEditPlan(
  subject: string, plan: EditPlan, resolved: ResolvedLiveLayout | null, context: InstanceContextFacts, tokens: ResolvedTokens,
): AuthorizedEditPlan {
  if (context.basis !== "live") throw new Error("flcm: an edit plan is minted only against a live node; a projected plan is preflight. This is an internal error; report it.");
  const facts = resolved ? resolved.sizingFacts : liveNodeSizingFacts(plan.node);
  const child = resolved ? resolved.child : NO_LAYOUT;
  const strip = judgeOrRefuse(subject, describeNodeIdentity(plan.node), plan.node, { ...plan.patch, layout: child.layout }, planNodeSizing(child, facts), context, tokens);
  const patch: WriteProps = { ...plan.patch };
  delete patch.layout;
  for (const key of strip.props) delete patch[key];
  const rotation = patch.rotation;
  delete patch.rotation;
  let layout: AuthorizedLiveLayout | null = null;
  if (resolved) {
    const words = withoutRestatements(child.layout, strip);
    if (Object.keys(words).length) {
      const kept: ChildLayout = { ...child, layout: words };
      layout = new AuthorizedLiveLayout(MINT, kept, planNodeSizing(kept, facts), context, plan.node);
    }
  }
  return new AuthorizedEditPlan(MINT, plan.node, patch, rotation, layout, plan.instanceWords, plan.componentWords, context);
}

/** Authorize a live node's layout words alone: what a moved or placed node re-applies where it lands. */
export function mintAuthorizedLiveLayout(
  subject: string, node: SceneNode, resolved: ResolvedLiveLayout, context: InstanceContextFacts, tokens: ResolvedTokens,
): AuthorizedLiveLayout {
  const strip = judgeOrRefuse(subject, describeNodeIdentity(node), node, { layout: resolved.child.layout }, planNodeSizing(resolved.child, resolved.sizingFacts), context, tokens);
  const kept: ChildLayout = { ...resolved.child, layout: withoutRestatements(resolved.child.layout, strip) };
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
  // No live node, so nothing reads a token: the only restatement a built node has is an INSTANCE
  // root's direction matching its component's.
  const strip = judgeOrRefuse(subject, who, null, { layout: child.layout, rotation: wn.rotation }, planNodeSizing(child, facts), context, undefined);
  const kept: ChildLayout = { ...child, layout: withoutRestatements(child.layout, strip) };
  return new AuthorizedBuiltLayout(MINT, kept, planNodeSizing(kept, facts), context, wn.rotation);
}
