/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { FlcmError } from "./flcm-error.js";
import { isPlainData } from "./plain-data.js";

const MOVED_IDS = Symbol.for("framelink.flcm.movedIds");

/**
 * Session values own their data. Copying on ingress closes the alias loophole: an agent cannot
 * retain an input object, attach a request-bound function later, and smuggle it into the store.
 * These traps close over data machinery only, never a host, flcm instance or execution context.
 */
export function createSession(): Record<string, unknown> {
  const owned = new WeakSet<object>();
  const fail = (path: string): never => {
    throw new FlcmError(
      "authoring",
      "a session value must be plain data only: strings, finite numbers, booleans, null, undefined, arrays and plain objects. " +
        "Functions, live nodes, getters, symbols, class instances and cycles are refused; store ids and specs instead.",
      { path },
    );
  };

  function copy(value: unknown, path: string, destination?: object, retainOwned = true, ancestors = new Set<object>(), copies = new WeakMap<object, object>()): unknown {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!isPlainData(value) || value === destination || ancestors.has(value)) return fail(path);
    const previous = copies.get(value);
    if (previous) return previous;
    const target: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    const reuse = retainOwned && owned.has(value);
    const output = reuse ? value : protect(target, path);
    copies.set(value, output);
    ancestors.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
        // Returning the session snapshots it as `last`; flcm's memory isn't the agent's data to copy.
        if (key === MOVED_IDS && value === session) continue;
        if (typeof key !== "string") return fail(path);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor)) return fail(`${path}.${key}`);
        if (Array.isArray(value) && key === "length") {
          target.length = descriptor.value;
          continue;
        }
        if (!descriptor.enumerable) return fail(`${path}.${key}`);
        const item = copy(descriptor.value, `${path}.${key}`, destination, retainOwned, ancestors, copies);
        if (!reuse) Object.defineProperty(target, key, { value: item, writable: true, enumerable: true, configurable: true });
      }
    } finally { ancestors.delete(value); }
    return output;
  }

  function protect(target: object, path: string): object {
    function admit(key: string, value: unknown): unknown {
      // last is a historical snapshot, including when the agent returns session itself.
      const snapshot = proxy === session && key === "last";
      return copy(value, `${path}.${key}`, snapshot ? undefined : proxy, !snapshot);
    }
    const proxy: object = new Proxy(target, {
      set(_target, key, value) {
        if (typeof key !== "string") return fail(path);
        const data = admit(key, value);
        // Define on the private target so assignment cannot invoke an inherited setter.
        if (Array.isArray(target) && key === "length") return Reflect.set(target, key, data);
        return Reflect.defineProperty(target, key, { value: data, writable: true, enumerable: true, configurable: true });
      },
      defineProperty(_target, key, descriptor) {
        if (typeof key !== "string" || !("value" in descriptor) || descriptor.get || descriptor.set) return fail(path);
        // Fixed descriptors could trap a request's last result or prevent ordinary array edits.
        if (descriptor.configurable !== true || descriptor.enumerable !== true || descriptor.writable !== true) return fail(`${path}.${key}`);
        return Reflect.defineProperty(target, key, { ...descriptor, value: admit(key, descriptor.value) });
      },
      setPrototypeOf() { return fail(path); },
      preventExtensions() { return fail(path); },
    });
    owned.add(proxy);
    return proxy;
  }

  const root = {};
  // flcm's own memory rides on the session's lifetime but outside the agent's data: under a symbol
  // key, which no data trap admits and egress and size never walk. Hidden, not sealed: scene-access
  // bounds what it follows, so an agent tampering with it only misleads its own session.
  Object.defineProperty(root, MOVED_IDS, { value: {} });
  const session = protect(root, "session") as Record<string, unknown>;
  return session;
}

/**
 * The ids flcm retired by moving slot content as a copy, each mapped to the copy's id, kept for the
 * session so a later call naming the old id still reaches the layer (scene-access.ts).
 */
export function movedIdsOf(session: Record<string, unknown>): Record<string, string> {
  return (session as Record<symbol, Record<string, string>>)[MOVED_IDS];
}
