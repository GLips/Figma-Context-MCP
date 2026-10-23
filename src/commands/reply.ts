import { type Command, command } from "cleye";
import { z } from "zod";
import { UsageError } from "~/config.js";
import { FigmaService, staticCredentialSource } from "~/services/figma.js";
import { replyToFigmaComment } from "~/services/reply-to-figma-comment.js";
import { parseReplyToFigmaCommentParams } from "~/mcp/tools/reply-to-figma-comment-tool.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import { REST_COMMAND_FLAGS, prepareRestCommand, resolveRestTarget } from "./rest-command.js";

export const replyCommand: Command = command(
  {
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
  },
  (argv) => {
    runReply(argv.flags, argv._).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  },
);

interface ReplyFlags {
  fileKey?: string;
  commentId?: string;
  message?: string;
  handled?: boolean;
  figmaApiKey?: string;
  figmaOauthToken?: string;
  env?: string;
  proxy?: string;
}

export async function runReply(flags: ReplyFlags, positionals: string[]): Promise<void> {
  const target = resolveRestTarget(positionals[0], flags);
  const { fileKey, options } = parseReplyParams({
    fileKey: target.fileKey,
    commentId: flags.commentId ?? "",
    message: flags.message ?? "",
    handled: flags.handled ?? false,
  });
  const credential = prepareRestCommand(flags);
  const result = await replyToFigmaComment(
    new FigmaService(staticCredentialSource(credential)),
    fileKey,
    options,
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === "stale") {
    console.error(
      `Not posted: newer comments in this thread. Read them, then retry with --comment-id ${result.newestCommentId}.`,
    );
    process.exitCode = 1;
  }
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
