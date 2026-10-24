/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// authored-words — the canonical address of every word a delta states, so every obligation names
// the word it was authored by the same way. A path is the top-level word ("fill"), a word inside a
// partial bag ("layout.gap", "textStyle.fontWeight"), or a word of an instance override
// (`overrides["Label"]`, `overrides["Label"].fill`).

/** Bags whose words are each a word of their own: a spread read with one word changed restates the rest. */
const PARTIAL_BAGS: ReadonlySet<string> = new Set(["layout", "textStyle", "componentProperties", "componentPropertyReferences"]);

function isBag(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The path of an override path's delta, or of one word inside it. */
export function overrideWordPath(path: string, word?: string): string {
  return "overrides[" + JSON.stringify(path) + "]" + (word === undefined ? "" : "." + word);
}

/** Every word path `delta` states. */
export function wordPathsOf(delta: Readonly<Record<string, unknown>>, prefix = ""): Set<string> {
  const paths = new Set<string>();
  for (const [word, value] of Object.entries(delta)) {
    if (value === undefined) continue;
    if (word === "overrides" && !prefix && isBag(value)) {
      for (const [path, override] of Object.entries(value)) {
        paths.add(overrideWordPath(path));
        if (isBag(override)) for (const inner of wordPathsOf(override, overrideWordPath(path) + ".")) paths.add(inner);
      }
      continue;
    }
    if (PARTIAL_BAGS.has(word) && isBag(value) && Object.keys(value).length) {
      for (const inner of Object.keys(value)) if (value[inner] !== undefined) paths.add(prefix + word + "." + inner);
      continue;
    }
    paths.add(prefix + word);
  }
  return paths;
}
