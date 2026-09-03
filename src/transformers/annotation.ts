/**
 * Raw shape of a Dev Mode annotation as actually returned by the Figma REST
 * API. `@figma/rest-api-spec` publishes `AnnotationsTrait` as an empty
 * `object` (the field is undocumented in its generated types even though the
 * live API returns it), so we model the wire shape ourselves rather than
 * import it.
 */
export interface RawAnnotation {
  label?: string;
  labelMarkdown?: string;
  properties?: { type: string }[];
  categoryId?: string;
}

export function isAnnotationArray(val: unknown): val is RawAnnotation[] {
  return Array.isArray(val);
}

export interface SimplifiedAnnotation {
  // `labelMarkdown` supersedes `label` when both are present — same note,
  // richer formatting — so only one survives simplification.
  label?: string;
  properties?: string[];
  categoryId?: string;
}

/**
 * Simplify Dev Mode annotations to the note text (preferring the markdown
 * variant) plus the list of pinned property names. Drops entries that carry
 * neither, which the API shouldn't produce but costs nothing to guard.
 */
export function simplifyAnnotations(annotations: RawAnnotation[]): SimplifiedAnnotation[] {
  const result: SimplifiedAnnotation[] = [];
  for (const annotation of annotations) {
    const label = annotation.labelMarkdown ?? annotation.label;
    const properties = annotation.properties?.map((p) => p.type);
    if (!label && !properties?.length) continue;

    result.push({
      ...(label && { label }),
      ...(properties?.length && { properties }),
      ...(annotation.categoryId && { categoryId: annotation.categoryId }),
    });
  }
  return result;
}
