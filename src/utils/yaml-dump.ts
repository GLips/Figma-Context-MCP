import yaml from "js-yaml";

// Output goes to LLMs, not human editors — optimize for speed over readability.
// noRefs skips O(n²) reference detection; lineWidth:-1 skips line-folding;
// JSON_SCHEMA reduces per-string implicit type checks.
export function dumpYaml(value: unknown): string {
  return yaml.dump(value, {
    noRefs: true,
    lineWidth: -1,
    noCompatMode: true,
    schema: yaml.JSON_SCHEMA,
  });
}
