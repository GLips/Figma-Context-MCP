# Figma Context MCP AIR

**Give your AI coding agent access to Figma design data.**  
Implement designs in any framework with pixel-perfect accuracy — in one shot.

[![npm version](https://img.shields.io/npm/v/figma-context-mcp-air.svg)](https://www.npmjs.com/package/figma-context-mcp-air)
[![npm downloads](https://img.shields.io/npm/dm/figma-context-mcp-air.svg)](https://npmcharts.com/compare/figma-context-mcp-air?interval=30)
[![MIT License](https://img.shields.io/github/license/compassalessandrolorenz/Figma-Context-MCP-AIR)](https://github.com/compassalessandrolorenz/Figma-Context-MCP-AIR/blob/main/LICENSE)

---

## What is this?

`figma-context-mcp-air` is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that gives AI coding tools (Cursor, Claude, Windsurf, etc.) direct access to your Figma design data.

It exposes **9 tools** covering the full design-to-code workflow:

| Tool | Description |
|---|---|
| `get_figma_data` | Full design data — layout, text, visuals, components (YAML/JSON) |
| `get_design_context` | Alias for `get_figma_data` matching the official Figma MCP tool naming |
| `download_figma_images` | Download PNG/SVG assets from Figma nodes to your local filesystem |
| `get_screenshot` | Capture a Figma node as a base64 PNG for visual inspection by the AI |
| `get_metadata` | Sparse XML layer hierarchy for quick node discovery before full extraction |
| `get_variable_defs` | All design tokens — colors, typography, spacing, effects, and styles |
| `whoami` | Verify your Figma authentication and check your plan tier |
| `create_design_system_rules` | Generate framework-specific design system documentation for your project |
| `get_figjam` | Extract FigJam board content (sticky notes, connectors, shapes) as XML |

Before returning data to the AI, the server simplifies and filters the raw Figma API response — keeping only the layout and styling information that matters for code generation. This reduces noise and dramatically improves AI accuracy.

---

## Getting Started

You need a **Figma Personal Access Token** to use this server.  
[How to create a Figma API access token →](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens)

### MacOS / Linux

Add this to your MCP client configuration file (e.g. `~/.cursor/mcp.json`, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "Figma MCP AIR": {
      "command": "npx",
      "args": ["-y", "figma-context-mcp-air", "--figma-api-key=YOUR-KEY", "--stdio"]
    }
  }
}
```

### Windows

```json
{
  "mcpServers": {
    "Figma MCP AIR": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "figma-context-mcp-air", "--figma-api-key=YOUR-KEY", "--stdio"]
    }
  }
}
```

### Using Environment Variables

You can also set `FIGMA_API_KEY` in the `env` field instead of passing it as a flag:

```json
{
  "mcpServers": {
    "Figma MCP AIR": {
      "command": "npx",
      "args": ["-y", "figma-context-mcp-air", "--stdio"],
      "env": {
        "FIGMA_API_KEY": "YOUR-KEY"
      }
    }
  }
}
```

---

## How it works

1. Open your AI coding tool's chat (e.g. agent mode in Cursor).
2. Paste a link to a Figma file, frame, or component.
3. Ask the AI to implement the design.
4. The AI calls `get_design_context` (or `get_figma_data`) to fetch structured design data, then writes your code.

For more advanced workflows, the AI can:
- Call `get_screenshot` to visually inspect a node before implementing it
- Call `get_variable_defs` to extract your design tokens and map them to CSS variables
- Call `get_metadata` for a quick layer overview before fetching full data
- Call `create_design_system_rules` to generate project-specific coding guidelines

---

## Configuration Options

| CLI Flag | Environment Variable | Default | Description |
|---|---|---|---|
| `--figma-api-key` | `FIGMA_API_KEY` | _(required)_ | Your Figma Personal Access Token |
| `--figma-oauth-token` | `FIGMA_OAUTH_TOKEN` | — | OAuth Bearer token (alternative to PAT) |
| `--port` | `PORT` | `3333` | HTTP server port (HTTP mode only) |
| `--json` | `OUTPUT_FORMAT=json` | YAML | Return JSON instead of YAML |
| `--skip-image-downloads` | `SKIP_IMAGE_DOWNLOADS` | false | Disable the `download_figma_images` tool |
| `--image-dir` | — | — | Custom directory for downloaded images |
| `--stdio` | `NODE_ENV=cli` | — | Run in stdio mode (required for MCP clients) |

---

## Tool Reference

### `get_figma_data` / `get_design_context`

Fetches and simplifies Figma design data for a file or specific node. Returns layout (flexbox/grid), typography, colors, borders, effects, and component metadata in YAML or JSON.

**Parameters:**
- `fileKey` _(required)_ — The key from your Figma URL: `figma.com/design/<fileKey>/...`
- `nodeId` _(optional)_ — The node ID from the URL: `?node-id=<nodeId>`. Use format `1234:5678`.
- `depth` _(optional)_ — How many levels deep to traverse. Only use if explicitly needed.

---

### `download_figma_images`

Downloads PNG or SVG renders of Figma nodes to your local filesystem.

**Parameters:**
- `fileKey` _(required)_
- `nodes` _(required)_ — Array of `{ nodeId, fileName }` objects
- `localPath` _(required)_ — Directory to save images
- `pngScale` _(optional)_ — Scale factor for PNG exports (default: 1)
- `svgOptions` _(optional)_ — SVG export options (outline text, include IDs, simplify strokes)

---

### `get_screenshot`

Captures a Figma node as a 2x PNG and saves it to disk. Useful for visual validation.

**Parameters:**
- `fileKey` _(required)_
- `nodeId` _(required)_
- `localPath` _(optional)_ — Save directory (default: `./screenshots`)
- `fileName` _(optional)_ — Output filename without extension

---

### `get_metadata`

Returns a sparse XML representation of the node hierarchy (depth=2). Use this for quick layer discovery before fetching full design context.

**Parameters:**
- `fileKey` _(required)_
- `nodeId` _(required)_

---

### `get_variable_defs`

Fetches all design tokens from a Figma file — variable collections (colors, spacing, typography) and published styles (effects, text styles, fill styles). Returns data with CSS custom property syntax.

**Parameters:**
- `fileKey` _(required)_

---

### `whoami`

Returns the authenticated user's Figma account information (name, email, plan tier). Useful for verifying your API key is working.

**Parameters:** None

---

### `create_design_system_rules`

Generates a comprehensive markdown template for project-specific design system rules. Tailored to your language and framework combination. Save the output to `CLAUDE.md` or your project's AI instructions file.

**Parameters:**
- `clientLanguages` _(required)_ — e.g. `"typescript,javascript"`
- `clientFrameworks` _(required)_ — `"react"`, `"vue"`, `"svelte"`, `"angular"`, or `"unknown"`

---

### `get_figjam`

Extracts content from a FigJam board — sticky notes, connectors, shapes, sections — as XML with screenshot URLs.

**Parameters:**
- `fileKey` _(required)_
- `nodeId` _(optional)_ — Specific section or frame within the FigJam board

---

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Development mode (HTTP, with watch)
pnpm dev

# Development mode (stdio)
pnpm dev:cli

# Run tests
pnpm test

# Type check
pnpm type-check

# Lint
pnpm lint
```

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

For major features, open an issue first to discuss the approach.

---

## License

MIT — see [LICENSE](LICENSE)

---

## Acknowledgements

This project is a fork of [GLips/Figma-Context-MCP](https://github.com/GLips/Figma-Context-MCP) (the Framelink MCP server), extended with additional tools to match the full official Figma MCP tool surface.
