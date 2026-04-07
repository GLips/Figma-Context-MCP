#!/usr/bin/env node

/**
 * Scans files for hidden Unicode characters commonly used in:
 * - LLM prompt injection (tag characters encoding invisible instructions)
 * - Trojan Source attacks (BiDi overrides making code render differently than it executes)
 * - Supply-chain attacks via invisible payloads in source/config/docs
 *
 * Also detects markdown-specific side-channels (HTML comments, hidden reference
 * links) that are invisible when rendered but readable by AI tools.
 *
 * Usage:
 *   node scripts/scan-hidden-chars.mjs [file...]
 *   With no arguments, scans all tracked text files in the repo.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";


// ---------------------------------------------------------------------------
// Invisible / rendering-manipulating Unicode characters.
// Organized by attack vector. Each entry: [description, regex]
// ---------------------------------------------------------------------------
const PATTERNS = [
  // --- Primary prompt injection vector ---
  // Tag characters: U+E0000–E007F. Used in 2025-2026 attacks to encode entire
  // hidden prompts (each tag char maps to an ASCII char) invisible to reviewers.
  ["Tag character", /[\u{E0000}-\u{E007F}]/gu],
  // Variation Selectors Supplement: U+E0100–E01EF. Similar encoding potential.
  ["Variation selector supplement", /[\u{E0100}-\u{E01EF}]/gu],

  // --- Trojan Source attack vector ---
  // BiDi override/embedding/isolate characters. Make code render differently
  // than it executes — e.g., swapping the apparent order of operands.
  ["BiDi control character", /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g],

  // --- Zero-width characters: payload encoding ---
  // Hide text between visible characters, or encode Base64 via presence/absence.
  ["Zero-width space", /\u200B/g],
  ["Zero-width non-joiner", /\u200C/g],
  ["Zero-width joiner", /\u200D/g],
  ["Zero-width no-break space", /\uFEFF/g],
  ["Word joiner / invisible formatting", /[\u2060-\u2064]/g],

  // --- Other invisible characters ---
  // Each renders as nothing in most environments and can carry hidden payloads.
  ["Soft hyphen", /\u00AD/g],
  ["Combining grapheme joiner", /\u034F/g],
  ["Mongolian vowel separator", /\u180E/g],
  ["Hangul filler", /[\u115F\u1160\u3164\uFFA0]/g],
  ["Khmer inherent vowel", /[\u17B4\u17B5]/g],
  ["Line/paragraph separator", /[\u2028\u2029]/g],
  ["Interlinear annotation", /[\uFFF9-\uFFFB]/g],
];

// ---------------------------------------------------------------------------
// Markdown side-channel patterns.
// These are invisible when rendered (GitHub, VS Code preview) but parsed as
// raw text by AI tools that read repo context (Cursor, Copilot, etc.).
// ---------------------------------------------------------------------------
const MD_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

// HTML comments longer than this are suspicious — legitimate pragmas like
// <!-- prettier-ignore --> are short. Long comments can hide prompt injections
// that are invisible in rendered markdown.
const HTML_COMMENT_LENGTH_THRESHOLD = 80;

// Matches <!-- ... --> including multiline. Captures the comment body.
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;

// Hidden reference links used as markdown "comments":
//   [//]: # (hidden text here)
//   [//]: # "hidden text here"
// Invisible when rendered, but parsed by AI context scrapers.
const HIDDEN_REF_LINK_RE = /^\[\/\/\]: #\s*[\("](.*?)[\)"]\s*$/;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
let totalFindings = 0;

function isMarkdown(filepath) {
  const ext = filepath.slice(filepath.lastIndexOf("."));
  return MD_EXTENSIONS.has(ext.toLowerCase());
}

function scanFile(filepath) {
  let content;
  try {
    content = readFileSync(filepath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  const fileFindings = [];

  // --- Invisible Unicode character scan (all files) ---
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const reported = new Set();

    // Named patterns first — gives descriptive output for known attack vectors.
    for (const [name, pattern] of PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const codePoint = match[0]
          .codePointAt(0)
          .toString(16)
          .toUpperCase()
          .padStart(4, "0");

        // Allow BOM (U+FEFF) at the very start of a file — that's legitimate.
        if (codePoint === "FEFF" && lineIdx === 0 && match.index === 0) continue;

        reported.add(match.index);
        fileFindings.push({
          line: lineIdx + 1,
          col: match.index + 1,
          name,
          codePoint,
        });
      }
    }

    // Catch-all: \p{Cf} covers the entire Unicode "Format" category.
    // Catches any invisible format character not already matched above
    // (e.g., Arabic format chars, deprecated formatting, script-specific controls).
    const cfPattern = /\p{Cf}/gu;
    let cfMatch;
    while ((cfMatch = cfPattern.exec(line)) !== null) {
      if (reported.has(cfMatch.index)) continue;
      const codePoint = cfMatch[0]
        .codePointAt(0)
        .toString(16)
        .toUpperCase()
        .padStart(4, "0");
      if (codePoint === "FEFF" && lineIdx === 0 && cfMatch.index === 0) continue;

      fileFindings.push({
        line: lineIdx + 1,
        col: cfMatch.index + 1,
        name: "Unicode format character",
        codePoint,
      });
    }
  }

  // --- Markdown side-channel scan (.md files only) ---
  if (isMarkdown(filepath)) {
    // Check for long HTML comments (potential hidden instructions).
    HTML_COMMENT_RE.lastIndex = 0;
    let commentMatch;
    while ((commentMatch = HTML_COMMENT_RE.exec(content)) !== null) {
      const body = commentMatch[1].trim();
      if (body.length > HTML_COMMENT_LENGTH_THRESHOLD) {
        // Find the line number of the comment start.
        const upToMatch = content.slice(0, commentMatch.index);
        const lineNum = upToMatch.split("\n").length;
        fileFindings.push({
          line: lineNum,
          col: commentMatch.index - upToMatch.lastIndexOf("\n"),
          name: `Long HTML comment (${body.length} chars) — may hide prompt injection`,
        });
      }
    }

    // Check for hidden reference-link "comments".
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const refMatch = lines[lineIdx].match(HIDDEN_REF_LINK_RE);
      if (refMatch && refMatch[1].length > 0) {
        fileFindings.push({
          line: lineIdx + 1,
          col: 1,
          name: "Hidden reference link — invisible when rendered",
        });
      }
    }
  }

  if (fileFindings.length > 0) {
    totalFindings += fileFindings.length;
    for (const f of fileFindings) {
      const suffix = f.codePoint ? ` (U+${f.codePoint})` : "";
      console.error(`  ${filepath}:${f.line}:${f.col} — ${f.name}${suffix}`);
    }
  }
}

// Determine which files to scan.
let files = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

if (files.length === 0) {
  const extensions = "ts js mjs cjs json md yml yaml"
    .split(" ")
    .map((ext) => `'*.${ext}'`)
    .join(" ");
  const tracked = execSync(`git ls-files -- ${extensions}`, {
    encoding: "utf-8",
  });
  files = tracked.trim().split("\n").filter(Boolean);
}

for (const file of files) {
  scanFile(file);
}

if (totalFindings > 0) {
  console.error(
    `\n  Found ${totalFindings} hidden character(s) that may indicate prompt injection or Trojan Source attacks.`,
  );
  process.exit(1);
}
