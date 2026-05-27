import { HttpError } from "~/utils/fetch-json.js";

/**
 * Build a user-facing 429 message from the Figma rate-limit response headers.
 * Figma includes plan tier, seat-level limit type, retry-after, and an upgrade
 * link — all of which let us give targeted guidance instead of a generic
 * "try again later."
 *
 * See https://developers.figma.com/docs/rest-api/rate-limits/
 */
export function buildRateLimitMessage(error: unknown): string {
  const headers = error instanceof HttpError ? error.responseHeaders : {};
  const retryAfter = headers["retry-after"];
  const planTier = headers["x-figma-plan-tier"];
  const limitType = headers["x-figma-rate-limit-type"];
  const upgradeLink = headers["x-figma-upgrade-link"];

  let message = "Figma API rate limit hit (429).";

  if (retryAfter) {
    message += ` Retry after ${retryAfter} seconds.`;
  }

  if (limitType === "low") {
    message += " Your Figma seat type (Viewer or Collaborator) has a lower API rate limit.";
  }

  if (planTier === "starter" || planTier === "student") {
    message += ` Your ${planTier} plan has limited API access.`;
  }

  if (upgradeLink) {
    message += ` Upgrade: ${upgradeLink}`;
  }

  message += " See https://developers.figma.com/docs/rest-api/rate-limits/";
  return message;
}
