import yaml from "js-yaml";

export function serializeResult(result: unknown, format: "yaml" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  // Output goes to LLMs, not human editors — optimize for speed over readability.
  // noRefs skips O(n²) reference detection; lineWidth:-1 skips line-folding;
  // JSON_SCHEMA reduces per-string implicit type checks.
  return yaml.dump(result, {
    noRefs: true,
    lineWidth: -1,
    noCompatMode: true,
    schema: yaml.JSON_SCHEMA,
  });
}
