<a href="https://www.framelink.ai/?utm_source=github&utm_medium=referral&utm_campaign=readme" target="_blank" rel="noopener">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://www.framelink.ai/github/HeaderDark.png" />
    <img alt="Framelink" src="https://www.framelink.ai/github/HeaderLight.png" />
  </picture>
</a>

<div align="center">
  <h1>Framelink MCP for Figma</h1>
  <h3>Give your coding agent access to your Figma data.<br/>Implement designs in any framework in one-shot.</h3>
  <a href="https://npmcharts.com/compare/figma-developer-mcp?interval=30">
    <img alt="weekly downloads" src="https://img.shields.io/npm/dm/figma-developer-mcp.svg">
  </a>
  <a href="./LICENSING.md">
    <img alt="Licensing details" src="https://img.shields.io/badge/license-see%20licensing%20details-blue" />
  </a>
  <a href="https://framelink.ai/discord">
    <img alt="Discord" src="https://img.shields.io/discord/1352337336913887343?color=7389D8&label&logo=discord&logoColor=ffffff" />
  </a>
  <br />
  <a href="https://twitter.com/glipsman">
    <img alt="Twitter" src="https://img.shields.io/twitter/url?url=https%3A%2F%2Fx.com%2Fglipsman&label=%40glipsman" />
  </a>
</div>

<br/>

Give [Cursor](https://cursor.sh/) and other AI-powered coding tools access to your Figma files with this [Model Context Protocol](https://modelcontextprotocol.io/introduction) server.

When Cursor has access to Figma design data, it's **way** better at one-shotting designs accurately than alternative approaches like pasting screenshots.

<h3><a href="https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=referral&utm_campaign=readme">See quickstart instructions →</a></h3>

## Demo

[Watch a demo of building a UI in Cursor with Figma design data](https://youtu.be/6G9yb-LrEqg)

[![Watch the video](https://img.youtube.com/vi/6G9yb-LrEqg/maxresdefault.jpg)](https://youtu.be/6G9yb-LrEqg)

## How it works

1. Open your IDE's chat (e.g. agent mode in Cursor).
2. Paste a link to a Figma file, frame, or group.
3. Ask Cursor to do something with the Figma file—e.g. implement the design.
4. Cursor will fetch the relevant metadata from Figma and use it to write your code.

This MCP server is specifically designed for use with Cursor. Before responding with context from the [Figma API](https://www.figma.com/developers/api), it simplifies and translates the response so only the most relevant layout and styling information is provided to the model.

Reducing the amount of context provided to the model helps make the AI more accurate and the responses more relevant.

### Reading through the Framelink plugin

With the Framelink Figma plugin connected, agents can read the same simplified output without the REST API: `flcm.get(target)` in `figma_execute_code` runs the same transform as `get_figma_data`. It reads the file open in Figma rather than any file by key, so start from a node ID or the user's selection. It also has no REST rate limits and needs no Figma token, which is why `get_figma_data` points at it when it fails with a 429, a 403, or no token configured.

## Getting Started

Many code editors and other AI clients use a configuration file to manage MCP servers.

The `figma-developer-mcp` server can be configured by adding the following to your configuration file.

> NOTE: You will need to create a Figma access token to use this server. Instructions on how to create a Figma API access token can be found [here](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens).

### MacOS / Linux

```json
{
  "mcpServers": {
    "Framelink MCP for Figma": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--figma-api-key=YOUR-KEY", "--stdio"]
    }
  }
}
```

### Windows

```json
{
  "mcpServers": {
    "Framelink MCP for Figma": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "figma-developer-mcp", "--figma-api-key=YOUR-KEY", "--stdio"]
    }
  }
}
```

Or you can set `FIGMA_API_KEY` and `PORT` in the `env` field.

If you need more information on how to configure the Framelink MCP for Figma, see the [Framelink docs](https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=referral&utm_campaign=readme).

## Serving on a network address

By default the HTTP server binds `127.0.0.1`, so every caller is you: it gets the server's Figma token, `download_figma_images` writing to its disk, and the Figma plugin. Bound to any other host (`--host 0.0.0.0`), the server can be reached by other people, so it gives them none of that. Each request must bring its own Figma token (`X-Figma-Token` or `Authorization: Bearer`) and is refused without one. `download_figma_images`, `figma_execute_code` and `get_screenshot` are refused, even while a plugin is connected. This is a permanent boundary: editing Figma needs a server on the machine where Figma is open.

## Run a saved Figma script

Save JavaScript as an async function body in a `.js` file. The plugin provides `figma` and the current `flcm` runtime; use `await` and `return` directly rather than module imports or exports. `execute --help` ends with the `flcm` quick-start, and `figma-developer-mcp reference <section...>` prints the full authoring reference.

```sh
npx figma-developer-mcp execute workflow.js --output artifacts/result.json
npx figma-developer-mcp execute workflow.js --screenshot artifacts/page.png --scale 2
```

Open Framelink in the intended Figma file and click Allow when the panel asks. The plugin must already be paired with this machine: run `npx figma-developer-mcp pair` once, and answer `y` if the code it prints is the code the plugin panel shows. Pairing is remembered for every server and `execute` run sharing this machine's Framelink state directory (`FRAMELINK_STATE_DIR`). The command uses the same approval, plugin owner, seat/free-allowance checks, and runtime as MCP execution. A Figma REST token is optional (`--figma-api-key`, `--figma-oauth-token`, or the server's env vars); with one, a script can read the file's comment pins, as it can through the MCP server.

The execution reply is JSON on stdout; progress and errors go to stderr. `--output` also saves that JSON. `--screenshot` saves a PNG after a completed execution, including a script error; select a target with `--node-id` or `--key`, or omit both for the current page. `--context` also captures the canvas around a target, with `--margin` pixels on each side. Script and transport failures return a nonzero exit status. An interrupted or disconnected execution is never automatically resubmitted.

`--wait` sets the connection wait and each approval wait separately (600 seconds by default); it does not extend execution deadlines. `--asset-root` confines local image reads, defaulting to the working directory. `--env` selects an environment file; `FRAMELINK_ASSET_ROOT` and `FRAMELINK_API_URL` retain their server meanings.

Results are delivered promptly. When a free-allowance execution reports no document change yet, the command retains its relay for the existing late-change accounting window (up to 90 seconds), exiting sooner if a late change is reported. Seat-covered executions and already-counted writes do not need that wait. Ctrl-C exits with status 130 and warns if it interrupts this observation; the emitted result remains available, but late-write accounting could not be fully observed.

## Telemetry

The server sends usage telemetry to PostHog: one event per tool call, with its duration, outcome and sizes. Opt out with `--no-telemetry`, `FRAMELINK_TELEMETRY=off`, or `DO_NOT_TRACK=1`.

- **Reads are anonymous.** Read events carry a per-process random ID, never your identity, file keys, node IDs, or design content.
- **Writes name the Figma user.** Events from write-path tools (`figma_execute_code`, `get_screenshot`) carry the Figma user ID of the plugin owner, the Figma user signed in to the plugin that ran the code. Writes are metered per user, so we need it to tell usage apart. Neither authored code nor returned content is ever sent.
- **Failures are sent as codes.** Expected failures, such as a 403, a rate limit, a rejected argument, or a declined approval, go out as a category, status and field name, never as the error text.
- **Unexpected errors go to error tracking.** The error message and stack frames are scrubbed of credentials, your home directory, and Figma file and node IDs. Response bodies are replaced with a fingerprint of who answered.

## Licensing proposal

Reads and the shared read transform stay MIT. The write path ("code mode") is
source-available under a commercial license, in the same npm package.

The [draft license](LICENSING.md) permits commercial free-allowance use without
signup and unlimited writes for paid seats. It is not yet effective and has not
been reviewed by a lawyer.

## Star History

<a href="https://star-history.com/#GLips/Figma-Context-MCP"><img src="https://api.star-history.com/svg?repos=GLips/Figma-Context-MCP&type=Date" alt="Star History Chart" width="600" /></a>

## Learn More

The Framelink MCP for Figma is simple but powerful. Get the most out of it by learning more at the [Framelink](https://framelink.ai?utm_source=github&utm_medium=referral&utm_campaign=readme) site.
