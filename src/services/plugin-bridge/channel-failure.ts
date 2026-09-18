/** JSON failure envelope. Codes are open-ended; capability-owned JSON fields pass through. */
export interface ChannelFailure {
  code: string;
  message: string;
  details?: unknown;
  [field: string]: unknown;
}

type JsonData = null | boolean | number | string | JsonData[] | { [key: string]: JsonData };

/**
 * Snapshot handler-owned values into data with no prototypes or serialization hooks. Getters are
 * read once, shared objects are copied once, and cycles/non-JSON values fail at this boundary.
 * JSON.stringify only sees the resulting data, never the handler's objects.
 */
function jsonData(
  value: unknown,
  copies = new Map<object, JsonData>(),
  active = new Set<object>(),
): JsonData {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) throw new Error("Non-JSON failure field");
  if (active.has(value)) throw new Error("Cyclic failure field");
  const prior = copies.get(value);
  if (prior !== undefined) return prior;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== null && prototype !== Object.prototype) {
    throw new Error("Non-JSON failure object");
  }
  const copy: JsonData[] | Record<string, JsonData> = array ? [] : Object.create(null);
  // Arrays must also be immune to inherited toJSON hooks.
  Object.setPrototypeOf(copy, null);
  copies.set(value, copy);
  active.add(value);
  if (array) {
    // Include enumerable extras in validation so an own toJSON cannot hide on an array either.
    for (const key of Object.keys(value)) {
      const item = jsonData(Reflect.get(value, key), copies, active);
      Object.defineProperty(copy, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    (copy as JsonData[]).length = value.length;
  } else {
    for (const key of Object.keys(value)) {
      (copy as Record<string, JsonData>)[key] = jsonData(Reflect.get(value, key), copies, active);
    }
  }
  active.delete(value);
  return copy;
}

/** Preserve JSON object failures and custom Error fields; supply defaults for ordinary throws. */
export function channelFailure(error: unknown): ChannelFailure {
  if (error !== null && typeof error === "object") {
    const fields: Record<string, unknown> = Object.create(null);
    // Error.message is normally non-enumerable. Read it and code once even when they are getters.
    for (const key of new Set([...Object.keys(error), "code", "message"])) {
      fields[key] = Reflect.get(error, key);
    }
    const code = fields.code;
    const message = fields.message;
    fields.code = typeof code === "string" ? code : "COMPUTATION_FAILED";
    fields.message = typeof message === "string" ? message : "The server capability failed.";
    // The two required fields were normalized above; jsonData preserves their string values.
    return jsonData(fields) as ChannelFailure;
  }
  return { code: "COMPUTATION_FAILED", message: String(error) };
}
