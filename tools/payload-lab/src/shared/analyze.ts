import { sameSerializedMeaning } from "./serialization.js";
import {
  object,
  formats,
  type Obj,
  type Json,
  type TreeNode,
  type Change,
  type Replay,
  type Metrics,
  type Repetition,
  type Analysis,
  type Format,
} from "./model.js";

export function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const styleFields = new Set(["layout", "fills", "strokes", "effects", "textStyle"]);
export function tree(design: Obj, expand = true): TreeNode[] {
  const styles = object(design.styles ?? object(design.globalVars).styles),
    templates = object(design.templates ?? design.elements);
  const rows: TreeNode[] = [];
  function walk(nodes: Json, parent: string, depth: number) {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((value, index) => {
      const node = object(value);
      const body =
        expand && typeof node.template === "string" ? object(templates[node.template]) : {};
      const fields: Obj = { ...body, ...node };
      delete fields.children;
      if (expand) delete fields.template;
      for (const field of expand ? styleFields : []) {
        const ref = fields[field];
        if (typeof ref === "string" && Object.hasOwn(styles, ref)) fields[field] = styles[ref];
      }
      if (expand && Array.isArray(fields.text))
        fields.text = fields.text.map((run) => {
          if (!Array.isArray(run) || typeof run[1] !== "string" || !Object.hasOwn(styles, run[1]))
            return run;
          return [run[0], styles[run[1]]];
        });
      const id = typeof node.id === "string" ? node.id : `${parent}/${index}`;
      rows.push({ id, parent, index, depth, fields });
      walk(node.children ?? [], id, depth + 1);
    });
  }
  walk(design.nodes ?? [], "", 0);
  return rows;
}
function diffValue(
  before: Json | undefined,
  after: Json | undefined,
  path: string,
  changes: Change[],
  nodeId?: string,
) {
  if (
    before === after ||
    (before !== undefined && after !== undefined && stable(before) === stable(after))
  )
    return;
  if (before === undefined || after === undefined) {
    const present = before ?? after;
    if (
      present &&
      typeof present === "object" &&
      !Array.isArray(present) &&
      Object.keys(present).length
    ) {
      for (const key of Object.keys(present).sort())
        diffValue(
          before === undefined ? undefined : object(before)[key],
          after === undefined ? undefined : object(after)[key],
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          changes,
          nodeId,
        );
      return;
    }
    changes.push({ kind: before === undefined ? "added" : "removed", path, nodeId, before, after });
    return;
  }
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      diffValue(
        before[key],
        after[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        changes,
        nodeId,
      );
    }
  } else changes.push({ kind: "changed", path, nodeId, before, after });
}
export function changesBetween(left: Obj, right: Obj, expand = true): Change[] {
  const a = tree(left, expand),
    b = tree(right, expand),
    changes: Change[] = [];
  const am = new Map(a.map((n) => [n.id, n])),
    bm = new Map(b.map((n) => [n.id, n]));
  const previousCommon = (rows: TreeNode[], other: Map<string, TreeNode>) => {
    const previous = new Map<string, string>(),
      last = new Map<string, string>();
    for (const row of rows) {
      previous.set(row.id, last.get(row.parent) ?? "");
      if (other.get(row.id)?.parent === row.parent) last.set(row.parent, row.id);
    }
    return previous;
  };
  const priorA = previousCommon(a, bm),
    priorB = previousCommon(b, am);
  for (const id of new Set([...am.keys(), ...bm.keys()])) {
    const before = am.get(id),
      after = bm.get(id);
    if (!before || !after) {
      changes.push({
        kind: before ? "removed" : "added",
        nodeId: id,
        path: `/nodes/${id}`,
        before: before?.fields,
        after: after?.fields,
      });
      continue;
    }
    // Compare order among surviving siblings. An insertion alone doesn't move every following node.
    if (before.parent !== after.parent || priorA.get(id) !== priorB.get(id))
      changes.push({
        kind: "moved",
        nodeId: id,
        path: `/nodes/${id}`,
        before: { parent: before.parent, index: before.index },
        after: { parent: after.parent, index: after.index },
      });
    diffValue(before.fields, after.fields, `/nodes/${id}`, changes, id);
  }
  if (expand) diffValue(left.metadata, right.metadata, "/metadata", changes);
  else
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (key !== "nodes") diffValue(left[key], right[key], `/${key}`, changes);
    }
  return matchFieldMoves(changes);
}

// A field relocation is inferred only when one removed and one added leaf have
// the same name and value on the same node. Ambiguous matches stay added/removed.
function matchFieldMoves(changes: Change[]): Change[] {
  const groups = new Map<string, Change[]>();
  for (const change of changes) {
    if (
      !change.nodeId ||
      !["added", "removed"].includes(change.kind) ||
      change.path === `/nodes/${change.nodeId}`
    )
      continue;
    const value = change.kind === "added" ? change.after : change.before;
    const key = `${change.nodeId}|${change.path.split("/").at(-1)}|${stable(value!)}`;
    const group = groups.get(key) ?? [];
    group.push(change);
    groups.set(key, group);
  }
  const omitted = new Set<Change>(),
    replacements = new Map<Change, Change>();
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const removed = group.find((c) => c.kind === "removed"),
      added = group.find((c) => c.kind === "added");
    if (!removed || !added) continue;
    omitted.add(removed);
    replacements.set(added, {
      kind: "moved",
      nodeId: added.nodeId,
      path: added.path,
      before: { path: removed.path, value: removed.before! },
      after: { path: added.path, value: added.after! },
    });
  }
  return changes.filter((c) => !omitted.has(c)).map((c) => replacements.get(c) ?? c);
}

export function repetitions(design: Obj): Repetition[] {
  const found = new Map<string, Repetition>();
  function walk(value: Json, path: string) {
    if (typeof value === "string" && value.length >= 4) {
      const entry = found.get(value) ?? { value, paths: [], occurrences: 0, repeatedBytes: 0 };
      entry.paths.push(path);
      entry.occurrences++;
      entry.repeatedBytes = new TextEncoder().encode(value).length * (entry.occurrences - 1);
      found.set(value, entry);
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}/${i}`));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([k, v]) => walk(v, `${path}/${k}`));
  }
  walk(design, "");
  return [...found.values()]
    .filter((r) => r.occurrences > 1)
    .sort(
      (a, b) => b.repeatedBytes - a.repeatedBytes || String(a.value).localeCompare(String(b.value)),
    );
}
function metrics(replay: Replay, format: Format): Metrics {
  const nodes = tree(replay.design),
    bytes = new TextEncoder().encode(replay.serialized[format]).length;
  const metadata = object(replay.design.metadata);
  const tableDefinitions = [
    ...Object.values(object(metadata.components)),
    ...Object.values(object(metadata.componentSets)),
  ].reduce<number>(
    (count, entry) => count + Object.keys(object(object(entry).propertyDefinitions)).length,
    0,
  );
  return {
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
    nodes: nodes.length,
    maxDepth: nodes.reduce((n, row) => Math.max(n, row.depth), 0),
    components: Object.keys(object(metadata.components)).length,
    properties: nodes.reduce(
      (n, row) =>
        n +
        Object.keys(object(row.fields.componentProperties)).length +
        Object.keys(object(row.fields.propertyDefinitions)).length,
      tableDefinitions,
    ),
    simplifyMs: replay.timings.simplifyMs,
    serializeMs: replay.timings.serializeMs[format],
  };
}
export function analyze(baseline: Replay, candidate: Replay): Analysis {
  const changes = changesBetween(baseline.design, candidate.design);
  const emittedChanges = changesBetween(baseline.design, candidate.design, false);
  const sameStructure = stable(baseline.design) === stable(candidate.design);
  const metricsByFormat = {} as Analysis["metrics"],
    serialization = {} as Analysis["serialization"];
  for (const format of formats) {
    metricsByFormat[format] = {
      baseline: metrics(baseline, format),
      candidate: metrics(candidate, format),
    };
    serialization[format] =
      baseline.serialized[format] === candidate.serialized[format]
        ? "identical"
        : sameSerializedMeaning(baseline.serialized[format], candidate.serialized[format], format)
          ? "formatting-only"
          : changes.length || sameStructure
            ? "semantic"
            : "representation-only";
  }
  return {
    changes,
    emittedChanges,
    baselineNodes: tree(baseline.design),
    candidateNodes: tree(candidate.design),
    metrics: metricsByFormat,
    serialization,
    repetitions: {
      baseline: repetitions(baseline.design),
      candidate: repetitions(candidate.design),
    },
  };
}
