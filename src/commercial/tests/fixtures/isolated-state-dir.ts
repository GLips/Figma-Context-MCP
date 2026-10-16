/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// A vitest setup file: every test file gets its own Framelink state root, so nothing a test does by
// default — minting the plugin link credential, recording a plugin sighting — reaches the developer's
// real one. A test that wants its own dir still stubs FRAMELINK_STATE_DIR itself.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FRAMELINK_STATE_DIR = mkdtempSync(join(tmpdir(), "framelink-test-state-"));
