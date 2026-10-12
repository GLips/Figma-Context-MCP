/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The one owner of the screenshot input rules for the MCP tool and the CLI; each caller chooses how to
// present the retryable error. The plugin re-checks scale and margin as untrusted input.
import { MAX_SCREENSHOT_SCALE } from "@framelink/plugin/protocol";

export interface ScreenshotOptions {
  nodeId?: string;
  key?: string;
  scale?: number;
  context?: boolean;
  margin?: number;
}

export function screenshotInputError({
  nodeId,
  key,
  scale,
  context,
  margin,
}: ScreenshotOptions): string | null {
  if (nodeId !== undefined && key !== undefined) {
    return `Screenshot target is ambiguous: got both nodeId ("${nodeId}") and key ("${key}"). Pass one target, or neither to capture the current page. This call did not run.`;
  }
  if (scale !== undefined && !(scale > 0 && scale <= MAX_SCREENSHOT_SCALE)) {
    return `Screenshot scale ${scale} is outside the supported range: greater than 0 and at most ${MAX_SCREENSHOT_SCALE}. This call did not run.`;
  }
  if (context && nodeId === undefined && key === undefined) {
    return "Contextual capture needs a target: pass nodeId or key with context. This call did not run.";
  }
  if (margin !== undefined && (!context || !Number.isFinite(margin) || margin < 0)) {
    return `Screenshot margin ${margin} needs context:true and a finite nonnegative pixel value. This call did not run.`;
  }
  return null;
}
