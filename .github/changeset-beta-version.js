// BASED ON CREATE-T3-APP APPROACH:
// https://github.com/t3-oss/create-t3-app/blob/main/.github/changeset-version.js

import { execSync } from "child_process";

// This script is used by the `beta-release.yml` workflow to update the version of packages for beta releases.
// It enters prerelease mode, runs changeset version, and updates the package-lock.json file.
// This ensures beta releases are properly tagged and don't interfere with main releases.

// Enter prerelease mode for beta
execSync("pnpm exec changeset pre enter beta");
// Version the packages
execSync("pnpm exec changeset version");
// Update lockfile
execSync("pnpm install --lockfile-only");
