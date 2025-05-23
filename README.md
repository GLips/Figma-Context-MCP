<a href="https://www.framelink.ai/?utm_source=github&utm_medium=referral&utm_campaign=readme" target="_blank" rel="noopener">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://www.framelink.ai/github/HeaderDark.png" />
    <img alt="Framelink" src="https://www.framelink.ai/github/HeaderLight.png" />
  </picture>
</a>

<div align="center">
  <h1>Framelink Figma MCP Server</h1>
  <p>
    🌐 Available in:
    <a href="README.ko.md">한국어 (Korean)</a> |
    <a href="README.ja.md">日本語 (Japanese)</a> |
    <a href="README.zh.md">中文 (Chinese)</a>
  </p>
  *(Note: This project has been converted to Python. The translated READMEs (Korean, Japanese, Chinese) may still contain outdated Node.js specific instructions. Contributions to update them are welcome!)*
  <h3>Give your coding agent access to your Figma data.<br/>Implement designs in any framework in one-shot.</h3>
  <!-- NPM badge removed -->
  <a href="https://github.com/GLips/Figma-Context-MCP/blob/main/LICENSE">
    <img alt="MIT License" src="https://img.shields.io/github/license/GLips/Figma-Context-MCP" />
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

## Getting Started

### Prerequisites

*   Python 3.8 or higher installed.
*   Access to a terminal or command prompt.

### Running from Source (Recommended for now)

1.  Clone the repository:
    ```bash
    git clone https://github.com/GLips/Figma-Context-MCP.git
    cd Figma-Context-MCP
    ```
2.  Navigate to the Python package directory:
    ```bash
    cd python_mcp 
    ```
    *(Note: If `pyproject.toml` and the `mcp` package are moved to the repository root in the future, this `cd python_mcp` step might be omitted).*
3.  Create a virtual environment and activate it:
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows use: venv\Scripts\activate
    ```
4.  Install dependencies:
    ```bash
    pip install -r requirements.txt
    # Alternatively, if you want to install the package in editable mode (useful for development):
    # pip install -e . 
    ```

### Configuration

Many code editors and other AI clients use a configuration file to manage MCP servers.
To configure the Python version of the Framelink Figma MCP server (when running from source), add the following to your MCP client's configuration file:

> NOTE: You will need to create a Figma access token to use this server. Instructions on how to create a Figma API access token can be found [here](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens).

**Configuration for MacOS / Linux:**

```json
{
  "mcpServers": {
    "Framelink Figma MCP": {
      "command": "python",
      "args": ["-m", "mcp.cli", "--figma-api-key=YOUR-KEY", "--stdio"],
      "workingDirectory": "./python_mcp" 
      // Specify the path to the python_mcp directory if running from the repo root.
      // If your terminal's CWD is already python_mcp, you might not need workingDirectory.
    }
  }
}
```

**Configuration for Windows:**

```json
{
  "mcpServers": {
    "Framelink Figma MCP": {
      "command": "python",
      "args": ["-m", "mcp.cli", "--figma-api-key=YOUR-KEY", "--stdio"],
      "workingDirectory": ".\\python_mcp" 
      // Specify the path to the python_mcp directory if running from the repo root.
      // If your terminal's CWD is already python_mcp, you might not need workingDirectory.
    }
  }
}
```

**Explanation of `workingDirectory`**:
- The `python -m mcp.cli` command needs to be run from a context where Python can find the `mcp` package.
- If you are in the `Figma-Context-MCP/python_mcp` directory, Python can directly find `mcp.cli`.
- If your MCP client runs commands from the repository root (`Figma-Context-MCP`), you might need `workingDirectory` pointing to `python_mcp` for `python -m mcp.cli` to work correctly, or ensure `python_mcp` is in your `PYTHONPATH`. The `workingDirectory` option is often supported by MCP clients.
- Alternatively, if the package is installed (e.g., via `pip install -e .`), `python -m mcp.cli` should work from anywhere as long as the virtual environment is active. The `workingDirectory` might still be useful for relative paths if the script expects any.

You can also set `FIGMA_API_KEY` and `PORT` (if applicable, e.g., for HTTP mode) as environment variables instead of using command-line arguments.

If you need more information on how to configure the Framelink Figma MCP server, see the [Framelink docs](https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=referral&utm_campaign=readme) (Note: these docs may still reflect Node.js specific instructions).

## Star History

<a href="https://star-history.com/#GLips/Figma-Context-MCP"><img src="https://api.star-history.com/svg?repos=GLips/Figma-Context-MCP&type=Date" alt="Star History Chart" width="600" /></a>

## Learn More

The Framelink Figma MCP server is simple but powerful. Get the most out of it by learning more at the [Framelink](https://framelink.ai?utm_source=github&utm_medium=referral&utm_campaign=readme) site.

<!-- SPONSORS:LIST:START -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->

## Sponsors

### 🥇 Gold Sponsors

<table>
  <tr>
   <td align="center"><a href="https://framelink.ai/?ref=framelink-mcp&utm_source=github&utm_medium=referral&utm_campaign=framelink-mcp"><img src="https://avatars.githubusercontent.com/u/204619719" width="180" alt="Framelink"/><br />Framelink</a></td>
  </tr>
</table>

### 🥈 Silver Sponsors

<table>
  <tr>
   <!-- <td align="center"><a href=""><img src="" width="150" alt="tbd"/><br />Title</a></td> -->
  </tr>
</table>

### 🥉 Bronze Sponsors

<table>
  <tr>
   <!-- <td align="center"><a href=""><img src="" width="120" alt="tbd"/><br />tbd</a></td>-->
  </tr>
</table>

### 😻 Smaller Backers

<table>
  <tr>
   <!-- <td align="center"><a href=""><img src="" width="100" alt="tbd"/><br />tbd</a></td>-->
  </tr>
  <tr>
   <!-- <td align="center"><a href=""><img src="" width="100" alt="tbd"/><br />tbd</a></td>-->
  </tr>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- SPONSORS:LIST:END -->
