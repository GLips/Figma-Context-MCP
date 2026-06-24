# Release

Review and publish a new release.

## Steps

1. **Check for a release-please PR:**
   Run `gh pr list --repo GLips/Figma-Context-MCP --label "autorelease: pending" --json number,title,url` to find the open release PR.

   If no release PR exists, inform the user: "No pending release PR. Release-please creates one automatically when conventional commits (`fix:`, `feat:`) land on `main`."

2. **Show what's in the release:**
   Run `gh pr view <number> --json body` to display the pending changelog and version bump. Summarize:

   - New version number
   - Number of features, fixes, and other changes
   - List of included commits

3. **Ask for confirmation:**
   Use AskUserQuestion: "Merge this release PR to publish v<version> to npm?"

   - **Merge and publish** — Proceed with merge
   - **Review diff first** — Show `gh pr diff <number>`
   - **Cancel** — Stop without merging

4. **Merge the release PR:**
   Run `gh pr merge <number> --rebase --repo GLips/Figma-Context-MCP` (or merge via the GitHub UI).

   **Use rebase, not squash.** Feature PRs are squash-merged (so each conventional-commit title,
   with its `(#NNN)`, feeds the changelog), but the release PR is the single `chore(main): release
X.Y.Z` commit release-please authored. Rebase replays it onto `main` verbatim — bot authorship,
   clean subject, no `(#NNN)`. Squash would rewrite all three and diverge from every prior release
   (check `git log` for `chore(main): release` commits — they're all single-parent, bot-authored,
   no PR suffix). Merging through the UI does the same thing.

5. **Verify:**
   Run `gh run list --repo GLips/Figma-Context-MCP --limit 1` to confirm the Release workflow triggered.
   Report the workflow run URL so the user can monitor npm publish.

   The Release workflow also bumps `server.json` and publishes to npm (OIDC) and the MCP registry —
   all hands-off. No manual steps beyond merging the PR.

6. **Write the curated release notes:**
   Once the workflow has published the GitHub Release (the tag exists), run `/release-notes` to
   replace the mechanical, auto-generated Release body with brand-voice highlights. release-please
   only produces a terse commit-title list; `/release-notes` turns it into something worth reading.
   `CHANGELOG.md` is left as-is — release-please owns it.
