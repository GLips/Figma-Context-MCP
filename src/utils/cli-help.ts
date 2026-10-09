import type { cli } from "cleye";
import packageJson from "../../package.json" with { type: "json" };

type HelpOptions = Exclude<NonNullable<Parameters<typeof cli>[0]["help"]>, false>;

/** The installed binary's name, as npm links it from package.json's `bin`. */
export const CLI_NAME = Object.keys(packageJson.bin)[0];

/**
 * `--help` for a subcommand. cleye uses `help.description` both as the command's row in the parent's
 * command list and atop its own page, so the summary stays one line there and `details` expands it
 * only on the command's own page. Examples are argument strings, prefixed with the full invocation.
 * `appendix` sections print after the flags and examples.
 */
export function buildCommandHelp({
  name,
  summary,
  details,
  exampleArgs,
  appendix = [],
}: {
  name: string;
  summary: string;
  details?: string;
  exampleArgs?: string[];
  appendix?: { title: string; body: string }[];
}): HelpOptions {
  return {
    description: summary,
    examples: exampleArgs?.map((args) => `${CLI_NAME} ${name} ${args}`),
    render: (nodes, renderers) => {
      const page = nodes.map((node) =>
        node.id === "description" && details
          ? { ...node, data: `${summary}\n\n${details}\n` }
          : node,
      );
      const sections = appendix.map(({ title, body }) => ({
        type: "section" as const,
        data: { title, body },
      }));
      return renderers.render([...page, ...sections]);
    },
  };
}
