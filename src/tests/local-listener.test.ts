import { localRequestRefusal } from "~/utils/local-listener.js";
import { RELAY_LISTENER_POLICY } from "~/commercial/plugin-bridge/relay-listener.js";

test("the plugin relay admits only an opaque or absent Origin", () => {
  const handshake = (origin?: string) =>
    localRequestRefusal(
      {
        method: "GET",
        headers: { host: "localhost:3056", "sec-fetch-site": "cross-site", origin },
        localPort: 3056,
      },
      RELAY_LISTENER_POLICY,
    )?.status ?? "admitted";

  expect(handshake("null")).toBe("admitted");
  expect(handshake(undefined)).toBe("admitted");
  expect(handshake("https://evil.example")).toBe(403);
  expect(handshake("https://www.figma.com")).toBe(403);
});
