/**
 * Benchmark script for the design simplification pipeline.
 *
 * Reads a raw Figma API response from logs/figma-raw.json and profiles
 * simplifyRawFigmaObject + serialization, reporting wall time, memory,
 * node counts, and output size.
 *
 * Usage:
 *   pnpm benchmark:simplify              # run benchmark
 *   pnpm benchmark:simplify --profile    # run with CPU profiler, writes .cpuprofile
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import yaml from "js-yaml";
import {
  simplifyRawFigmaObject,
  layoutExtractor,
  textExtractor,
  visualsExtractor,
  componentExtractor,
  collapseSvgContainers,
  getNodesProcessed,
} from "../src/extractors/index.js";
import type { ExtractorFn, SimplifiedNode } from "../src/extractors/index.js";

const INPUT_PATH = resolve("logs/figma-raw.json");
const PROFILE_FLAG = process.argv.includes("--profile");

interface ExtractorTiming {
  name: string;
  totalMs: number;
  calls: number;
}

function timedExtractor(fn: ExtractorFn, timing: ExtractorTiming): ExtractorFn {
  return (node, result, context) => {
    const start = performance.now();
    fn(node, result, context);
    timing.totalMs += performance.now() - start;
    timing.calls++;
  };
}

function countOutputNodes(nodes: SimplifiedNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count++;
    if (node.children) {
      count += countOutputNodes(node.children);
    }
  }
  return count;
}

/** Count objects with id+type fields recursively — rough estimate of Figma node count. */
function countRawNodes(obj: unknown): number {
  if (!obj || typeof obj !== "object") return 0;
  const record = obj as Record<string, unknown>;
  let count = 0;

  if ("id" in record && "type" in record) count = 1;

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) count += countRawNodes(item);
    } else if (value && typeof value === "object") {
      count += countRawNodes(value);
    }
  }

  return count;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function main() {
  if (!existsSync(INPUT_PATH)) {
    console.error(
      `Input file not found: ${INPUT_PATH}\n\n` +
        `Run the server in dev mode and fetch a Figma file first.\n` +
        `The server writes raw API responses to logs/figma-raw.json.`,
    );
    process.exit(1);
  }

  let session: Session | undefined;
  if (PROFILE_FLAG) {
    session = new Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    console.log("CPU profiler started\n");
  }

  console.log(`Reading ${INPUT_PATH}...`);
  const rawJson = readFileSync(INPUT_PATH, "utf-8");
  const inputBytes = Buffer.byteLength(rawJson, "utf-8");
  const apiResponse = JSON.parse(rawJson);
  const inputNodeCount = countRawNodes(apiResponse);

  const memBefore = process.memoryUsage();

  const extractorTimings: ExtractorTiming[] = [
    { name: "layout", totalMs: 0, calls: 0 },
    { name: "text", totalMs: 0, calls: 0 },
    { name: "visuals", totalMs: 0, calls: 0 },
    { name: "component", totalMs: 0, calls: 0 },
  ];

  const timedExtractors = [
    timedExtractor(layoutExtractor, extractorTimings[0]),
    timedExtractor(textExtractor, extractorTimings[1]),
    timedExtractor(visualsExtractor, extractorTimings[2]),
    timedExtractor(componentExtractor, extractorTimings[3]),
  ];

  const afterChildrenTiming = { totalMs: 0, calls: 0 };
  const timedAfterChildren: typeof collapseSvgContainers = (node, result, children) => {
    const start = performance.now();
    const out = collapseSvgContainers(node, result, children);
    afterChildrenTiming.totalMs += performance.now() - start;
    afterChildrenTiming.calls++;
    return out;
  };

  const simplifyStart = performance.now();
  const result = await simplifyRawFigmaObject(apiResponse, timedExtractors, {
    afterChildren: timedAfterChildren,
  });
  const simplifyMs = performance.now() - simplifyStart;

  const extractorTotal = extractorTimings.reduce((sum, t) => sum + t.totalMs, 0);
  const overhead = simplifyMs - extractorTotal - afterChildrenTiming.totalMs;

  const nodesProcessed = getNodesProcessed();
  const outputNodeCount = countOutputNodes(result.nodes);

  const yamlStart = performance.now();
  const yamlOutput = yaml.dump(result, {
    noRefs: true,
    lineWidth: -1,
    noCompatMode: true,
    schema: yaml.JSON_SCHEMA,
  });
  const yamlMs = performance.now() - yamlStart;
  const yamlBytes = Buffer.byteLength(yamlOutput, "utf-8");

  const jsonStart = performance.now();
  const jsonOutput = JSON.stringify(result, null, 2);
  const jsonMs = performance.now() - jsonStart;
  const jsonBytes = Buffer.byteLength(jsonOutput, "utf-8");

  const memAfter = process.memoryUsage();

  if (session) {
    const { profile } = await session.post("Profiler.stop");
    const profilePath = resolve("logs/benchmark.cpuprofile");
    writeFileSync(profilePath, JSON.stringify(profile));
    console.log(`\nCPU profile written to ${profilePath}`);
    console.log("Open in Chrome DevTools → Performance tab → Load profile\n");
    session.disconnect();
  }

  const maxRss = Math.max(memBefore.rss, memAfter.rss);
  const rssGrowth = memAfter.rss - memBefore.rss;
  const rssGrowthStr =
    rssGrowth < 0 ? `-${formatBytes(Math.abs(rssGrowth))}` : `+${formatBytes(rssGrowth)}`;

  const row = (label: string, value: string) =>
    console.log(`│ ${label.padEnd(23)} │ ${value.padStart(17)} │`);
  const separator = () => console.log("├─────────────────────────┼───────────────────┤");

  console.log("\n┌─────────────────────────────────────────────┐");
  console.log("│          Simplification Benchmark           │");
  separator();
  row("Input file size", formatBytes(inputBytes));
  row("Input nodes (raw)", String(inputNodeCount));
  row("Nodes walked", String(nodesProcessed));
  row("Output nodes", String(outputNodeCount));
  separator();
  row("Simplification time", formatMs(simplifyMs));
  for (const t of extractorTimings) {
    const pct = ((t.totalMs / simplifyMs) * 100).toFixed(1);
    row(`  ${t.name} extractor`, `${formatMs(t.totalMs)} (${pct}%)`);
  }
  const afterPct = ((afterChildrenTiming.totalMs / simplifyMs) * 100).toFixed(1);
  row("  afterChildren", `${formatMs(afterChildrenTiming.totalMs)} (${afterPct}%)`);
  const overheadPct = ((overhead / simplifyMs) * 100).toFixed(1);
  row("  overhead (walk+yield)", `${formatMs(overhead)} (${overheadPct}%)`);
  separator();
  row("YAML serialization", formatMs(yamlMs));
  row("JSON serialization", formatMs(jsonMs));
  separator();
  row("YAML output size", formatBytes(yamlBytes));
  row("JSON output size", formatBytes(jsonBytes));
  separator();
  row("RSS (max sampled)", formatBytes(maxRss));
  row("RSS growth", rssGrowthStr);
  row("Heap used (after)", formatBytes(memAfter.heapUsed));
  console.log("└─────────────────────────┴───────────────────┘");
}

main();
