import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import yaml from "js-yaml";

const parametersSchema = z.object({});
export type WhoamiParams = z.infer<typeof parametersSchema>;

async function whoami(
  params: WhoamiParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
) {
  try {
    Logger.log("Fetching authenticated user information");

    const userInfo = await figmaService.getMe();

    Logger.log(`Successfully retrieved user info for: ${userInfo.handle}`);

    const formattedResult =
      outputFormat === "json" ? JSON.stringify(userInfo, null, 2) : yaml.dump(userInfo);

    return {
      content: [{ type: "text" as const, text: formattedResult }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error("Error fetching user information:", message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching user info: ${message}` }],
    };
  }
}

export const whoamiTool = {
  name: "whoami",
  description:
    "Get information about the authenticated Figma user, including their ID, email, handle, and profile image URL. Useful for verifying authentication and checking account details.",
  parametersSchema,
  handler: whoami,
} as const;
