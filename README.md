# Figma MCP Server

Give [Cursor](https://cursor.sh/), [Windsurf](https://codeium.com/windsurf), [Cline](https://cline.bot/), and other AI-powered coding tools access to your Figma files with this [Model Context Protocol](https://modelcontextprotocol.io/introduction) server.

When Cursor has access to Figma design data, it's **way** better at one-shotting designs accurately than alternative approaches like pasting screenshots.

Get started quickly, see [Configuration](#configuration) for more details:

```bash
npx figma-developer-mcp --figma-api-key=<your-figma-api-key>
```

## Demo Video

[Watch a demo of building a UI in Cursor with Figma design data](https://youtu.be/6G9yb-LrEqg)
[![Watch the video](https://img.youtube.com/vi/6G9yb-LrEqg/maxresdefault.jpg)](https://youtu.be/6G9yb-LrEqg)

<a href="https://glama.ai/mcp/servers/kcftotr525"><img width="380" height="200" src="https://glama.ai/mcp/servers/kcftotr525/badge" alt="Figma Server MCP server" /></a>

## How it works

1. Open Cursor's composer in agent mode.
1. Paste a link to a Figma file, frame, or group.
1. Ask Cursor to do something with the Figma file—e.g. implement a design.
1. Cursor will fetch the relevant metadata from Figma and use it to write your code.

This MCP server is specifically designed for use with Cursor. Before responding with context from the [Figma API](https://www.figma.com/developers/api), it simplifies and translates the response so only the most relevant layout and styling information is provided to the model.

Reducing the amount of context provided to the model helps make the AI more accurate and the responses more relevant.

## Features

- **Figma Integration**: Access Figma design data directly from your AI coding tools
- **SwiftUI Code Generation**: Generate SwiftUI code from Figma designs
- **GitLab Integration**: Commit generated code directly to your GitLab repository

## Installation

### Running the server quickly with NPM

You can run the server quickly without installing or building the repo using NPM:

```bash
npx figma-developer-mcp --figma-api-key=<your-figma-api-key>

# or
pnpx figma-developer-mcp --figma-api-key=<your-figma-api-key>

# or
yarn dlx figma-developer-mcp --figma-api-key=<your-figma-api-key>

# or
bunx figma-developer-mcp --figma-api-key=<your-figma-api-key>
```

Instructions on how to create a Figma API access token can be found [here](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens).

### JSON config for tools that use configuration files

Many tools like Windsurf, Cline, and [Claude Desktop](https://claude.ai/download) use a configuration file to start the server.

The `figma-developer-mcp` server can be configured by adding the following to your configuration file:

```json
{
  "mcpServers": {
    "figma-developer-mcp": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--stdio"],
      "env": {
        "FIGMA_API_KEY": "<your-figma-api-key>",
        "GITLAB_TOKEN": "<your-gitlab-token>",
        "GITLAB_BASE_URL": "<your-gitlab-base-url>",
        "GITLAB_PROJECT_ID": "<your-gitlab-project-id>",
        "GITLAB_BRANCH": "<your-gitlab-branch>"
      }
    }
  }
}
```

### Running the server from local source

1. Clone the [repository](https://github.com/GLips/Figma-Context-MCP)
2. Install dependencies with `pnpm install`
3. Copy `.env.example` to `.env` and fill in your [Figma API access token](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens) and GitLab credentials if needed. Only read access is required for Figma, but write access is required for GitLab.
4. Run the server with `pnpm run dev`, along with any of the flags from the [Command-line Arguments](#command-line-arguments) section.

## Configuration

The server can be configured using either environment variables (via `.env` file) or command-line arguments. Command-line arguments take precedence over environment variables.

### Environment Variables

- `FIGMA_API_KEY`: Your [Figma API access token](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens) (required)
- `PORT`: The port to run the server on (default: 3333)
- `GITLAB_TOKEN`: Your GitLab personal access token (optional, required for GitLab integration)
- `GITLAB_BASE_URL`: Your GitLab API base URL (optional, required for GitLab integration)
- `GITLAB_PROJECT_ID`: Your GitLab project ID or path (optional, required for GitLab integration)
- `GITLAB_BRANCH`: Your GitLab branch to use (optional, required for GitLab integration)

### Command-line Arguments

- `--version`: Show version number
- `--figma-api-key`: Your Figma API access token
- `--port`: The port to run the server on
- `--gitlab-token`: Your GitLab personal access token
- `--gitlab-base-url`: Your GitLab API base URL
- `--gitlab-project-id`: Your GitLab project ID or path
- `--gitlab-branch`: Your GitLab branch to use
- `--stdio`: Run the server in command mode, instead of default HTTP/SSE
- `--help`: Show help menu

## GitLab Integration

The GitLab integration allows you to:

1. Commit generated SwiftUI code directly to your GitLab repository
2. Create new branches in your GitLab repository
3. Retrieve files from your GitLab repository
4. List branches in your GitLab repository
5. List files and directories in your GitLab repository
6. Test the connection to your GitLab API

To use the GitLab integration, you need to provide the following:

- `GITLAB_TOKEN`: A personal access token with API access to your GitLab repository
- `GITLAB_BASE_URL`: The base URL for your GitLab API (e.g., `https://gitlab.com/api/v4`)
- `GITLAB_PROJECT_ID`: The ID or path of your GitLab project (e.g., `group/project`)
- `GITLAB_BRANCH`: The default branch to use for operations (e.g., `main`)

## Connecting to Cursor

### Start the server

```