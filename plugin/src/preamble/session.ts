/**
 * Session values own their data. Copying on ingress closes the alias loophole: an agent cannot
 * retain an input object, attach a request-bound function later, and smuggle it into the store.
 * These traps close over data machinery only, never a host, flcm instance or execution context.
 */
export function createSession(): Record<string, unknown> {
  const owned = new WeakSet<object>();
  const fail = (path: string): never => {
    throw new Error(`session: ${path} must contain plain data only (strings, finite numbers, booleans, null, undefined, arrays and plain objects). Functions, live nodes, accessors, symbols, class instances and cycles are not supported.`);
  };

  function copy(value: unknown, path: string, destination?: object, retainOwned = true, ancestors = new Set<object>(), copies = new WeakMap<object, object>()): unknown {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === destination || ancestors.has(value)) return fail(path);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) return fail(path);
    if ("removed" in value && "id" in value && "type" in value) return fail(path);
    const previous = copies.get(value);
    if (previous) return previous;
    const target = Array.isArray(value) ? [] : Object.create(null);
    const reuse = retainOwned && owned.has(value);
    const output = reuse ? value : protect(target, path);
    copies.set(value, output);
    ancestors.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
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

  const session = protect(Object.create(null), "session") as Record<string, unknown>;
  return session;
}
