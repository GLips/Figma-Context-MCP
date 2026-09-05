import { load } from "js-yaml";
import type { Format } from "./model.js";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return JSON.stringify(value);
}
// Tree lines contain quoted text and JSON values. Ignore spacing between tokens,
// but preserve quoted text and line nesting. Unknown churn is never called whitespace.
function treeTokens(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      const tokens = line.match(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s"']+/g) ?? [];
      return `${indent}:${tokens.join("\u0000")}`;
    })
    .join("\n");
}
export function sameSerializedMeaning(left: string, right: string, format: Format): boolean {
  try {
    if (format === "json") return canonical(JSON.parse(left)) === canonical(JSON.parse(right));
    if (format === "yaml") return canonical(load(left)) === canonical(load(right));
    return treeTokens(left) === treeTokens(right);
  } catch {
    return false;
  }
}
