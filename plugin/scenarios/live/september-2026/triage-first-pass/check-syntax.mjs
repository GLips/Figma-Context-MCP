/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { readFileSync, readdirSync } from "node:fs";
const directory = new URL("./", import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const file of readdirSync(directory).filter(name => /^\d\d-.*\.js$/.test(name))) {
  new AsyncFunction("flcm", "figma", readFileSync(new URL(file, directory), "utf8"));
  console.log(`${file}: syntax only; no execution`);
}
