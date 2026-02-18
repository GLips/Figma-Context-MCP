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
   Run `gh pr merge <number> --squash --repo GLips/Figma-Context-MCP`

5. **Verify:**
   Run `gh run list --repo GLips/Figma-Context-MCP --limit 1` to confirm the Release workflow triggered.
   Report the workflow run URL so the user can monitor npm publish.
