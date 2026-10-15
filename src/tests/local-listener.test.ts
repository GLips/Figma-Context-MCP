import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { localRequestRefusal } from "~/utils/local-listener.js";
import { RELAY_LISTENER_POLICY } from "~/commercial/plugin-bridge/relay-listener.js";

const SRC = join(import.meta.dirname, "..");
const BOUNDARY = "utils/local-listener.ts";

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : productionSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const SERVER_MODULES = /^(?:node:)?(?:http|https|http2|net)$/;
const SERVER_FACTORIES = new Set(["createServer", "createSecureServer", "Server"]);

/**
 * Every way a file could open a listener without the boundary. Rather than chase call shapes, it
 * forbids the means: a value import of a server factory (types are fine), a namespace or default
 * import of a server module, a value `WebSocketServer`, the SDK's Express app, and any `.listen(`.
 */
function listenerBypasses(source: string): string[] {
  const found: string[] = [];
  for (const [, clause, from] of source.matchAll(/import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (clause.startsWith("type ")) continue;
    const named = /{([^}]*)}/.exec(clause)?.[1] ?? "";
    const values = named
      .split(",")
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier && !specifier.startsWith("type "))
      .map((specifier) => specifier.split(/\s+as\s+/)[0]);
    const unnamed = clause
      .replace(/{[^}]*}/, "")
      .replace(/,/g, "")
      .trim();
    if (SERVER_MODULES.test(from)) {
      if (unnamed) found.push(`imports ${from} whole`);
      found.push(
        ...values
          .filter((name) => SERVER_FACTORIES.has(name))
          .map((name) => `${name} from ${from}`),
      );
    }
    if (from === "ws" && values.includes("WebSocketServer")) found.push("WebSocketServer from ws");
  }
  if (/\bWebSocket\.Server\b/.test(source)) found.push("WebSocket.Server");
  if (/\bcreateMcpExpressApp\b/.test(source)) found.push("createMcpExpressApp");
  if (/\.listen\(/.test(source)) found.push(".listen(");
  return found;
}

test("every local listener is created through the local-listener boundary", () => {
  const bypasses = productionSources(SRC).flatMap((file) => {
    const path = relative(SRC, file);
    if (path === BOUNDARY) return [];
    return listenerBypasses(readFileSync(file, "utf8")).map((how) => `${path}: ${how}`);
  });
  expect(bypasses).toEqual([]);
  // The check itself still bites on the shapes it exists for.
  expect(listenerBypasses(`import { createServer } from "node:http";`)).not.toEqual([]);
  expect(listenerBypasses(`import { WebSocketServer as W } from "ws";`)).not.toEqual([]);
  expect(listenerBypasses(`import http from "http";`)).not.toEqual([]);
  expect(listenerBypasses(`app.listen(3333, host);`)).not.toEqual([]);
});

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
