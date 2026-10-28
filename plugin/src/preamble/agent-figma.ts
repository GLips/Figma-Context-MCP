/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The `figma` the agent's code receives: the plugin's own, behind a proxy that asks the run's one
// "may I continue?" check on every access and reports each method call as pending to the run's
// status. flcm verbs refuse a cancelled run at their lock (mutation-lock.ts), but raw figma.* code
// never crosses it.
//
// Top-level only, deliberately. Wrapping the nodes it returns would stop `node.resize()` too, but a
// wrapped node is not the node: every Figma API and verb it reached would need it unwrapped. So code
// that works only on nodes it already holds runs on until its next figma.* access.
//
// Not a permission: `globalThis.figma` is still the real one. The bar is that accidental code stops,
// as with fig-71's read-only runs.
import { CANCELLED_BECAUSE, currentHost, isThenable, reportCall, untilCancelled } from "./host.js";
import { FlcmError } from "./flcm-error.js";

/** Refuse the agent's next figma.* access once the run may not continue. */
function refuse(key: string | symbol): void {
  const host = currentHost();
  if (typeof key === "symbol" || !host) return;
  // Still answered once the run replied: a cancelled run's leftover code stays refused for good,
  // while a handler a finished run registered (figma.on) calls in freely.
  const cause = host.runCancellation();
  if (cause) throw new FlcmError("run-ended", `${CANCELLED_BECAUSE[cause]}, so figma.${key} and every figma.* access after it is refused.`);
}

/** The agent's `figma` for this run. Built per run: the preamble is eval'd fresh for each one. */
export function agentFigma(): PluginAPI {
  const real = figma;
  // Cached per property, so `figma.on` handed to two places is one function, and the call keeps the
  // real figma as `this`, which Figma's own methods may require.
  const wrapped = new Map<string | symbol, { original: Function; call: Function }>();
  const callable = (key: string | symbol, original: Function): Function => {
    const cached = wrapped.get(key);
    if (cached?.original === original) return cached.call;
    // The host checks the name: a key that isn't one is counted, never named (FlcmHost.callStarted).
    const operation = `figma.${String(key)}` as const;
    const call = function (this: unknown, ...args: unknown[]): unknown {
      refuse(key);
      const out = reportCall(operation, () => Reflect.apply(original, real, args));
      // As in awaitNative: a Figma call can stall forever, and a cancelled run must still end so
      // the queue behind it moves. The call stays pending in the status until Figma settles it.
      return isThenable(out) ? untilCancelled(operation, out) : out;
    };
    wrapped.set(key, { original, call });
    return call;
  };

  // The target is a stand-in, not `real`: a proxy must return a non-configurable property's own
  // value, and Figma's methods may be, which would forbid handing back the reporting wrapper.
  return new Proxy(Object.create(null) as PluginAPI, {
    get(_, key) {
      refuse(key);
      const value: unknown = Reflect.get(real, key, real);
      return typeof value === "function" ? callable(key, value) : value;
    },
    set(_, key, value) {
      refuse(key);
      return Reflect.set(real, key, value, real);
    },
    has: (_, key) => Reflect.has(real, key),
    ownKeys: () => Reflect.ownKeys(real),
    getOwnPropertyDescriptor(_, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
      // Configurable, or the proxy would claim a non-configurable property its target lacks.
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}
