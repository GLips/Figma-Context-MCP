import { command } from "cleye";

export const fetchCommand = command(
  {
    name: "fetch",
    description: "Fetch simplified Figma data and print to stdout",
    parameters: ["[url]"],
    flags: {
      fileKey: {
        type: String,
        description: "Figma file key (overrides URL)",
      },
      nodeId: {
        type: String,
        description: "Node ID, format 1234:5678 (overrides URL)",
      },
      depth: {
        type: Number,
        description: "Tree traversal depth",
      },
      json: {
        type: Boolean,
        description: "Output JSON instead of YAML",
      },
      figmaApiKey: {
        type: String,
        description: "Figma API key",
      },
      figmaOauthToken: {
        type: String,
        description: "Figma OAuth token",
      },
      env: {
        type: String,
        description: "Path to .env file",
      },
    },
  },
  () => {
    console.error("fetch command not yet implemented");
    process.exit(1);
  },
);
