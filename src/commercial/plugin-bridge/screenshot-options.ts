/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Shared input rules; callers choose how to present a retryable input error.
export const MAX_SCREENSHOT_SCALE = 4;

export interface ScreenshotOptions {
  nodeId?: string;
  key?: string;
  scale?: number;
}

export function screenshotInputError({ nodeId, key, scale }: ScreenshotOptions): string | null {
  if (nodeId !== undefined && key !== undefined) {
    return `Screenshot target is ambiguous: got both nodeId ("${nodeId}") and key ("${key}"). Pass one target, or neither to capture the current page. This call did not run.`;
  }
  if (scale !== undefined && !(scale > 0 && scale <= MAX_SCREENSHOT_SCALE)) {
    return `Screenshot scale ${scale} is outside the supported range: greater than 0 and at most ${MAX_SCREENSHOT_SCALE}. This call did not run.`;
  }
  return null;
}
