// Minimal streamable-HTTP MCP client: enough to ask a server what tools it
// advertises. Used as a preflight so a run fails in seconds with "plugin not
// connected" instead of after a 20-minute session that never had
// figma_execute_code to call.

interface JsonRpcResponse {
  result?: { tools?: { name: string }[] };
  error?: { message: string };
}

export async function listMcpTools(url: string): Promise<string[]> {
  const sessionHeaders: Record<string, string> = {};
  const init = await rpc(url, sessionHeaders, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "trials", version: "0" },
    },
  });
  if (init.error) throw new Error(`MCP initialize failed: ${init.error.message}`);

  const list = await rpc(url, sessionHeaders, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  if (list.error) throw new Error(`MCP tools/list failed: ${list.error.message}`);
  return (list.result?.tools ?? []).map((t) => t.name);
}

async function rpc(
  url: string,
  sessionHeaders: Record<string, string>,
  body: unknown,
): Promise<JsonRpcResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...sessionHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Could not reach the MCP server at ${url} — is the framelink server running?`);
  }
  if (!res.ok) throw new Error(`MCP server at ${url} answered HTTP ${res.status}`);

  // A stateful server hands back a session id on initialize; echo it on every
  // later call. The framelink server is stateless today, so this is usually empty.
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionHeaders["mcp-session-id"] = sid;

  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    const last = data.at(-1);
    if (!last) throw new Error("MCP server sent an SSE response with no data frame");
    return JSON.parse(last);
  }
  return JSON.parse(text);
}
