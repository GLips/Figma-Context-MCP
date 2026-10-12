/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import vm from "node:vm";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";
import {
  MIN_PROTOCOL_VERSION,
  parsePeerVersion,
  refuseProtocolSkew,
} from "~/commercial/plugin-bridge/version.js";

// Every bridge fake reports MIN_PROTOCOL_VERSION as the plugin's version, so only the real plugin can
// catch a bump made on one side. The plugin is the one piece users can't update in step: a server
// whose MIN outruns it refuses every plugin built from the same commit.
it("the real plugin answers GET_VERSION with exactly the protocol this server requires", () => {
  const replies: Array<Record<string, unknown>> = [];
  const figma = {
    showUI() {},
    notify() {},
    clientStorage: { getAsync: async () => undefined, setAsync: async () => {} },
    ui: {
      resize() {},
      onmessage: (_inbound: Record<string, unknown>) => {},
      postMessage: (msg: Record<string, unknown>) => replies.push(msg),
    },
  };
  const code = buildSync({
    entryPoints: [new URL("../../../plugin/src/code.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    logLevel: "silent",
  }).outputFiles[0].text;
  vm.runInContext(
    code,
    vm.createContext({ figma, __html__: "", console, setTimeout, clearTimeout }),
  );

  figma.ui.onmessage({ from: "server", connKey: 1, frame: { id: "version", type: "GET_VERSION" } });
  const version = parsePeerVersion(replies.find((reply) => reply.id === "version"));

  expect(refuseProtocolSkew(version)).toBeNull();
  // Equal, not just at least: the plugin bumps only on a breaking change, which the server's MIN
  // must follow in the same change — a plugin ahead of MIN means one side was bumped alone.
  expect(version.protocolVersion).toBe(MIN_PROTOCOL_VERSION);
});
