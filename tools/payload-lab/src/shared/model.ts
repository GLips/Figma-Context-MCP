export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = { [key: string]: Json };
export const formats = ["tree", "yaml", "json"] as const;
export type Format = (typeof formats)[number];
export type Baseline = {
  kind: "main" | "merge-base" | "previous" | "tag" | "commit";
  ref?: string;
};
export interface Capture {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: "live" | "sample";
  capturedAt: string;
  sourceUrl: string;
  fileKey: string;
  nodeIds: string[];
  sha256: string;
  bytes: number;
  api: { endpoint: string; version: "v1"; fileVersion?: string; lastModified?: string };
}
export interface Replay {
  design: Obj;
  serialized: Record<Format, string>;
  timings: { simplifyMs: number; serializeMs: Record<Format, number> };
  revision: string;
  sourceHash: string;
  pipeline: string;
}
export interface Change {
  kind: "added" | "removed" | "changed" | "moved";
  nodeId?: string;
  path: string;
  before?: Json;
  after?: Json;
}
export interface TreeNode {
  id: string;
  parent: string;
  index: number;
  depth: number;
  fields: Obj;
}
export interface Metrics {
  bytes: number;
  estimatedTokens: number;
  nodes: number;
  maxDepth: number;
  components: number;
  properties: number;
  simplifyMs: number;
  serializeMs: number;
}
export interface Repetition {
  value: Json;
  paths: string[];
  occurrences: number;
  repeatedBytes: number;
}
export interface Analysis {
  changes: Change[];
  emittedChanges: Change[];
  baselineNodes: TreeNode[];
  candidateNodes: TreeNode[];
  metrics: Record<Format, { baseline: Metrics; candidate: Metrics }>;
  serialization: Record<
    Format,
    "identical" | "formatting-only" | "representation-only" | "semantic"
  >;
  repetitions: { baseline: Repetition[]; candidate: Repetition[] };
}
export interface Comparison {
  capture: Capture;
  baseline: Replay;
  candidate: Replay;
  analysis: Analysis;
  stale: boolean;
  comparedAt: string;
  warnings: string[];
  dependencyHash: string;
}
export function object(value: Json | undefined): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
