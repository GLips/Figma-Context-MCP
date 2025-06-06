# Release Guide

This project uses [Changesets](https://github.com/changesets/changesets) for automated versioning and publishing, with separate workflows for stable releases (main branch) and beta releases (beta branch).

## Main Branch Releases (Stable)

1. **Create feature branch from main**:

   ```bash
   git checkout main
   git pull
   git checkout -b feature/my-feature
   ```

2. **Make your changes and add changeset**:

   ```bash
   # ... implement your feature ...
   pnpm changeset  # Describe your changes and semver impact
   git push
   ```

3. **Create PR to main**: Include the changeset in your PR

4. **After PR is merged**: The GitHub Action automatically handles versioning and publishing

### Why This Works

- Changesets are created per-PR, ensuring each feature gets proper changelog entries
- Automated workflow handles the complexity of versioning and publishing
- Clean, linear history on main branch

## Beta Branch Releases (Testing)

> **Note**: Beta release instructions are primarily for repo owner use. Contributors should use the main branch release instructions.

1. **Create feature branch and implement**:

   ```bash
   git checkout -b feature/experimental-thing
   # ... make changes (NO changeset yet) ...
   git commit -m "implement experimental feature"
   ```

2. **Merge to beta and add changeset there if needed**:

   > **Note**: Changesets are consumed during beta release, so creating them multiple times on feature branches would lead to duplicate changelog entries when merging to main.

   ```bash
   git checkout beta
   git merge feature/experimental-thing
   pnpm changeset  # Add changeset on beta branch
   git push  # Triggers automated beta release
   ```

3. **Keep beta updated with main**:

   ```bash
   git checkout beta
   git merge main  # Bring in latest stable changes
   ```

4. **When ready for stable release**:

   If a changeset already exists on the feature branch, it's ready to be merged into `main` once approved, otherwise:

   ```bash
   # Create PR from feature branch to main with changeset
   git checkout feature/experimental-thing
   pnpm changeset  # Create changeset for stable release
   git push
   # Then merge PR to main - automated release happens after merge
   ```

### Why Create Changesets on Beta Branch

- **Prevents duplicates**: Changesets are consumed during beta release, so creating them on feature branches would lead to duplicate changelog entries when merging to main
- **Better descriptions**: You can write changeset after the complete feature has been tested and refined in beta context

## Release Versions

### Stable Releases

- Published to npm with `latest` tag
- Follow semver: `1.2.3`
- Users install with: `npm install figma-developer-mcp`

### Beta Releases

- Published to npm with `beta` tag
- Follow semver with prerelease suffix: `1.2.3-beta.0`
- Users install with: `npm install figma-developer-mcp@beta`
