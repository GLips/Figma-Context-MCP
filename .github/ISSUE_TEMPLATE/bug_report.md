---
name: Bug report
about: Create a report to help us improve
title: ""
labels: bug
assignees: ""
---

**Describe the bug**
A clear and concise description of what the bug is.

**Software Versions**

- Figma Developer MCP: Run the MCP with `--version`—either npx or locally, depending on how you're running it.
- Node.js: `node --version`
- NPM: `npm --version`
- Operating System:
- Client: e.g. Cursor, VSCode, Claude Desktop, etc.
- Client Version:

**To Reproduce**
Steps to reproduce the behavior:

1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem. Often a screenshot of your entire chat window where you're trying to trigger the MCP is helpful.

**Server Configuration**
Provide your MCP JSON configuration, if applicable. E.g.

```
    "figma-developer-mcp": {
      "command": "npx",
      "args": [
        "figma-developer-mcp",
        "--figma-api-key=REDACTED",
        "--stdio"
      ]
    }
```

**Command Line Logs**
If you're running the MCP locally on the command line, include all the logs for those like so:

```
> npx figma-developer-mcp --figma-api-key=REDACTED

Configuration:
- FIGMA_API_KEY: ****8pXg (source: cli)
- PORT: 3333 (source: default)

Initializing Figma MCP Server in HTTP mode on port 3333...
HTTP server listening on port 3333
SSE endpoint available at http://localhost:3333/sse
Message endpoint available at http://localhost:3333/messages
New SSE connection established
```

**MCP Logs**
If you're running the MCP in a code editor like Cursor, there are MCP-specific logs that provide more context on any errors. In Cursor, you can find them by clicking `CMD + Shift + P` and looking for `Developer: Show Logs...`. Within the show logs window, you can find `Cursor MCP`—copy and paste the contents there into the bug report.

```
2025-03-18 11:36:22.251 [info] pnpx: Handling CreateClient action
2025-03-18 11:36:22.251 [info] pnpx: getOrCreateClient for stdio server.  process.platform: darwin isElectron: true
2025-03-18 11:36:22.251 [info] pnpx: Starting new stdio process with command: pnpx figma-developer-mcp --figma-api-key=REDACTED --stdio
2025-03-18 11:36:23.987 [info] pnpx: Successfully connected to stdio server
2025-03-18 11:36:23.987 [info] pnpx: Storing stdio client
2025-03-18 11:36:23.988 [info]  MCP: Handling ListOfferings action
2025-03-18 11:36:23.988 [error]  MCP: No server info found
2025-03-18 11:36:23.988 [info] pnpx: Handling ListOfferings action
2025-03-18 11:36:23.988 [info] pnpx: Listing offerings
2025-03-18 11:36:23.988 [info] pnpx: getOrCreateClient for stdio server.  process.platform: darwin isElectron: true
2025-03-18 11:36:23.988 [info] pnpx: Reusing existing stdio client
2025-03-18 11:36:23.988 [info] pnpx: Connected to stdio server, fetching offerings
2025-03-18 11:36:24.005 [info] listOfferings: Found 2 tools
2025-03-18 11:36:24.005 [info] pnpx: Found 2 tools, 0 resources, and 0 resource templates
2025-03-18 11:36:24.005 [info]  npx: Handling ListOfferings action
2025-03-18 11:36:24.005 [error]  npx: No server info found
```

**Additional context**
Add any other context about the problem here.
