import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeCommercialManifest } from "./check-license-headers.mjs";

export const licenseFiles = [
  "LICENSE",
  "LICENSING.md",
  "licensing/LICENSE-Framelink-Commercial.md",
];

export const licenseBanner =
  "/*! Framelink licensing: see LICENSING.md alongside this artifact. Preserve component notices when redistributing. */";

export function copyDistributionLicenses(root, output) {
  // This generated subtree must not retain documents removed from the source set.
  rmSync(join(output, "licensing"), { recursive: true, force: true });
  for (const file of licenseFiles) {
    const destination = join(output, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, file), destination);
  }
  // Written here, after the wipe above, so no build can ship the documents without the manifest.
  writeCommercialManifest(root, output);
}
