/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { copyDistributionLicenses, licenseBanner } from "../scripts/distribution-licenses.mjs";

// Figma's plugin sandbox loads a single classic script as `main`. Bundle code.ts into an IIFE so it
// runs there directly. Neither the agent's code NOR the flcm std-lib is bundled here — both travel
// from the server as raw strings and are eval'd at runtime (ADR-0010), which is what keeps a DSL
// change off the manual-re-import path. Only the host shell is built.
await esbuild.build({
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  platform: "browser",
  format: "iife",
  target: "es2017",
  logLevel: "info",
  banner: { js: licenseBanner },
  legalComments: "inline",
});

// A plugin's UI is one HTML document with no loadable siblings, so the relay iframe's script is bundled
// and inlined into it. Its own bundle: it shares only types with the host, and the protocol's values.
const ui = await esbuild.build({
  entryPoints: ["src/ui.ts"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2017",
  logLevel: "info",
  legalComments: "inline",
});
const UI_SCRIPT = "<script>/* UI_SCRIPT: build.mjs inlines the ui.ts bundle here */</script>";
const template = readFileSync(new URL("./src/ui.html", import.meta.url), "utf8");
if (!template.includes(UI_SCRIPT)) throw new Error("src/ui.html lost its UI_SCRIPT marker");
// A function replacement, so `$` sequences in the bundle are never read as replacement patterns.
writeFileSync(
  new URL("./dist/ui.html", import.meta.url),
  template.replace(UI_SCRIPT, () => `<script>\n${ui.outputFiles[0].text}</script>`),
);

copyDistributionLicenses(
  fileURLToPath(new URL("../", import.meta.url)),
  fileURLToPath(new URL("./dist/", import.meta.url)),
);

// Negative space, both deliberate: this build asserts nothing about the bundle afterwards.
//
// No zod check — the preamble isn't in here anymore, so grepping this output for it would be
// vacuous. It moved to the seam that PRODUCES the preamble (src/preamble/index.mjs).
//
// No `__flcmHost` check either. code.ts calls the std-lib factory positionally and never names that
// identifier; the wrapper that binds it and the bundle that reads it are both emitted by
// index.mjs, which asserts they agree. A grep here could only re-check one end of a seam whose ends
// no longer live apart.
