/** pnpm tsx src/tests/goldens/verify-marker-only.ts [baseline commit] */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { GOLDEN_FIXTURES } from "./fixtures.js";
import { runFixture, serializeGolden } from "./harness.js";

function withoutMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMarkers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "elided")
      .map(([key, item]) => [key, withoutMarkers(item)]),
  );
}
const base = process.argv[2] ?? "0a76043";
for (const fixture of GOLDEN_FIXTURES) {
  const before = execFileSync(
    "git",
    ["show", `${base}:src/tests/goldens/expected/${fixture.name}.json`],
    { encoding: "utf8" },
  );
  const after = serializeGolden(
    withoutMarkers(await runFixture(fixture)) as Awaited<ReturnType<typeof runFixture>>,
  );
  assert.equal(after, before, `${fixture.name}: projection changed bytes beyond markers`);
}
console.log(
  `All ${GOLDEN_FIXTURES.length} goldens preserve baseline bytes after removing markers.`,
);
