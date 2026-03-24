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
import { simplifyRawFigmaObject } from "../src/extractors/design-extractor.js";
import { allExtractors, collapseSvgContainers } from "../src/extractors/built-in.js";
import { getNodesProcessed } from "../src/extractors/node-walker.js";
import type { SimplifiedNode } from "../src/extractors/types.js";

const INPUT_PATH = resolve("logs/figma-raw.json");
const PROFILE_FLAG = process.argv.includes("--profile");

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

function countRawNodes(obj: unknown): number {
  if (!obj || typeof obj !== "object") return 0;
  const record = obj as Record<string, unknown>;
  let count = 0;

  // Count this node if it has an "id" and "type" (Figma node shape)
  if ("id" in record && "type" in record) {
    count = 1;
  }

  if ("children" in record && Array.isArray(record.children)) {
    for (const child of record.children) {
      count += countRawNodes(child);
    }
  }

  // GetFileNodesResponse wraps nodes in a { nodes: { "id": { document: ... } } } structure
  if ("nodes" in record && typeof record.nodes === "object" && record.nodes !== null) {
    for (const entry of Object.values(record.nodes as Record<string, unknown>)) {
      if (entry && typeof entry === "object" && "document" in (entry as Record<string, unknown>)) {
        count += countRawNodes((entry as Record<string, unknown>).document);
      }
    }
  }

  // GetFileResponse has document.children at the top level
  if ("document" in record && typeof record.document === "object") {
    count += countRawNodes(record.document);
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

  // --- CPU profiler setup ---
  let session: Session | undefined;
  if (PROFILE_FLAG) {
    session = new Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    console.log("CPU profiler started\n");
  }

  // --- Read input ---
  console.log(`Reading ${INPUT_PATH}...`);
  const rawJson = readFileSync(INPUT_PATH, "utf-8");
  const inputBytes = Buffer.byteLength(rawJson, "utf-8");
  const apiResponse = JSON.parse(rawJson);
  const inputNodeCount = countRawNodes(apiResponse);

  const memBefore = process.memoryUsage();

  // --- Simplification ---
  const simplifyStart = performance.now();
  const result = await simplifyRawFigmaObject(apiResponse, allExtractors, {
    afterChildren: collapseSvgContainers,
  });
  const simplifyMs = performance.now() - simplifyStart;

  const nodesProcessed = getNodesProcessed();
  const outputNodeCount = countOutputNodes(result.nodes);

  // --- YAML serialization ---
  const yamlStart = performance.now();
  const yamlOutput = yaml.dump(result);
  const yamlMs = performance.now() - yamlStart;
  const yamlBytes = Buffer.byteLength(yamlOutput, "utf-8");

  // --- JSON serialization ---
  const jsonStart = performance.now();
  const jsonOutput = JSON.stringify(result, null, 2);
  const jsonMs = performance.now() - jsonStart;
  const jsonBytes = Buffer.byteLength(jsonOutput, "utf-8");

  const memAfter = process.memoryUsage();

  // --- CPU profiler teardown ---
  if (session) {
    const { profile } = await session.post("Profiler.stop");
    const profilePath = resolve("logs/benchmark.cpuprofile");
    writeFileSync(profilePath, JSON.stringify(profile));
    console.log(`\nCPU profile written to ${profilePath}`);
    console.log("Open in Chrome DevTools → Performance tab → Load profile\n");
    session.disconnect();
  }

  // --- Report ---
  const peakRss = Math.max(memBefore.rss, memAfter.rss);
  const rssGrowth = memAfter.rss - memBefore.rss;
  const rssGrowthStr =
    rssGrowth < 0 ? `-${formatBytes(Math.abs(rssGrowth))}` : `+${formatBytes(rssGrowth)}`;

  console.log("\n┌─────────────────────────────────────────────┐");
  console.log("│          Simplification Benchmark           │");
  console.log("├─────────────────────────┬───────────────────┤");
  console.log(`│ Input file size         │ ${formatBytes(inputBytes).padStart(17)} │`);
  console.log(`│ Input nodes (raw)       │ ${String(inputNodeCount).padStart(17)} │`);
  console.log(`│ Nodes walked            │ ${String(nodesProcessed).padStart(17)} │`);
  console.log(`│ Output nodes            │ ${String(outputNodeCount).padStart(17)} │`);
  console.log("├─────────────────────────┼───────────────────┤");
  console.log(`│ Simplification time     │ ${formatMs(simplifyMs).padStart(17)} │`);
  console.log(`│ YAML serialization      │ ${formatMs(yamlMs).padStart(17)} │`);
  console.log(`│ JSON serialization      │ ${formatMs(jsonMs).padStart(17)} │`);
  console.log("├─────────────────────────┼───────────────────┤");
  console.log(`│ YAML output size        │ ${formatBytes(yamlBytes).padStart(17)} │`);
  console.log(`│ JSON output size        │ ${formatBytes(jsonBytes).padStart(17)} │`);
  console.log("├─────────────────────────┼───────────────────┤");
  console.log(`│ Peak RSS                │ ${formatBytes(peakRss).padStart(17)} │`);
  console.log(`│ RSS growth              │ ${rssGrowthStr.padStart(17)} │`);
  console.log(`│ Heap used (after)       │ ${formatBytes(memAfter.heapUsed).padStart(17)} │`);
  console.log("└─────────────────────────┴───────────────────┘");
}

main();
