/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// instance-write-policy — what Figma does with each flcm write word inside an INSTANCE, as data.
//
// Inside an instance a layer's look is the author's to override and its geometry is the
// component's. Figma enforces that unevenly: some geometry writes it silently ignores, others it
// throws on. Every rule below is one meaning, with the live evidence behind it; every write word
// gets an explicit verdict, so a word added to WriteProps or WriteLayout fails the type-check until
// someone decides what Figma does with it there. instance-write-authorization.ts applies the rules;
// the flcm reference prints them (schema.ts re-exports this module for the doc generator).
//
// Pure data and type-only imports: the root toolchain type-checks schema.ts without figma typings.

import type { WriteLayout, WriteProps } from "./ir.js";

export type InstanceWriteRuleId =
  | "instance.explicit-resize"
  | "instance.size-bounds"
  | "instance.layout-mode-change"
  | "instance.aspect-lock"
  | "instance.transform"
  | "instance.positioning"
  | "instance.constraints"
  | "instance.child-list"
  | "instance.root-layout-mode";

export interface InstanceWriteRule {
  readonly id: InstanceWriteRuleId;
  /** "locked-sublayer": a layer in the component's own tree. "instance-root": the instance itself. */
  readonly scope: "locked-sublayer" | "instance-root";
  /** The author-facing words the rule refuses. The docs print each as code up to a " (" note. */
  readonly words: readonly string[];
  /** What Figma does with the write: returns and changes nothing, or throws. */
  readonly figma: "ignores" | "throws";
  readonly reason: string;
  readonly remedy: string;
  readonly evidence: string;
}

const MATRIX = "live 2026-10-23, plugin/scenarios/live/instance-write-matrix";

// Not "choose a variant": a nested variant swap keeps the placement's px on its fixed axis, so
// the only routes that resize such a layer are its definition and detaching.
const SIZE_REMEDY = "size it on the component definition's layer, or detach the instance";

export const INSTANCE_WRITE_RULES: readonly InstanceWriteRule[] = [
  {
    id: "instance.explicit-resize", scope: "locked-sublayer", words: ["width", "height", '"N%" (a percent size)', '"fill" (outside auto-layout, where it is a resize to the parent)'], figma: "ignores",
    reason: "a layer's size inside an instance belongs to its component",
    remedy: SIZE_REMEDY + '; inside an auto-layout parent, width/height "fill" or "hug" do land', evidence: MATRIX,
  },
  {
    id: "instance.size-bounds", scope: "locked-sublayer", words: ["minWidth", "maxWidth", "minHeight", "maxHeight"], figma: "ignores",
    reason: "size bounds inside an instance belong to its component", remedy: SIZE_REMEDY, evidence: MATRIX,
  },
  {
    id: "instance.layout-mode-change", scope: "locked-sublayer", words: ["layout.mode"], figma: "ignores",
    reason: "a layer's layout direction inside an instance belongs to its component",
    remedy: "change it on the main component; gap, padding and alignment do land", evidence: MATRIX,
  },
  {
    id: "instance.aspect-lock", scope: "locked-sublayer", words: ["aspectRatio"], figma: "ignores",
    reason: "a proportion lock inside an instance belongs to its component", remedy: SIZE_REMEDY, evidence: MATRIX,
  },
  {
    id: "instance.transform", scope: "locked-sublayer", words: ["left", "top", "rotation"], figma: "throws",
    reason: "a layer's position and rotation inside an instance belong to its component",
    remedy: "move or turn it on the main component, or detach the instance", evidence: MATRIX,
  },
  {
    id: "instance.positioning", scope: "locked-sublayer", words: ["position"], figma: "throws",
    reason: "whether a layer sits in its parent's flow inside an instance belongs to its component",
    remedy: "change it on the main component, or detach the instance", evidence: MATRIX,
  },
  {
    id: "instance.constraints", scope: "locked-sublayer", words: ["constraints"], figma: "throws",
    reason: "a layer's constraints inside an instance belong to its component",
    remedy: "change them on the main component, or detach the instance", evidence: MATRIX,
  },
  {
    id: "instance.child-list", scope: "locked-sublayer", words: ["children", "layout.zIndex", "append", "prepend", "insertBefore", "insertAfter", "remove"], figma: "throws",
    reason: "an instance's layer tree belongs to its component",
    remedy: "use a slot, or edit the main component", evidence: MATRIX,
  },
  {
    id: "instance.root-layout-mode", scope: "instance-root", words: ["layout.mode"], figma: "ignores",
    reason: "an instance's direction follows its component",
    remedy: "choose a component or variant with that direction (componentId / componentProperties), or change the main component",
    evidence: MATRIX,
  },
];

/** What a write word does inside an instance's locked tree. */
export type InstanceWriteVerdict =
  /** Lands: the live matrix wrote it and read it back. */
  | { readonly kind: "allowed"; readonly word: string; readonly evidence: string }
  /** Default-allowed within flcm's validated vocabulary; not yet in the live matrix. */
  | { readonly kind: "allowed-unverified"; readonly word: string }
  | { readonly kind: "rule"; readonly rule: InstanceWriteRuleId }
  /** Judged per axis from the node's sizing plan: an explicit resize refuses, fill and hug land. */
  | { readonly kind: "by-sizing-plan" }
  /** Not a canvas write of its own; another module decides it. */
  | { readonly kind: "not-a-write"; readonly decidedBy: string };

const allowed = (word: string): InstanceWriteVerdict => ({ kind: "allowed", word, evidence: MATRIX });
const unverified = (word: string): InstanceWriteVerdict => ({ kind: "allowed-unverified", word });
const rule = (id: InstanceWriteRuleId): InstanceWriteVerdict => ({ kind: "rule", rule: id });

export const INSTANCE_WRITE_PROP_VERDICTS: { readonly [K in keyof Required<WriteProps>]: InstanceWriteVerdict } = {
  annotations: unverified("annotations"),
  name: allowed("name"),
  key: { kind: "not-a-write", decidedBy: "pluginData stamp (identity.ts)" },
  text: allowed("text"),
  vector: unverified("vectorPaths / d"),
  runs: unverified("text runs"),
  textStyle: unverified("textStyle"),
  maxLines: unverified("textStyle.lineClamp"),
  fills: allowed("fill"),
  strokes: allowed("stroke"),
  strokeWeight: allowed("strokeWidth"),
  strokeAlign: unverified("strokeAlign"),
  effects: allowed("effects"),
  styles: unverified("style links"),
  opacity: allowed("opacity"),
  blendMode: allowed("mixBlendMode"),
  borderRadius: allowed("borderRadius"),
  clip: allowed("clip"),
  rotation: rule("instance.transform"),
  visible: allowed("visible"),
  locked: unverified("locked"),
  layout: { kind: "not-a-write", decidedBy: "INSTANCE_WRITE_LAYOUT_VERDICTS" },
  children: rule("instance.child-list"),
  exposed: { kind: "not-a-write", decidedBy: "instance.ts" },
  component: { kind: "not-a-write", decidedBy: "instance.ts" },
  componentProperties: { kind: "not-a-write", decidedBy: "instance.ts" },
  overrides: { kind: "not-a-write", decidedBy: "instance.ts" },
  componentPropertyReferences: { kind: "not-a-write", decidedBy: "component-edit.ts" },
};

export const INSTANCE_WRITE_LAYOUT_VERDICTS: { readonly [K in keyof Required<WriteLayout>]: InstanceWriteVerdict } = {
  bounds: rule("instance.size-bounds"),
  // At an instance root the root rule applies instead (instance.root-layout-mode).
  mode: rule("instance.layout-mode-change"),
  gridTemplateColumns: unverified("layout.gridTemplateColumns"),
  gridTemplateRows: unverified("layout.gridTemplateRows"),
  gridColumn: unverified("layout.gridColumn"),
  gridRow: unverified("layout.gridRow"),
  justifySelf: unverified("layout.justifySelf"),
  alignSelf: allowed('layout.alignSelf "stretch"'),
  zIndex: rule("instance.child-list"),
  justifyContent: allowed("layout.justifyContent"),
  alignItems: allowed("layout.alignItems"),
  gap: allowed("layout.gap"),
  wrap: allowed("layout.wrap"),
  padding: allowed("layout.padding"),
  sizing: { kind: "by-sizing-plan" },
  dimensions: { kind: "by-sizing-plan" },
  aspectRatio: rule("instance.aspect-lock"),
  percentSize: { kind: "by-sizing-plan" },
  percentPos: rule("instance.transform"),
  designedSize: { kind: "not-a-write", decidedBy: "percent and page-root resolution (layout-legality.ts)" },
  constraints: rule("instance.constraints"),
  position: rule("instance.positioning"),
  left: rule("instance.transform"),
  top: rule("instance.transform"),
};

/** The words the live matrix verified land on a layer inside an instance — what the docs list. */
export function instanceWordsVerifiedToLand(): readonly string[] {
  const words = [...Object.values(INSTANCE_WRITE_PROP_VERDICTS), ...Object.values(INSTANCE_WRITE_LAYOUT_VERDICTS)]
    .flatMap((verdict) => (verdict.kind === "allowed" ? [verdict.word] : []));
  return [...words, 'width/height "fill" or "hug"'];
}
