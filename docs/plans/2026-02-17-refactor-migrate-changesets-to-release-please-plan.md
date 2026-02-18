---
title: "refactor: Migrate from changesets to release-please"
type: refactor
status: active
date: 2026-02-17
---

# Migrate from Changesets to Release Please

Replace the current changesets-based release workflow with Google's release-please. Contributors don't run changesets today, and the maintainer already squash-merges PRs with conventional-ish commit messages. Release-please eliminates the manual changeset step entirely by deriving version bumps and changelogs from conventional commit prefixes on `main`.

## Background

**Current flow:**

1. Contributor opens PR (no changeset)
2. Maintainer manually creates `.changeset/*.md` file with bump level + description
3. Merge PR to `main`
4. `release.yml` runs `changesets/action@v1` which opens a "version packages" PR (#266 is currently open)
5. Merge that PR to publish to npm

**New flow:**

1. Contributor opens PR
2. Maintainer squash-merges with conventional commit message (`fix:`, `feat:`, `feat!:`)
3. Release-please automatically maintains an open release PR with accumulated changelog + version bump
4. Merge the release PR when ready to cut a release — npm publish happens automatically

## Acceptance Criteria

- [x] Changesets fully removed (deps, config, scripts, workflow files, helper scripts)
- [x] release-please GitHub Action runs on push to `main`
- [ ] Release PR is auto-created/updated with changelog entries from conventional commits
- [ ] Merging the release PR triggers npm publish + GitHub release creation
- [x] CONTRIBUTING.md documents the conventional commit format for the maintainer's squash-merge workflow
- [x] Existing CHANGELOG.md is preserved (release-please appends to it going forward)
- [ ] Changeset release PR #266 closed (superseded by release-please)
- [x] `/release` Claude Code command created for managing releases via `gh` CLI

## Files to Remove

| File                                 | Reason                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `.changeset/config.json`             | Changesets config                                                             |
| `.changeset/README.md`               | Changesets boilerplate                                                        |
| `.changeset/brave-dogs-travel.md`    | Pending changeset (superseded — the host config feature is already on `main`) |
| `.github/workflows/release.yml`      | Current changesets release workflow (replaced)                                |
| `.github/workflows/beta-release.yml` | Current changesets beta workflow (replaced or deferred)                       |
| `.github/changeset-version.js`       | Helper script for changesets                                                  |
| `.github/changeset-beta-version.js`  | Helper script for beta changesets                                             |

## Files to Create

### `.github/workflows/release.yml`

New release-please workflow. Single job that:

1. Runs release-please action on push to `main`
2. If a release was created, checks out code, builds, and publishes to npm

```yaml
on:
  push:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write
  id-token: write # Required for npm OIDC trusted publishing

name: Release

jobs:
  release-please:
    if: ${{ github.repository_owner == 'GLips' }}
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          release-type: node

      - uses: actions/checkout@v4
        if: ${{ steps.release.outputs.release_created }}

      - uses: pnpm/action-setup@v4
        with:
          version: 10.10.0
        if: ${{ steps.release.outputs.release_created }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: "https://registry.npmjs.org"
        if: ${{ steps.release.outputs.release_created }}

      - name: Install dependencies
        run: pnpm install
        if: ${{ steps.release.outputs.release_created }}

      - name: Type check
        run: pnpm type-check
        if: ${{ steps.release.outputs.release_created }}

      - name: Build
        run: pnpm build
        if: ${{ steps.release.outputs.release_created }}

      - name: Publish to npm
        run: pnpm publish --no-git-checks
        env:
          NODE_ENV: production
        if: ${{ steps.release.outputs.release_created }}
```

Notes:

- Uses Node 22 (required for npm OIDC trusted publishing, which needs npm CLI 11.5.1+ / Node 22.14.0+).
- `id-token: write` permission enables OIDC — npm proves the publish came from this repo without any stored tokens.
- `NODE_AUTH_TOKEN` is deliberately NOT set — its presence would prevent npm from falling back to OIDC.
- Does NOT use the composite `.github/actions/setup` because that pins Node 20, which is too old for OIDC. Inlines the setup steps instead.
- Provenance attestations are generated automatically with trusted publishing.
- **Pre-requisite:** Configure the trust relationship on npmjs.com (package settings → Trusted Publishers → add `GLips/Figma-Context-MCP` repo + `release.yml` workflow).

### `.release-please-manifest.json`

Tells release-please the current version so it knows where to start.

```json
{
  ".": "0.6.4"
}
```

### `release-please-config.json`

```json
{
  "packages": {
    ".": {
      "release-type": "node",
      "changelog-path": "CHANGELOG.md",
      "bump-minor-pre-major": true
    }
  }
}
```

### `.claude/commands/release.md`

A slash command the maintainer runs to review and cut a release. Walks through the release-please PR, shows what's pending, and merges when ready.

```markdown
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
   Run `gh pr merge <number> --merge --repo GLips/Figma-Context-MCP`

   Squash or merge commit both work — release-please handles either.

5. **Verify:**
   Run `gh run list --repo GLips/Figma-Context-MCP --limit 1` to confirm the Release workflow triggered.
   Report the workflow run URL so the user can monitor npm publish.
```

## Files to Modify

### `package.json`

**Remove devDependencies:**

- `@changesets/changelog-github`
- `@changesets/cli`

**Remove scripts:**

- `changeset`
- `version`
- `beta:start`
- `beta:end`
- `beta:version`
- `beta:publish`
- `release`

**Also remove scripts** that are now dead paths:

- `prerelease` (was a pre-hook for `release`, which is being removed)
- `pub:release` / `pub:release:beta` (manual npm publish — releases now go through the GitHub Action exclusively)

### `CONTRIBUTING.md`

Update the "Commit Messages" section (`CONTRIBUTING.md:149-153`) to document conventional commits as a requirement for squash-merge messages. Current text is vague ("Follow conventional commit format when possible"). Replace with clear guidance:

```markdown
### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) to automate versioning and changelog generation. The maintainer applies the correct prefix when squash-merging your PR — you don't need to worry about this in your individual commits.

For reference, these prefixes determine version bumps:

- `fix: <description>` — patch release (0.6.4 → 0.6.5)
- `feat: <description>` — minor release (0.6.4 → 0.7.0)
- `feat!: <description>` or `BREAKING CHANGE:` footer — major release (0.6.4 → 1.0.0)
- `chore:`, `docs:`, `test:`, `refactor:` — no release triggered
```

### `CLAUDE.md`

Add a brief note in the Build & Development Commands section about the release workflow so AI agents understand the process:

```markdown
### Releasing

Releases are automated via [release-please](https://github.com/googleapis/release-please). On merge to `main`, release-please reads conventional commit prefixes (`fix:`, `feat:`, `feat!:`) and maintains a release PR. Merging the release PR publishes to npm.
```

## Decisions & Open Questions

### Beta releases

The current `beta-release.yml` workflow supports a `beta` branch with changeset pre-releases. Options:

1. **Defer beta support** — Remove `beta-release.yml` now, re-add later if needed using release-please's `prerelease-type` config. This is simpler and avoids building something that may not be used.
2. **Migrate beta too** — Add a second release-please config for the `beta` branch with `prerelease-type: beta`.

**Recommendation:** Defer. The beta workflow was last used for v0.2.2-beta. If beta releases become needed again, release-please supports them via config.

### Existing CHANGELOG.md format

Changesets uses `### Patch Changes` / `### Minor Changes` headings. Release-please uses `### Bug Fixes` / `### Features`. The formats are different but both are valid markdown. Release-please will append new entries in its own format above the existing content. No migration of old entries needed.

### GitHub token (for release-please PR creation)

The workflow uses `GITHUB_TOKEN` (implicit) for release-please to create/update the release PR. Release-please docs recommend a PAT so the release PR merge triggers downstream CI. Using `GITHUB_TOKEN` means CI won't run on the release PR's commits — but if branch protection requires checks, this could block merging.

**Recommendation:** Start with `GITHUB_TOKEN`. If branch protection blocks the release PR, switch to a PAT or GitHub App token.

### npm authentication

npm revoked all classic tokens on Dec 9, 2025. The repo's `NPM_ACCESS_TOKEN` secret is likely dead. The workflow now uses OIDC trusted publishing instead — no tokens needed.

**Pre-requisite (manual, one-time):** Go to npmjs.com → `figma-developer-mcp` package settings → Trusted Publishers → add:

- Repository: `GLips/Figma-Context-MCP`
- Workflow: `release.yml`

After this is configured, the `NPM_ACCESS_TOKEN` secret can be deleted from the repo's GitHub settings.

## Implementation Order

0. ~~Configure trusted publisher on npmjs.com~~ ✅ Done
1. Remove `.changeset/` directory (3 files)
2. Remove `.github/changeset-version.js` and `.github/changeset-beta-version.js`
3. Remove `.github/workflows/beta-release.yml`
4. Replace `.github/workflows/release.yml` with release-please workflow
5. Create `.release-please-manifest.json` and `release-please-config.json`
6. Update `package.json` (remove changeset deps and scripts)
7. Run `pnpm install` to update lockfile
8. Update `CONTRIBUTING.md` commit message section
9. Update `CLAUDE.md` with release workflow note
10. Create `.claude/commands/release.md` slash command
11. Close PR #266 on GitHub with explanatory comment (changesets replaced by release-please)

## References

- [release-please](https://github.com/googleapis/release-please)
- [release-please-action](https://github.com/googleapis/release-please-action)
- [Conventional Commits spec](https://www.conventionalcommits.org/en/v1.0.0/)
- Current release workflow: `.github/workflows/release.yml`
- Open changeset PR: #266
