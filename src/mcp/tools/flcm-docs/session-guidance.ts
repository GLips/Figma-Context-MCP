/** Read-only status lookup. Reference delivery never enters the human approval wait. */
export async function referenceSessionGuidance({
  pairingCode,
  protocolRefusal,
  status,
  timeoutMs = 1500,
}: {
  pairingCode: string | null;
  protocolRefusal: string | null;
  status: (signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  if (protocolRefusal) return protocolRefusal;
  if (!pairingCode) {
    return "No compatible Figma plugin is connected. Open the Framelink plugin in Figma, then check its connection before executing code. The reference is available below.";
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      status(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Approval status timed out"));
        }, timeoutMs);
      }),
    ]);
    if (typeof reply === "object" && reply !== null && "type" in reply) {
      if (reply.type === "APPROVAL_GRANTED") return undefined;
      if (reply.type === "PENDING_APPROVAL" || reply.type === "APPROVAL_REJECTED") {
        return `Approval is required before executing code. Ask the user to allow pairing code ${pairingCode} in the Framelink plugin. This reference request does not wait for approval or submit code.`;
      }
    }
    return "The plugin returned an unrecognized approval status. Check the Framelink plugin connection before executing code. The reference is available below.";
  } catch {
    return "The plugin's approval status could not be checked. Check the Framelink plugin connection before executing code. The reference is available below; no code was submitted.";
  } finally {
    clearTimeout(timer);
  }
}
