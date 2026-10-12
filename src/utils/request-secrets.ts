import { AsyncLocalStorage } from "node:async_hooks";

// Per-request redaction context: credentials that arrive with a request (an HTTP `X-Figma-Token`,
// or a host-resolved credential) and so can't be on any startup list. AsyncLocalStorage carries
// the list through the request's promise chain without threading it through every call site.
//
// The list is mutable on purpose: a lazily resolved credential is learned mid-request
// (`addRequestSecret`), after the scope was opened.
const requestSecrets = new AsyncLocalStorage<string[]>();

export function withRequestSecrets<T>(
  secrets: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  // Filter empties to avoid `replaceAll("", ...)`, which loops over every
  // character of the message and produces nonsense output.
  return requestSecrets.run(secrets.filter(Boolean), fn);
}

/** Redact `secret` for the rest of the current `withRequestSecrets` scope. */
export function addRequestSecret(secret: string): void {
  const store = requestSecrets.getStore();
  if (secret && store && !store.includes(secret)) store.push(secret);
}

/** `text` with every secret in the current request scope replaced. */
export function redactRequestSecrets(text: string): string {
  let result = text;
  for (const secret of requestSecrets.getStore() ?? []) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}
