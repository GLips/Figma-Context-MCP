<a href="https://www.framelink.ai/?utm_source=github&utm_medium=referral&utm_campaign=readme" target="_blank" rel="noopener">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://www.framelink.ai/github/HeaderDark.png" />
    <img alt="Framelink" src="https://www.framelink.ai/github/HeaderLight.png" />
  </picture>
</a>

<div align="center">
  <h1>Framelink Figma MCP 伺服器</h1>
  <p>
    🌐 可用語言:
    <a href="README.md">English (英文)</a> |
    <a href="README.ko.md">한국어 (韓文)</a> |
    <a href="README.ja.md">日本語 (日文)</a> |
    <a href="README.zh-cn.md">简体中文 (簡體中文)</a>
  </p>
  <h3>讓您的程式碼代理存取您的 Figma 資料。<br/>在任何框架中一次性完成設計。</h3>
  <a href="https://npmcharts.com/compare/figma-developer-mcp?interval=30">
    <img alt="每週下載次數" src="https://img.shields.io/npm/dm/figma-developer-mcp.svg">
  </a>
  <a href="https://github.com/GLips/Figma-Context-MCP/blob/main/LICENSE">
    <img alt="MIT 授權條款" src="https://img.shields.io/github/license/GLips/Figma-Context-MCP" />
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

使用此 [Model Context Protocol](https://modelcontextprotocol.io/introduction) 伺服器，讓 [Cursor](https://cursor.sh/) 和其他由 AI 驅動的程式碼工具存取您的 Figma 檔案。

當 Cursor 可以存取 Figma 設計資料時，它在一次性精準實現設計方面，比貼上螢幕截圖等替代方案**好得多**。

<h3><a href="https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=referral&utm_campaign=readme">查看快速入門指南 →</a></h3>

## 示範

[觀看在 Cursor 中使用 Figma 設計資料建構 UI 的示範](https://youtu.be/6G9yb-LrEqg)

[ ![觀看影片](https://img.youtube.com/vi/6G9yb-LrEqg/maxresdefault.jpg) ](https://youtu.be/6G9yb-LrEqg)

## 運作方式

1. 開啟您 IDE 的聊天功能（例如 Cursor 中的代理模式）。
2. 貼上 Figma 檔案、框架或群組的連結。
3. 要求 Cursor 對 Figma 檔案執行操作 — 例如，實現設計。
4. Cursor 將從 Figma 取得相關元數據，並用它來編寫您的程式碼。

此 MCP 伺服器專為與 Cursor 搭配使用而設計。在從 [Figma API](https://www.figma.com/developers/api) 回應內容之前，它會簡化和轉譯回應，以便只向模型提供最相關的版面配置和樣式資訊。

減少提供給模型的內容有助於提高 AI 的準確性並使回應更具關聯性。

## 入門指南

許多程式碼編輯器和其他 AI 客戶端都使用設定檔來管理 MCP 伺服器。

可以透過將以下內容新增至您的設定檔來設定 `figma-developer-mcp` 伺र्वर。

> 注意：您需要建立一個 Figma 存取權杖才能使用此伺服器。有關如何建立 Figma API 存取權杖的說明，請參閱[此處](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens)。

### MacOS / Linux

```json
{
  "mcpServers": {
    "Framelink Figma MCP": {
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
    "Framelink Figma MCP": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "figma-developer-mcp", "--figma-api-key=YOUR-KEY", "--stdio"]
    }
  }
}
```

或者您可以在 `env` 欄位中設定 `FIGMA_API_KEY` 和 `PORT`。

如果您需要有關如何設定 Framelink Figma MCP 伺服器的更多資訊，請參閱 [Framelink 文件](https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=referral&utm_campaign=readme)。

## Star 歷史

<a href="https://star-history.com/#GLips/Figma-Context-MCP"><img src="https://api.star-history.com/svg?repos=GLips/Figma-Context-MCP&type=Date" alt="Star History Chart" width="600" /></a>

## 了解更多

Framelink Figma MCP 伺服器既簡單又強大。請前往 [Framelink](https://framelink.ai?utm_source=github&utm_medium=referral&utm_campaign=readme) 網站了解更多資訊，以充分利用它。
