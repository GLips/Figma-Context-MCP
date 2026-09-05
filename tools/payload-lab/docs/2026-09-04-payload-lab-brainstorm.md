---
date: 2026-09-04
topic: payload-lab
status: agreed-v1
---

# Figma payload lab

## What we're building

A minimal, dev-only UI for inspecting how changes to Figma MCP affect the data an LLM receives. Paste a Figma URL, capture the live REST response once, and replay that exact input through a baseline revision and the current working tree. Inspect changes to meaning, structure, duplication, and output cost without repeatedly fetching the design.

This document records the agreed V1. Implementation and its detailed plan are separate work.

## Why this approach

The generic MCP Inspector can exercise tools, but it does not provide the focused comparison needed to review this project's simplification and serialization pipeline. A dedicated UI can connect a changed output field to its input and show whether the same fact appears elsewhere in the response.

Live captures are the source of truth. Golden fixtures remain useful regression context, but agents author and update them alongside format changes, so agreement with a golden cannot establish fidelity by itself. Confidence comes from captures the maintainer has personally checked against the live design.

Capturing once holds the input constant while code changes. Keeping the candidate fixed to the working tree makes the common development loop simple. Deterministic analysis gives inspectable evidence without model calls or a model-generated quality score.

## Key decisions

- Use a private workspace package, recommended at `tools/payload-lab`, with a Hono backend bound only to localhost and a React + Vite UI. Build a maintainable foundation while keeping V1 narrow.
- Keep the lab outside the published product structurally. Production code must not import it; root production build entries must exclude it; published dependencies and files must exclude it; the production build must not build it. The implementation plan must include an assertion against the package/tarball contents, rather than relying only on `private: true` or convention.
- Use live Figma REST responses only in V1. Replay through the actual simplification and serialization paths of each code state so the comparison represents shipped output behavior.
- Store the raw REST response unchanged, with metadata in a separate record. Persist captures in a named local library under a gitignored data directory. Record source URL, file key, node IDs, capture time, and relevant request/API and file-version metadata available at capture time.
- Keep Figma credentials on the backend. Never put credentials in browser state, saved captures, or capture metadata.
- Candidate is always the current working tree, including uncommitted edits. One baseline selector offers `main`, merge-base, previous commit, a release tag, or a specific commit. Both runs consume the same stored capture. Record the resolved baseline commit and enough candidate/run metadata to identify the comparison.
- Support the product's actual `tree`, `json`, and `yaml` formats. Compare structured meaning separately from serialization so whitespace or formatting changes are visible without being reported as semantic changes.

## V1 user flow

1. Start the lab locally and paste a Figma file or node URL.
2. Capture the response through the backend, name it, and save it in the local library. The maintainer verifies the captured design against Figma. Reopening a capture does not refetch it.
3. Choose a baseline. Replay the capture through that revision and the current working tree using equivalent output options.
4. Inspect synchronized views of the rendered/simplified tree, structural diff, exact serialized output, and metrics. Selecting a node or field should carry that selection across views, reveal the corresponding raw input where traceable, and help locate repeated or equivalent facts elsewhere in the payload. Derived or compressed fields should be identified as such rather than implying a direct raw-field mapping.
5. Edit the working tree and replay the same capture. Fetch again only through an explicit capture action, preserving the previous capture for comparison.

The tree view is an inspection aid for the emitted representation, not a requirement to build a pixel-perfect Figma renderer.

## Deterministic analysis

Show the following for each side and the difference between them:

- Added, removed, changed, and moved fields or nodes, with formatting-only churn distinguished from structural changes.
- Repeated-value and duplication heuristics, including occurrences in component metadata, templates, and style tables. Show the occurrences behind a flag; repetition alone does not prove that a fact is unnecessary.
- Serialized byte sizes and estimated token counts for the selected output format. Label token estimates with the estimator used.
- Node counts, maximum depth, component counts, and property counts, with clear definitions so comparisons remain meaningful.
- Simplification and serialization timings. Treat timings as measurements that may vary between runs, rather than deterministic proof of a performance regression.

V1 makes no model calls. Heuristics can identify candidate redundancy; the maintainer decides whether removing it would weaken model comprehension or useful semantics.

## Privacy and runtime boundaries

Bind only to localhost. Captures may contain private design data and must remain in gitignored local storage. The backend owns credentials and performs the explicit Figma capture. Replay and analysis must work locally without telemetry or network requests; runtime network activity is limited to the capture the user requested. Reusing product code must not accidentally enable its telemetry during replay.

## Explicit non-goals

- Plugin/code-mode payload capture or comparison.
- Arbitrary two-sided ref comparison or a history slider.
- Model calls, automated semantic judgments, or an LLM quality score.
- Replacing the generic MCP Inspector or making golden fixtures the authority.
- Hosted access, sharing, collaboration, or shipping the lab in the live/published bundle.
- Implementing payload optimizations as part of the inspection tool itself.

## Open questions for the implementation plan

- How should isolated revision runners load each revision's dependencies and invoke its real pipeline without changing the working tree? Define supported historical revisions and visible handling of incompatible pipeline contracts.
- What exactly does merge-base resolve against, and what is the default baseline? Show resolved commits so selection is unambiguous.
- Which ignored data path, capture schema version, and naming/deletion rules should the library use? Preserve raw response bytes separately from metadata and derived results.
- Which local token estimator and version should be used? Define count semantics and how unsupported formats in older revisions are shown.
- How much source-field tracing can V1 obtain from existing pipeline stages? Define reliable node matching and move detection, including nodes collapsed into SVGs or template references, and mark heuristic matches.
- How will a run identify the working-tree state and handle edits made while it runs? Results should make stale comparisons apparent.

These questions refine implementation mechanics. They do not reopen the agreed capture/replay workflow or expand V1 scope.
