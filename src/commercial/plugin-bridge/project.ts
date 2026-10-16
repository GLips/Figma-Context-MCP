/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { realpathSync } from "node:fs";

/**
 * The project this server acts for: its working directory, resolved through symlinks. A plugin
 * grant names it, so every server started in one project shares that project's grants, and a
 * symlinked path can't stand for a second project. A label the human recognizes, not a secret.
 */
export function canonicalProjectPath(cwd: string = process.cwd()): string {
  return realpathSync(cwd);
}
