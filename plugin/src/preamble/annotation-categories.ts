import type { WriteNode } from "./ir.js";
import type { WriteAnnotation } from "./annotations.js";

// The mutation queue owns this per-verb state. Constructors never enqueue work.
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
  requestAnnotationCategories(tree.annotations);
  for (const child of tree.children ?? []) {
    if (child && typeof child === "object") requestTreeAnnotationCategories(child);
  }
}

export function hasRequestedAnnotationCategories(): boolean {
  return requestedCategories.size > 0;
}

// Run only after the entire verb's prepare succeeds. Resolve all names before creating any.
export async function resolveAnnotationCategories(): Promise<void> {
  if (!requestedCategories.size) return;
  const categories = await figma.annotations.getAnnotationCategoriesAsync();
  for (const name of requestedCategories) {
    const matches = categories.filter((category) => category.label.trim() === name);
    if (matches.length > 1) {
      throw new Error(`flcm.annotations: category ${JSON.stringify(name)} is ambiguous: ${matches.map((category) => `${JSON.stringify(category.label)} (${category.id})`).join(", ")}. Rename the duplicate categories.`);
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

export function removeFailedAnnotationCategories(): void {
  for (const category of createdCategories) category.remove();
}

export function applyAnnotations(node: SceneNode, annotations: readonly WriteAnnotation[] | undefined): void {
  if (annotations === undefined) return;
  if (!("annotations" in node)) throw new Error(`flcm.annotations: ${node.type} cannot carry annotations.`);
  node.annotations = annotations.map(({ text, category, properties }) => {
    const out: { labelMarkdown?: string; categoryId?: string; properties?: AnnotationProperty[] } = {};
    if (text !== undefined) out.labelMarkdown = text;
    if (category !== undefined) {
      const id = resolvedCategories.get(category);
      if (!id) throw new Error(`flcm.annotations: unresolved category ${JSON.stringify(category)}.`);
      out.categoryId = id;
    }
    if (properties !== undefined) out.properties = properties.map((type) => ({ type }));
    return out;
  });
}

export async function readAnnotationCategoryNames(): Promise<ReadonlyMap<string, string>> {
  return new Map((await figma.annotations.getAnnotationCategoriesAsync()).map((category) => [category.id, category.label]));
}

