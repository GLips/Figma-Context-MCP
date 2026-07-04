// Host-side wire serialization for the sandbox eval result and its console output. This is TS HOST code
// (bundled into code.ts's IIFE), NOT sandbox-preamble source — it runs on the plugin main thread and never
// touches figma.*, so it stays a pure, unit-testable module distinct from code.ts's messaging/approval shell.
//
// The bridge JSON-serializes every outbound message, and a live Figma node is NOT plain JSON (sending one
// yields opaque failures). So the return path does two things here: guardReturnValue REJECTS a returned live
// node up front (loud, teaching the id pattern), and safeSerialize is the belt-and-suspenders that collapses
// any live node the guard let through (notably a logged node) to a stable { id, name, type }. Everything
// else — a render Handle, a read POJO, an agent's own data — round-trips WHOLE.

/**
 * The one true "is this a live Figma node" test. The id+type pair alone is too loose (an agent's own
 * `{ id, type }` data object, a render Handle, or a read POJO would all trip it), so we also require
 * `removed` — present on every BaseNode, absent on plain JSON the agent builds or any POJO the read/render
 * verbs return. This single discriminator is what lets safeSerialize collapse a live node while passing
 * every agent/handle/read shape through untouched.
 */
export function looksLikeNode(
  value: unknown,
): value is { id: string; type: string; name?: unknown; removed: unknown } {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.type === "string" && "removed" in o;
}

function findLiveNode(value: unknown, path: string, depth: number): { path: string; type: string } | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  // Stop at a node — never recurse into its (huge, circular) internals.
  if (looksLikeNode(value)) return { path, type: value.type };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findLiveNode(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value as object)) {
    const hit = findLiveNode((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Reject a return value that is — or contains — a live node, loudly. The bridge JSON-serializes
 * everything, so a node would come back as a bare { id } with every other property dropped and no signal
 * that it happened. Better a clear error that teaches the id pattern than silent loss the agent debugs blind.
 */
export function guardReturnValue(value: unknown): void {
  const hit = findLiveNode(value, "", 0);
  if (!hit) return;
  const where = hit.path ? ` (at return value ${hit.path.startsWith("[") ? hit.path : `.${hit.path}`})` : "";
  throw new Error(
    `You returned a live Figma node${where}: a ${hit.type}. Live nodes can't cross the bridge — ` +
      `they collapse to { id } and you lose every other property. Return the id string instead: ` +
      "`return node.id` (or `return { id: node.id }`, or an array of ids).",
  );
}

// Recursion backstop for a cyclic/self-referential structure. NOT a shaping limit: a full read POJO (a
// `get` subtree, a long `children`/`runs` array) must round-trip WHOLE (ADR-0003 forbids silent truncation),
// and the read walk produces finite trees whose recursion depth runs ~3× their visual nesting — far under
// this. The only thing this stops is a pathological cycle (`a.self = a`) that would otherwise overflow the
// QuickJS stack; guardReturnValue already rejects returned live nodes, and looksLikeNode collapses any that
// slip through (e.g. a logged node) before it recurses, so live-node internals never reach this depth.
//
// Why depth, NOT a visited Set. A global visited-set would also bound a compounding shared-reference DAG
// (`x = {a:x, b:x}` repeated), which depth alone lets fan out. Rejected deliberately: a visited-set collapses
// the SECOND occurrence of any shared reference to a marker, and the expanded read shape may legitimately
// share a value object across nodes (e.g. one fill reused on many nodes). That would corrupt the round-trip
// this serializer exists to preserve (a predicate reading `n.fills?.[0]` must see the value, not "[seen]").
// The depth cap never touches a legit shared ref — it only truncates true pathological depth. The DAG-blowup
// case is a self-inflicted agent hang, not a data-integrity risk, so the safe backstop wins.
const MAX_SERIALIZE_DEPTH = 200;

/**
 * Converts an arbitrary eval result into something safe to send over postMessage/WS. A live Figma node is
 * NOT plain JSON (sending one produces opaque failures), so any object that looks like a node (looksLikeNode)
 * collapses to `{ id, name, type }` — a stable handle the agent can thread back via figma.getNodeById.
 * Every other value — including render Handles and full read POJOs, none of which carry `removed` — is
 * recursed and round-trips whole, bounded only by the cycle backstop above.
 */
export function safeSerialize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();

  if (depth >= MAX_SERIALIZE_DEPTH) return "[…]";

  if (Array.isArray(value)) {
    return value.map((v) => safeSerialize(v, depth + 1));
  }

  // A live Figma node collapses to a stable handle the agent can thread into later execute_code calls via
  // figma.getNodeById. Gated on the removed-carrying discriminator, NOT a bare id+type shape, so a render
  // Handle / SlimHandle / read POJO (which carry id+type but no `removed`) falls through and round-trips whole.
  if (looksLikeNode(value)) {
    return {
      id: value.id,
      name: typeof value.name === "string" ? value.name : undefined,
      type: value.type,
    };
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    try {
      out[key] = safeSerialize(obj[key], depth + 1);
    } catch {
      out[key] = "[unserializable]";
    }
  }
  return out;
}
