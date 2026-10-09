---
name: release-notes
description: Draft brand-voice GitHub Release notes from a release's commits + plan docs, get approval, and publish them to the Release body
argument-hint: "[optional: tag like v0.11.0; defaults to the latest published release]"
disable-model-invocation: true
allowed-tools: Bash(gh *), Bash(git *), Read, Glob, Grep
---

# Write marketing-quality release notes

Turn a release's mechanical, auto-generated changelog into curated, brand-voice GitHub Release
notes — drafted by you, approved by the user, then published to the GitHub Release body.

**Scope:** This only touches the **GitHub Release body**. `CHANGELOG.md` is owned by release-please
and stays mechanical — never edit it here.

## Step 0: Load the voice guide and recent examples

Read `docs/marketing/changelog-voice.md` in full. It defines the audience, voice, banned words, and
the exact structure. Everything you draft must follow it. If it's missing, stop and tell the user to
create it.

Then read the **previous 2–3 published release notes** in `docs/marketing/release-notes/` (newest
first by version — `ls docs/marketing/release-notes/`). The voice guide is the spec; these are the
worked examples. Use them to calibrate the _tone and length_ of what you draft — how long the intro
runs, how many highlights a typical release promotes, how terse the Fixes & polish list is — so a
new entry reads like it belongs in the series. Match the established rhythm; don't write notes that
are conspicuously longer or shorter than the recent norm without reason. If the directory is empty
(no notes published yet), skip this and rely on the voice guide alone.

## Step 1: Identify the target release

- If `$ARGUMENTS` contains a tag (e.g. `v0.11.0`), use it.
- Otherwise, default to the latest published release:
  !`gh release view --json tagName,url,publishedAt -q '.tagName + "  " + .url' 2>/dev/null || echo "no published release found"`

If there is **no** published release yet but a release PR is pending (`gh pr list --label
"autorelease: pending"`), tell the user: the GitHub Release doesn't exist until the release PR
merges and the workflow publishes it. Offer to draft from the pending PR now so it's ready to post
the moment the release goes live, but note it can only be _published_ to the Release after merge.

Confirm the resolved tag with the user before proceeding if it was inferred.

## Step 2: Gather raw material

Collect everything needed to write the _why_, not just the _what_:

1. **The auto-generated body (preserve this):**
   `gh release view <tag> --json body -q .body`
2. **The commit range:** find the previous tag with
   `git tag --sort=-v:refname | grep -A1 '^<tag>$' | tail -1`, then
   `git log <prevtag>..<tag> --no-merges --pretty='%h %s'`.
3. **PR context (the real source of benefit copy):** extract `#NNN` references from the body /
   commits and, for the feature-level ones, read titles + descriptions + author:
   `gh pr view <NNN> --json title,body,author,url`. Note external contributors (author login that
   isn't the maintainer) — they get credited.
4. **The "why" — dig until you find it.** Commit titles never explain _why_ a feature matters; the
   rationale lives elsewhere, and not every feature is documented the same way. For each notable
   feature, check these sources in order and use the first that yields a real motivation:

   a. **Plan / brainstorm docs** — search `docs/plans/completed/` and `docs/brainstorms/completed/`
   for a matching doc (by feature name or date); read its Problem / Motivation section. Richest
   source when it exists, but **many features won't have one.**
   b. **tk tickets** — the ticket tracker (prefix `fig`) holds the durable _what & why_ in each
   ticket's description. `tk list --json` to scan titles/descriptions, then `tk show <id>` for
   the full ticket + activity log. Tickets are often closed with `--commit <hash>`, so a commit
   in the release range may point straight to its ticket.
   c. **Claude Code session transcripts** — if neither has it, the feature was likely built in a
   session. Transcripts live in
   `~/.claude/projects/-Users-graham-Programming-figma-mcp/*.jsonl` (JSONL). Grep them for the
   feature name / PR number / key symbols to recover the original problem framing and design
   discussion: `grep -l "<feature keyword>" ~/.claude/projects/-Users-graham-Programming-figma-mcp/*.jsonl`,
   then read the matching messages. Slower — use only when a) and b) come up empty.

   If all three come up dry, fall back to the PR description and the diff itself, and ask the user
   for the motivation rather than inventing one. **Never fabricate a benefit you can't source.**

## Step 3: Draft the notes

Write the Release body following the structure in the voice guide:

- A 1–3 sentence intro capturing the through-line of the release.
- **1–4 promoted highlights** (`###` sections), each: pain → what changed → why it matters, with
  PR link(s) + contributor credit.
- A terse **Fixes & polish** list for everything that doesn't earn a paragraph.

**This is marketing — sell the benefit, not the diff.** The reader is a human you want excited
about what their agent can now do, not a reviewer reading the changeset. 99% of the time the code
detail is irrelevant to them. So:

- **Never name internal field names, config keys, enum values, or property shapes** in the prose
  (no `sizing: { horizontal: contextual }`, no `strokeAlign was dropped`, no `mode: "grid"`). Say
  what the user _gets_ in plain language ("the designs you request stay responsive"). The exact
  mechanism is what the linked PR is for.
- **Cut "Under the hood" lines** unless the mechanism is itself the selling point. They almost
  always drag the copy back into diff-speak.
- **Keep low-narrative items short.** A render-fidelity bullet is one plain-language clause about
  what's now correct ("Blur matches the design's strength") — not a paragraph reconstructing the
  bug.
- **Double-check every factual claim against the PR, not the commit title.** Don't assert a value
  was hardcoded, dropped, or set to a specific number unless the PR confirms it — an example in a
  PR is not a guarantee.
- The verbatim auto-generated changelog preserved inside a `<details><summary>Full technical
changelog</summary>` block at the bottom.

Be honest and specific. Tie features back to the core promise (more accurate one-shot
design-to-code, fewer round-trips) only where it's true. Obey the banned-words list.

## Step 4: Review with the user

Show the full drafted body inline. Ask the user to approve, edit, or request changes. Iterate until
they're happy. Do not publish anything unapproved.

## Step 5: Publish

On approval:

1. Save the final copy for the record (also lets us build a "recent releases" table later):
   write it to `docs/marketing/release-notes/<tag>.md`.
2. Update the live Release body — pipe the final markdown via a file or heredoc:
   `gh release edit <tag> --notes-file docs/marketing/release-notes/<tag>.md`
3. Confirm with the Release URL: `gh release view <tag> --json url -q .url`.

Report what was published and the URL. Remind the user that `CHANGELOG.md` was intentionally left
untouched (release-please owns it).
