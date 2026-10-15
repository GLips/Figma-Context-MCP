// The one boundary every local listener goes through: the MCP HTTP endpoint, the upload endpoint and
// the plugin WebSocket relay. Loopback is not a trust boundary — any page the user visits can fire
// requests at localhost — so each listener declares a policy, and this module refuses what the policy
// rules out before the listener's own handler ever sees the request.
//
// Every listener is created AND bound here — nothing else calls `createServer`, `new WebSocketServer`
// or `.listen(` — so `src/tests/local-listener.test.ts` can fail on a listener opened anywhere else.
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerOptions,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, type ServerOptions as WebSocketServerOptions } from "ws";
import { Logger } from "~/utils/logger.js";

export interface LocalListenerPolicy {
  /**
   * Which browser requests get through. `refuse`: any `Origin` header, `null` included, or browser
   * fetch metadata. `opaque-origin-only`: only an opaque origin (`Origin: null`, a sandboxed iframe
   * such as the Figma plugin UI) or none at all. That one is NOT authentication — any page can make an
   * opaque origin by nesting a sandboxed iframe — it only stops the naive page.
   */
  browsers: "refuse" | "opaque-origin-only";
  /**
   * Require `Host` to name a loopback hostname and the port the request arrived on, which defeats DNS
   * rebinding. Only meaningful on a loopback bind: on a LAN bind the client may use any name for us.
   */
  checkHost: boolean;
  /** The media-type essence every POST body must carry, compared exactly. */
  postMediaType?: string;
  /** The body a refusal carries; listeners speaking JSON-RPC answer in it. Default `{ error }`. */
  refusalBody?: (message: string) => unknown;
}

export interface LocalRequestRefusal {
  status: number;
  message: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_BIND_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
// How long a refused sender may keep streaming into the void before we hang up on it.
const REFUSAL_LINGER_MS = 2_000;

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host);
}

/**
 * Why `policy` refuses this request, or null to admit it. Pure: the arrival port is passed in so the
 * Host rule can be checked without a socket.
 */
export function localRequestRefusal(
  request: { method?: string; headers: IncomingHttpHeaders; localPort?: number },
  policy: LocalListenerPolicy,
): LocalRequestRefusal | null {
  const { headers } = request;
  // Origin is on every browser POST and WebSocket handshake. `Sec-Fetch-Site` is browser-only too, and
  // catches the requests that omit Origin. Not `Sec-Fetch-Mode`: Node's fetch sends that one, and so
  // does every MCP client built on it.
  const browserOrigin = headers.origin;
  const isBrowser = browserOrigin !== undefined || headers["sec-fetch-site"] !== undefined;
  if (isBrowser) {
    const admitted =
      policy.browsers === "opaque-origin-only" &&
      (browserOrigin === undefined || browserOrigin === "null");
    if (!admitted) {
      return {
        status: 403,
        message: `browser requests are refused (Origin: ${browserOrigin ?? "none"})`,
      };
    }
  }
  if (policy.checkHost && !namesLoopbackPort(headers.host, request.localPort)) {
    return { status: 403, message: "the Host header must name this loopback endpoint" };
  }
  if (request.method === "POST" && policy.postMediaType !== undefined) {
    if (mediaTypeEssence(headers["content-type"]) !== policy.postMediaType) {
      return { status: 415, message: `the request body must be ${policy.postMediaType}` };
    }
  }
  return null;
}

function namesLoopbackPort(host: string | undefined, localPort: number | undefined): boolean {
  if (!host || localPort === undefined) return false;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(url.hostname) && (url.port || "80") === String(localPort);
}

/**
 * The type/subtype with parameters dropped, lowercased. `text/plain; charset=application/json` is
 * `text/plain` — a substring match would admit it, and it is the one a page can send without a CORS
 * preflight.
 */
function mediaTypeEssence(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/** Bind an HTTP server whose handler only ever sees requests `policy` admits. */
export async function listenLocalHttpServer(
  policy: LocalListenerPolicy,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  { port, host, ...options }: ServerOptions & { port: number; host: string },
): Promise<Server> {
  const server = createServer(options, (req, res) => {
    const refusal = localRequestRefusal(
      { method: req.method, headers: req.headers, localPort: req.socket.localPort },
      policy,
    );
    if (refusal) {
      Logger.log(`Refused ${req.method} ${req.url}: ${refusal.message}`);
      return refuseLocalRequest(
        req,
        res,
        refusal.status,
        policy.refusalBody?.(refusal.message) ?? { error: refusal.message },
      );
    }
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/**
 * A WebSocket server that refuses, at the upgrade, every handshake `policy` rules out. `admits` runs
 * after the policy, for the listener's own reasons to turn a connection away.
 */
export function createLocalWebSocketServer(
  policy: LocalListenerPolicy,
  options: Omit<WebSocketServerOptions, "verifyClient" | "server" | "noServer">,
  admits: () => boolean = () => true,
): WebSocketServer {
  return new WebSocketServer({
    ...options,
    verifyClient: ({ req }, done) => {
      const refusal = localRequestRefusal(
        { method: req.method, headers: req.headers, localPort: req.socket.localPort },
        policy,
      );
      if (refusal) {
        Logger.log(`Refused WS connection: ${refusal.message}`);
        return done(false, refusal.status, refusal.message);
      }
      if (!admits()) return done(false, 409);
      done(true);
    },
  });
}

/**
 * Answer and close. The body may be unread (an early refusal) or half-read (a cap crossed mid-stream).
 * Destroying the socket the moment the reply is written can reset the connection before the sender
 * reads the reply, so discard what keeps arriving and close after a short linger instead.
 */
export function refuseLocalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  // Too late to answer: the status line is out. Hang up rather than leave the sender waiting.
  if (res.headersSent) return void req.destroy();
  req.resume();
  // Also hangs up on a keep-alive sender that tries the socket again within the linger. Accepted: it
  // was just refused, so it is misbehaving or misconfigured.
  res.once("finish", () => setTimeout(() => req.destroy(), REFUSAL_LINGER_MS).unref());
  // No `Connection: close`: Node would end the socket on finish, racing a sender still mid-body.
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
