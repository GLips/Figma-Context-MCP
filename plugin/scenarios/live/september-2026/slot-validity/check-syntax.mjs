/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Parse scenario bodies without invoking them or providing a Figma/mock environment.
import { readFileSync, readdirSync } from "node:fs";
const directory = new URL("./", import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const files = readdirSync(directory).filter((name) => /^\d\d-.*\.js$/.test(name) || name === "archaeology-readback.js");
if (files.length !== 9) throw new Error(`Expected eight scenarios and one readback body, found ${files.length}`);
for (const file of files) {
  new AsyncFunction("flcm", "figma", readFileSync(new URL(file, directory), "utf8"));
  console.log(`${file}: syntax only; this check performs no execution`);
}
