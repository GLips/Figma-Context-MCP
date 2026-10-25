/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// obligation — what one mutating call owes the canvas. Every word the agent authored becomes an
// obligation on one target, whether the call writes it or finds it already held, and the call
// commits only if every obligation is realized once all its writes have landed (call-finalizer.ts).
// The ledger is per call: the lock opens it before the gate, and verbs record into it from then on.
// Defaults a verb injects to execute a word are not obligations; only authored words are.

import { liveSublayerId } from "@framelink/core";
import { describeNodeIdentity } from "./flcm-error.js";
import type { Align, CornerRadii, Edges, Justify, WriteLayout, WriteProps } from "./ir.js";
import type { GridTrack } from "./grid-tracks.js";
import type { Axis } from "./layout-mode.js";
import type { ScenePaint } from "./node-to-snapshot.js";
import type { InstanceWriteRuleId } from "./instance-write-policy.js";
import type { EditOperationPhase } from "./operation-schedule.js";

/** A number the agent wrote, or a variable it named, resolved to the variable's id at the gate. */
export type BindableObligationRequest = { literal: number } | { variable: string; variableId: string };

/** A character range [start, end) of a text node. */
export type TextRange = readonly [number, number];

/**
 * Whether a text field's binding is part of the request: a variable id it must be bound to, null
 * when a literal was authored (so it must be unbound), absent when the word wasn't authored.
 */
export type TextBindingRequirement = string | null | undefined;

/** A text metric as Figma stores it: a number, or a unit/value pair. */
export type TextMetricValue = number | { unit: "PIXELS" | "PERCENT"; value: number } | { unit: "AUTO" };
export type TextMetricField = "fontSize" | "lineHeight" | "letterSpacing" | "paragraphSpacing" | "paragraphIndent" | "listSpacing";

/** One field a text range must carry. Variable-backed fields carry the resolved id instead of a value. */
export type TextFieldRequest =
  | {
    field: "fontName"; font: { family: string; style: string }; family: TextBindingRequirement; weight: TextBindingRequirement;
    /** The literal face as written, which a text keeps when this machine resolves the words to a substitute. */
    written?: { family: string; weight?: number | string; italic: boolean };
  }
  | { field: TextMetricField; value: TextMetricValue | { variableId: string } }
  | { field: "textDecoration" | "textCase"; value: string }
  | { field: "fills"; paints: readonly ScenePaint[]; hashKnown: readonly boolean[] }
  | { field: "hyperlink"; url: string };

export interface TextRunRequest { start: number; end: number; fields: readonly TextFieldRequest[] }

/** A paint stack in Figma's bottom-first order. A url image's hash only exists once it is written. */
export interface PaintStackRequest {
  paints: readonly ScenePaint[];
  hashKnown: readonly boolean[];
  spelled: string;
}

/**
 * One entry per kind of thing flcm can write; obligation-observers.ts holds one observer for each.
 * Every reference is resolved at the gate, so a request names variable and style ids, fonts and
 * component ids, never the agent's spelling of them (each request keeps that for its message).
 */
export interface ObligationRequests {
  name: string;
  blendMode: string;
  visible: boolean;
  locked: boolean;
  pluginKey: string;
  opacity: BindableObligationRequest;
  paintStack: PaintStackRequest & { slot: "fills" | "strokes"; except: readonly TextRange[] };
  styleLink: { slot: "fill" | "stroke" | "effect"; styleId: string; styleName: string; paints: readonly ScenePaint[]; effects: readonly Effect[] };
  strokeWeight: { uniform: BindableObligationRequest } | { sides: Edges<BindableObligationRequest> };
  strokeAlign: "INSIDE" | "OUTSIDE" | "CENTER";
  cornerRadii: CornerRadii<BindableObligationRequest>;
  effects: { effects: readonly Effect[]; spelled: string };
  rotation: number;
  clip: boolean;
  annotations: readonly { text?: string; categoryId?: string; properties?: readonly string[] }[];
  characters: string;
  textRuns: { runs: readonly TextRunRequest[] };
  fontIdentity: Extract<TextFieldRequest, { field: "fontName" }> & { except: readonly TextRange[] };
  textMetric: Extract<TextFieldRequest, { field: TextMetricField }> & { except: readonly TextRange[] };
  textAlign: string;
  textAlignVertical: string;
  textDecoration: { value: string; except: readonly TextRange[] };
  textCase: { value: string; except: readonly TextRange[] };
  hyperlink: { url: string; except: readonly TextRange[] };
  textStyleLink: { styleId: string; styleName: string };
  lineClamp: number | "none";
  vectorPaths: { paths: VectorPaths };
  pathScale: { scale: number; width: number; height: number };
  layoutMode: NonNullable<WriteLayout["mode"]>;
  justifyContent: Justify;
  alignItems: Exclude<Align, "stretch">;
  alignItemsStretch: Record<string, never>;
  gap: { row: BindableObligationRequest; column: BindableObligationRequest };
  wrap: boolean;
  padding: Edges<BindableObligationRequest>;
  gridTracks: { axis: Axis; tracks: readonly GridTrack[] };
  gridPlacement: { axis: Axis; anchor?: number; span: number };
  gridCellAlign: { axis: Axis; align: string };
  zIndex: number;
  axisSize: { axis: Axis; intent: { px: BindableObligationRequest } | { fill: true } | { hug: true } | { percent: number } };
  sizeBound: { bound: SizeBound; value: BindableObligationRequest | "none" };
  aspectRatio: number | "none";
  positionOffset: { axis: Axis; offset: { px: number } | { percent: number } };
  positioning: "absolute" | "none";
  constraint: { axis: Axis; value: string; spelled: string };
  parentage: { parent: ObligationTarget; index?: number };
  instanceComponent: { componentId: string; componentName: string; sublayerPaths: readonly string[] };
  componentPropertyValue: { name: string; value: string | boolean };
  exposedInstance: boolean;
  slotContent: { content: readonly ObligationTarget[] };
  componentDescription: string;
  /** A rename, an add and a restatement all declare a name; `replaces` is the full name a rename leaves, `delete` the full name a delete removes. */
  propertyDefinition: { declare: string; figmaType: string; replaces?: string } | { delete: string };
  /** `name` is the bare name the field must reference, or null for an unbound field. */
  propertyBinding: { wire: string; name: string | null };
}

export type SizeBound = "minWidth" | "maxWidth" | "minHeight" | "maxHeight";

export type ObligationKind = keyof ObligationRequests;

export type ObligationTarget =
  | { node: SceneNode }
  // An instance sublayer: resolved when observed, because a retarget in the same call can replace it.
  | { instance: ObligationTarget; path: string };

/** Where the word was authored: `subject` is the call site ("flcm.editMany[2]"), `path` the word in it. */
export interface AuthoredWordSource {
  subject: string;
  path: string;
}

/**
 * A component or instance word, which no WriteProps field holds: an instance's exposure or one
 * property value, a component's description or one definition (by the name authored), or one
 * bound field.
 */
export type ComponentWordField = "exposed" | "description" | `property:${string}` | `definition:${string}` | `binding:${string}`;

export type PatchField =
  | { prop: keyof WriteProps } | { layout: keyof WriteLayout } | { axis: "horizontal" | "vertical" } | { word: ComponentWordField };

/**
 * A PatchField as one string, the unit a write point decides: "prop:fills", "layout:gap",
 * "axis:horizontal" (an axis's sizing with its px, percent and designed size), or "word:exposed".
 */
export type PatchFieldKey = `prop:${keyof WriteProps}` | `layout:${keyof WriteLayout}` | `axis:${Axis}` | `word:${ComponentWordField}`;

export function patchFieldKey(field: PatchField): PatchFieldKey {
  return "prop" in field ? `prop:${field.prop}` : "layout" in field ? `layout:${field.layout}` : "axis" in field ? `axis:${field.axis}` : `word:${field.word}`;
}

/** An accepted way of realizing a size that differs from its literal request; `realized` is the size accepted. */
export type RealizationConcession =
  | { kind: "size-bound-clamp"; axis: "width" | "height"; realized: number }
  | { kind: "write-time-resize-miss"; axis: "width" | "height"; realized: number }
  // A moved node's carried "fill", kept at its px where the destination reads fill as the parent's box.
  | { kind: "carried-fill"; axis: "width" | "height"; realized: number };

// Beyond the edit phases: a built node's words land in the build walk, a move's in the structural
// attach, and some only in the lock's own tail (sibling order, style links), so only the finalizer sees them.
export type ObligationWritePoint = EditOperationPhase | "build" | "structural" | "finalizer";

export interface Obligation<K extends ObligationKind = ObligationKind> {
  readonly kind: K;
  readonly request: ObligationRequests[K];
  /** Mutable only through retargetObligationNode. */
  target: ObligationTarget;
  readonly source: AuthoredWordSource;
  readonly writePoint: ObligationWritePoint;
  /** The compiled fields its write needs (a `left` carries the position it implies). */
  readonly carries: readonly PatchField[];
  /** realizeOnly: the instance write policy forbids writing it here, so it must hold without a write. */
  readonly writability: "writable" | { realizeOnly: InstanceWriteRuleId };
  /** Sequence of the operation that last wrote it; absent while the call has not written it. */
  writtenAt?: number;
  /** It already held at a write point, so the call wrote nothing for it there. */
  heldAtWritePoint?: boolean;
}

let obligations: Obligation[] = [];
// Keyed by node id, not by obligation: a built node is sized before its words are recorded, and a
// concession conceded then must still excuse them.
let concessions = new Map<string, RealizationConcession[]>();
let writeSequence = 0;

/** Open a fresh ledger for the call. The lock calls it before the gate, so a gate may record. */
export function beginObligationLedger(): void {
  obligations = [];
  concessions = new Map();
  writeSequence = 0;
}

/** One write landed for each of `written`: they share its sequence number. */
export function markObligationsWritten(written: readonly Obligation[]): void {
  if (!written.length) return;
  writeSequence++;
  for (const obligation of written) obligation.writtenAt = writeSequence;
}

export function recordObligations(recorded: readonly Obligation[]): void {
  obligations.push(...recorded);
}

/** Drop the `kind` obligations held on `node`: a later word of the same call restates that field. */
export function supersedeObligations(node: SceneNode, kind: ObligationKind): void {
  obligations = obligations.filter((o) => o.kind !== kind || !("node" in o.target) || o.target.node !== node);
}

export function obligationsInCall(): readonly Obligation[] {
  return obligations;
}

/**
 * Point every obligation held against `from` at `to`, for an apply that replaced the node
 * (createComponentFromNode). Called from the lock's retargetReplacedNode, beside every other
 * per-call accumulator that holds a node.
 */
export function retargetObligationNode(from: SceneNode, to: SceneNode): void {
  const follow = (target: ObligationTarget): ObligationTarget =>
    "node" in target ? (target.node === from ? { node: to } : target)
      : { instance: follow(target.instance), path: target.path };
  const conceded = concessions.get(from.id);
  if (conceded) {
    concessions.delete(from.id);
    concessions.set(to.id, [...(concessions.get(to.id) ?? []), ...conceded]);
  }
  for (const obligation of obligations) {
    obligation.target = follow(obligation.target);
    // A request that names a layer follows it too: a child stays under the component its parent became.
    if (obligation.kind === "parentage") {
      const request = obligation.request as ObligationRequests["parentage"];
      (obligation as { request: ObligationRequests["parentage"] }).request = { ...request, parent: follow(request.parent) };
    }
  }
}

/** Record an accepted realization on `node`, for every obligation on it, recorded yet or not. */
export function concedeRealization(node: { readonly id: string }, concession: RealizationConcession): void {
  concessions.set(node.id, [...(concessions.get(node.id) ?? []), concession]);
}

/** The realizations the call accepted on `node`. */
export function concessionsOnNode(node: { readonly id: string }): readonly RealizationConcession[] {
  return concessions.get(node.id) ?? [];
}

/** The live node an obligation names now, or null when the call removed or replaced it. */
export function resolveObligationTarget(target: ObligationTarget): SceneNode | null {
  if ("node" in target) return target.node.removed ? null : target.node;
  const instance = resolveObligationTarget(target.instance);
  if (!instance || instance.type !== "INSTANCE") return null;
  const id = liveSublayerId(instance.id, target.path);
  return instance.findOne((n) => n.id === id);
}

/** The target, named for a failure message, including a target the call no longer finds. */
export function describeObligationTarget(target: ObligationTarget): string {
  const node = resolveObligationTarget(target);
  if (node) return describeNodeIdentity(node);
  // A removed node still answers `id` (every other read throws live).
  if ("node" in target) return "the layer " + JSON.stringify(target.node.id) + " (no longer on the canvas)";
  return describeObligationTarget(target.instance) + "'s sublayer " + JSON.stringify(target.path) + " (not in the instance)";
}
