/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { command } from "cleye";
import { z } from "zod";
import { requireGlobalCredential, UsageError } from "~/config.js";
import { FigmaService, staticCredentialSource } from "~/services/figma.js";
import { replyToFigmaComment } from "~/commercial/reply-to-figma-comment.js";
import { parseReplyToFigmaCommentParams } from "~/commercial/tools/reply-to-figma-comment-tool.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import { REST_COMMAND_FLAGS, resolveRestTarget } from "~/commands/rest-command.js";
import { defineCliCommand } from "~/commands/cli-command.js";
import { printCliFailure, type CliCommandContext } from "~/commands/cli-context.js";
import { captureObservedCall } from "~/telemetry/index.js";

export const replyCommand = defineCliCommand(
  command({
    name: "reply",
    strictFlags: true,
    parameters: ["[url]"],
    help: buildCommandHelp({
      name: "reply",
      summary: "Reply in a Figma comment thread, like reply_to_figma_comment",
      details:
        "Posts over the Figma REST API under the token's own account, prefixed [AGENT], so it needs a\n" +
        "token (--figma-api-key or FIGMA_API_KEY) with the File comments: Write scope. --handled also\n" +
        "leaves a ✅ on the thread, which `comments` skips until someone replies after it. The comment id\n" +
        "names the thread, so a URL's node-id is ignored.",
      exampleArgs: [
        `"https://www.figma.com/design/<fileKey>/Name" --comment-id 1957645446 --message "Done" --handled`,
      ],
    }),
    flags: {
      ...REST_COMMAND_FLAGS,
      commentId: {
        type: String,
        placeholder: "<id>",
        description:
          "The newest comment in the thread you've read, from `comments --full`; refused if someone commented after it",
      },
      message: {
        type: String,
        placeholder: "<text>",
        description: "The reply, plain text",
      },
      handled: {
        type: Boolean,
        description:
          "This reply settles the thread (default: it stays open, and an earlier ✅ is taken back)",
      },
    },
  }),
  (argv, context) => runReply(argv.flags, argv._, context),
);

interface ReplyFlags {
  fileKey?: string;
  commentId?: string;
  message?: string;
  handled?: boolean;
}

async function runReply(
  flags: ReplyFlags,
  positionals: string[],
  context: CliCommandContext,
): Promise<number> {
  const target = resolveRestTarget(positionals[0], flags);
  const { fileKey, options } = parseReplyParams({
    fileKey: target.fileKey,
    commentId: flags.commentId ?? "",
    message: flags.message ?? "",
    handled: flags.handled ?? false,
  });
  const credential = requireGlobalCredential(context.credential);
  // The outcome codes are reply_to_figma_comment's own.
  return context.observe("reply_to_figma_comment", captureObservedCall, async (call) => {
    let result;
    try {
      result = await replyToFigmaComment(
        new FigmaService(staticCredentialSource(credential)).withSignal(context.signal),
        fileKey,
        options,
      );
    } catch (error) {
      call.record({ outcome: "failed" });
      return printCliFailure(error);
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.kind === "stale") {
      call.record({ outcome: "stale" });
      console.error(
        `Not posted: newer comments in this thread. Read them, then retry with --comment-id ${result.newestCommentId}.`,
      );
      return 1;
    }
    call.record({ outcome: result.handledMarkError ? "mark_failed" : "posted" });
    return 0;
  });
}

// The tool's own validation, so a missing --comment-id or --message is a UsageError naming the
// field rather than a raw ZodError.
function parseReplyParams(params: Parameters<typeof parseReplyToFigmaCommentParams>[0]) {
  try {
    return parseReplyToFigmaCommentParams(params);
  } catch (error) {
    if (error instanceof z.ZodError) throw new UsageError(z.prettifyError(error));
    throw error;
  }
}
