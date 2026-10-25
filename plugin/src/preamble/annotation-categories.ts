/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { sceneFigma as figma } from "./scene-access.js";
import type { WriteNode } from "./ir.js";
import type { WriteAnnotation } from "./annotations.js";
import { FlcmError, appendToFailure, describeFailure } from "./flcm-error.js";

// Per-verb state, module-global rather than threaded through the verb's resources object the way
// fonts and images are: the created-category list outlives the resources, because the FAILURE path
// that removes them belongs to the lock (which never sees a verb's prepared value), and a category
// can be created by a prepare that later throws. The lock resets it as each verb's turn opens
// (enterMutatingVerb), so one verb can never remove a category another verb created — verbs are
// serialized whole, so there is exactly one verb's worth of this at a time. Constructors never
// enqueue work.
let requestedCategories = new Set<string>();
let resolvedCategories = new Map<string, string>();
let createdCategories: AnnotationCategory[] = [];

export function beginAnnotationMutation(): void {
  requestedCategories = new Set();
  resolvedCategories = new Map();
  createdCategories = [];
}

export function requestAnnotationCategories(annotations: readonly WriteAnnotation[] | undefined): void {
  for (const annotation of annotations ?? []) {
    if (annotation.category !== undefined) requestedCategories.add(annotation.category);
  }
}

export function requestTreeAnnotationCategories(tree: WriteNode): void {
  // A live node's notes are its delta's, requested with the edit's own words (live-tree.ts).
  if (tree.liveId === undefined) requestAnnotationCategories(tree.annotations);
  for (const child of tree.children ?? []) {
    if (child && typeof child === "object") requestTreeAnnotationCategories(child);
  }
}

// Runs inside the verb's resource-loading phase (prepare), beside the font load and the image
// fetch: a resource like any other, loaded before the synchronous gate that decides everything
// about the document (mutation-lock.ts). Resolve all names before creating any, so an ambiguous
// name refuses without having created a category for an earlier one.
export async function resolveAnnotationCategories(): Promise<void> {
  if (!requestedCategories.size) return;
  const categories = await figma.annotations.getAnnotationCategoriesAsync();
  for (const name of requestedCategories) {
    const matches = categories.filter((category) => category.label.trim() === name);
    if (matches.length > 1) {
      throw new FlcmError("authoring", `annotation category ${JSON.stringify(name)} is ambiguous: this file has ${matches.length} categories with that name (${matches.map((category) => `${JSON.stringify(category.label)} (${category.id})`).join(", ")}). Rename the duplicates in Figma, or pick another category name.`);
    }
    if (matches.length) resolvedCategories.set(name, matches[0].id);
  }
  for (const name of requestedCategories) {
    if (resolvedCategories.has(name)) continue;
    const category = await figma.annotations.addAnnotationCategoryAsync({ label: name, color: "violet" });
    createdCategories.push(category);
    resolvedCategories.set(name, category.id);
  }
}

/**
 * The failed verb's cleanup: every category this verb created goes away, whether the verb died in
 * prepare (a later validation) or inside the sealed apply span. Category creation is NOT in Figma's
 * undo stack (live-verified), so the rollback that erases the verb's writes cannot erase these.
 *
 * Returns the verb's OWN failure, which is what the agent must see — a category that refuses to be
 * removed is a leftover empty category, not the reason the verb failed. Every removal is attempted
 * even after one throws, and the ones that failed ride along on the original error's reason so a
 * leftover is named rather than silently kept.
 */
export function removeFailedAnnotationCategories(cause: unknown): unknown {
  const unremoved: string[] = [];
  for (const category of createdCategories) {
    const label = category.label;
    try {
      category.remove();
    } catch (err) {
      unremoved.push(`${JSON.stringify(label)} (${describeFailure(err)})`);
    }
  }
  createdCategories = [];
  if (!unremoved.length) return cause;
  return appendToFailure(cause, `The exception is annotation categories this call created that could not be removed, so these are still in the file: ${unremoved.join(", ")}; delete them in Figma if unwanted.`);
}

/** The id a category name resolved to in this call's prepare. */
export function annotationCategoryId(category: string): string {
  const id = resolvedCategories.get(category);
  // prepare resolves every category the call names, so a miss here is flcm's own.
  if (!id) throw new FlcmError("internal", `annotation category ${JSON.stringify(category)} was never looked up before it was used.`);
  return id;
}

export function applyAnnotations(node: SceneNode, annotations: readonly WriteAnnotation[] | undefined): void {
  if (annotations === undefined) return;
  if (!("annotations" in node)) {
    throw new FlcmError("figma", "Figma doesn't allow annotations on this type of layer. Drop annotations here, or annotate a parent frame.", {
      node: { type: node.type, name: node.name, id: node.id },
    });
  }
  node.annotations = annotations.map(({ text, category, properties }) => {
    const out: { labelMarkdown?: string; categoryId?: string; properties?: AnnotationProperty[] } = {};
    if (text !== undefined) out.labelMarkdown = text;
    if (category !== undefined) out.categoryId = annotationCategoryId(category);
    if (properties !== undefined) out.properties = properties.map((type) => ({ type }));
    return out;
  });
}

export async function readAnnotationCategoryNames(): Promise<ReadonlyMap<string, string>> {
  return new Map((await figma.annotations.getAnnotationCategoriesAsync()).map((category) => [category.id, category.label]));
}

