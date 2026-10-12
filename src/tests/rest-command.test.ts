import { afterEach, describe, expect, it } from "vitest";
import { Agent, getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import { prepareRestCommand } from "~/commands/rest-command.js";

describe("REST CLI commands", () => {
  const original = getGlobalDispatcher();
  afterEach(() => setGlobalDispatcher(original));

  // The shared network error tells a user behind a proxy to set --proxy; the CLI has to honor it.
  it("routes Figma traffic through --proxy, as the server does", () => {
    setGlobalDispatcher(new Agent());
    prepareRestCommand({ figmaApiKey: "test-key", proxy: "http://proxy.test:8080" });
    expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent);
  });
});
