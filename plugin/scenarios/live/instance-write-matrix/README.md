# Instance write matrix

**Purpose.** The evidence behind every `INSTANCE_WRITE_RULES` entry and every `"allowed"` verdict in `plugin/src/preamble/instance-write-policy.ts`. `run.js` builds a Card component on a fresh page with these layers:

- a text
- an auto-layout row
- a free-form frame holding an ellipse, a vector, a group, a rotated rectangle and a free rectangle
- a nested variant instance
- a slot holding inherited content

It then writes each word straight through the raw Plugin API to a live instance of the Card. flcm is not involved, so each row is Figma's own answer.

**How to run.** Run it the same way as `../september-2026/instance-direction/01-direction-gate.js` (see that README): submit the whole file as one async execute body, against a scratch file. The script creates its own page and removes it in `finally`, whether it passed or failed, then returns to the page you were on.

**Reading the report.**

- `rows` are assertions. Each one names the rule it is evidence for: `rule: null` marks an `"allowed"` verdict. Each row also has `expect` (`ignored`, `throws` or `lands`), `got`, and `passed`. `before`/`after` show the read value, and `message` is Figma's error.
- `failed` lists the rows that did not pass, and `status` is `passed` only when there are none. Rows run in order on one instance, so an unexpected `lands` can change the layers seen by later rows. Read the first failure first.
- `probes` are open questions. They are recorded, never asserted:
  - Does a same-value `x` throw? flcm skips a word the layer already holds, so it never writes one.
  - Does a restated `layoutPositioning` `AUTO` throw?
  - Does `layoutSizingHorizontal` `FIXED` land without a px? The policy calls it allowed-unverified.

**Last verified:** 2026-10-23, Figma desktop, protocol v19 plugin: `passed`, 97 of 97 rows. Probes:

- A same-value `x` throws (`relative-transform`), and so does a restated `layoutPositioning` `AUTO` (`stack-positioning`). Inside an instance, even restating these words throws, so flcm never writes one: a word the layer already holds when flcm reaches it is skipped, and one it can't come to hold refuses the call.
- `layoutSizingHorizontal` `FIXED` without a px lands.

If a row fails on a later run, change that rule or verdict, not the row.
