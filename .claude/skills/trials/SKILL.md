---
name: trials
description: Run a naive-agent design trial in Figma against the framelink MCP, interview the agent about friction, and write a triage-ready report — or render a Figma read as HTML.
argument-hint: [<trial> [--craft] [--model m] | <figma-url>]
disable-model-invocation: true
---

# Trials

A checklist only asks questions we already thought of. A trial hands a **naive agent** — fresh context, a brief a normal user would type, the framelink MCP and nothing else — a design job, watches it work, then interviews it about where the tools fought it. The interview is fixed so rounds compare over months; the report is the deliverable of a run. **A round that finds nothing is the signal to stop that trial.**

Every run is **ergo** (find friction) unless `--craft` (find the design ceiling: same brief plus "best work, iterate, two or three variations"; Graham judges the page against the trial's rubric).

## Invariants

- **The agent stays naive.** Nothing in a brief, follow-up, or interview names flcm, a tool, or how to use one. If you find yourself explaining the tools to the trial agent, the trial is measuring you.
- **It runs in the scratch dir** `~/.framelink/trials/` — outside every repo, so it can't read the plugin source or schema, with a `.mcp.json` that has only the framelink server. `trials init` writes it; Graham trusts it once.
- **One trials file, a new page per run.** The page name is in the prompt; read/edit trials point at a page a prior run (or a designer) made.
- **The runner is `sq`.** Spawning, waiting, sending, reading all go through the sidequest CLI; this skill owns trial definitions, the interview, and the report.

## The CLI

`trials` (`bun link` from this skill's dir puts it on PATH; `trials --help` is the flag list): `list`, `run <trial> [--craft] [--model m]`, `interview <slug>`, `report <slug>`, `init`. Runs, prime files, and reports land in the repo's gitignored `trials/` (`runs/`, `reports/`). Trial definitions live in [`definitions/`](definitions/); the format is [`references/trial-format.md`](references/trial-format.md).

## Dispatch

- **Bare** → `trials list`, show it, ask which trial to run.
- **A trial name** → _Running a trial_ below, passing `--craft` / `--model` through.
- **A Figma URL** → not a trial: fetch the node in _this_ session and render it as HTML. [`subcommands/render.md`](subcommands/render.md).

## Running a trial

1. `trials run <trial> [--craft] [--model m]` **in the background** (`run_in_background`) — it blocks for the build plus the interview, routinely 10–30 minutes, and fails fast if the plugin isn't connected or the scratch dir isn't trusted. Do nothing else with that session while it runs. If a run dies between build and report, `trials interview <slug>` and `trials report <slug>` pick it up from the run record.
2. When it returns, read the report it names. Then **triage**: every interview item goes under `### Fix now` or `### File a ticket` in the report — nothing stays unclassified.
   - _Fix now_: a rename, a default, a doc line, an error message — small enough to land before the next round.
   - _File a ticket_: needs design, touches the schema shape, or is one of the known fidelity-ceiling gaps. File it with `tk add` and put the ref in the report.
   - Don't take the agent's word for a bug: `sq tail <slug> --type tool_result` and check the error text before classifying it.
3. Craft run: tell Graham the page name so he can fill `## Verdict`.
4. `sq close <slug>` once the report is triaged; the transcript stays on disk.

Done when the report's Triage section classifies every interview item and each _file a ticket_ line carries a ticket ref.
