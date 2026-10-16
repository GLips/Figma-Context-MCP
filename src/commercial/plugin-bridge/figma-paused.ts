/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The words for a plugin Figma has paused (plugin/src/figma-pause.ts): what happened, and the one
// thing that fixes it, which only the human at Figma can do.

/** Why the file's runs can't finish, and what the human does about it. `file` is a quoted name or a description. */
export function figmaPausedReason(pausedMs: number, file: string): string {
  return (
    `Figma has paused the Framelink plugin in ${file}: none of its timers or Figma calls have ` +
    `completed for ${Math.round(pausedMs / 1000)}s. Figma does this while that file's window or tab ` +
    `is in the background or the screen is locked. Ask the user to bring ${file} to the front in ` +
    `Figma; paused work then continues.`
  );
}

/** The error for a run the plugin refused because Figma has paused it. */
export class FigmaPausedError extends Error {
  constructor(pausedMs: number, fileName: string) {
    super(`Nothing ran. ${figmaPausedReason(pausedMs, JSON.stringify(fileName))} Then retry.`);
    this.name = "FigmaPausedError";
  }
}
