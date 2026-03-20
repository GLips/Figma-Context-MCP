import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import yaml from "js-yaml";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch variables and styles from, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
    ),
};

const parametersSchema = z.object(parameters);
export type GetVariableDefsParams = z.infer<typeof parametersSchema>;

async function getVariableDefs(
  params: GetVariableDefsParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
) {
  try {
    const { fileKey } = parametersSchema.parse(params);

    Logger.log(`Fetching variables and styles for file ${fileKey}`);

    // Fetch both variables and styles in parallel
    const [variablesResponse, stylesResponse] = await Promise.all([
      figmaService.getLocalVariables(fileKey),
      figmaService.getStyles(fileKey),
    ]);

    Logger.log(
      `Successfully retrieved ${Object.keys(variablesResponse.meta?.variableCollections || {}).length} variable collections and ${Object.keys(stylesResponse.meta?.styles || {}).length} styles`,
    );

    const result = {
      variables: {
        collections: variablesResponse.meta?.variableCollections || {},
        variables: variablesResponse.meta?.variables || {},
      },
      styles: stylesResponse.meta?.styles || {},
    };

    Logger.log(`Generating ${outputFormat.toUpperCase()} result from variable definitions`);
    const formattedResult =
      outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

    Logger.log("Sending variable definitions to client");
    return {
      content: [{ type: "text" as const, text: formattedResult }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching variable definitions for file ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error fetching variable definitions: ${message}`,
        },
      ],
    };
  }
}

export const getVariableDefsTool = {
  name: "get_variable_defs",
  description:
    "Get all design tokens from a Figma file, including local variables (color tokens, spacing scales, typography definitions) and published styles (colors, text styles, effects, grids). Use this to map Figma design tokens to your project's CSS variables, design system, or theme configuration. Essential for maintaining design-code consistency.",
  parametersSchema,
  handler: getVariableDefs,
} as const;
