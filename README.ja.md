<a href="https://www.framelink.ai/?utm_source=github&utm_medium=readme&utm_campaign=readme" target="_blank" rel="noopener">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://www.framelink.ai/github/HeaderDark.png" />
    <img alt="Framelink" src="https://www.framelink.ai/github/HeaderLight.png" />
  </picture>
</a>

<div align="center">
  <h1>Framelink Figma MCP サーバー</h1>
  <p>
    🌐 利用可能な言語:
    <a href="README.md">English (英語)</a> |
    <a href="README.ko.md">한국어 (韓国語)</a> |
    <a href="README.zh-cn.md">简体中文 (簡体字中国語)</a> |
    <a href="README.zh-tw.md">繁體中文 (繁体字中国語)</a>
  </p>
  <h3>コーディングエージェントにFigmaデータへのアクセスを提供。<br/>ワンショットで任意のフレームワークにデザインを実装。</h3>
  <a href="https://npmcharts.com/compare/figma-developer-mcp?interval=30">
    <img alt="週間ダウンロード" src="https://img.shields.io/npm/dm/figma-developer-mcp.svg">
  </a>
  <a href="https://github.com/GLips/Figma-Context-MCP/blob/main/LICENSE">
    <img alt="MITライセンス" src="https://img.shields.io/github/license/GLips/Figma-Context-MCP" />
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

[Cursor](https://cursor.sh/)と他のAI搭載コーディングツールに、この[Model Context Protocol](https://modelcontextprotocol.io/introduction)サーバーを通じてFigmaファイルへのアクセスを提供します。

CursorがFigmaデザインデータにアクセスできる場合、スクリーンショットを貼り付けるなどの代替アプローチよりも**はるかに**正確にワンショットでデザインを実装できます。

<h3><a href="https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=readme&utm_campaign=readme">クイックスタートガイドを見る →</a></h3>

## デモ

[FigmaデザインデータでCursorでUIを構築するデモを見る](https://youtu.be/6G9yb-LrEqg)

[![ビデオを見る](https://img.youtube.com/vi/6G9yb-LrEqg/maxresdefault.jpg)](https://youtu.be/6G9yb-LrEqg)

## 仕組み

1. IDEのチャットを開きます（例：Cursorのエージェントモード）。
2. Figmaファイル、フレーム、またはグループへのリンクを貼り付けます。
3. CursorにFigmaファイルで何かをするように依頼します（例：デザインの実装）。
4. CursorはFigmaから関連するメタデータを取得し、コードを書くために使用します。

このMCPサーバーは、Cursorで使用するために特別に設計されています。[Figma API](https://www.figma.com/developers/api)からコンテキストを応答する前に、応答を簡素化して翻訳し、モデルに最も関連性の高いレイアウトとスタイリング情報のみを提供します。

モデルに提供されるコンテキストの量を減らすことで、AIの精度を高め、応答をより関連性のあるものにするのに役立ちます。

## はじめに

多くのコードエディタやその他のAIクライアントは、MCPサーバーを管理するために設定ファイルを使用します。

`figma-developer-mcp`サーバーは、以下を設定ファイルに追加することで設定できます。

> 注：このサーバーを使用するには、Figmaアクセストークンを作成する必要があります。Figma APIアクセストークンの作成方法については[こちら](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens)をご覧ください。

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

または `env` フィールドに `FIGMA_API_KEY` と `PORT` を設定することもできます。

Framelink Figma MCPサーバーの設定方法の詳細については、[Framelinkドキュメント](https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=readme&utm_campaign=readme)を参照してください。

## スター履歴

<a href="https://star-history.com/#GLips/Figma-Context-MCP"><img src="https://api.star-history.com/svg?repos=GLips/Figma-Context-MCP&type=Date" alt="スター履歴チャート" width="600" /></a>

## 詳細情報

Framelink Figma MCPサーバーはシンプルですが強力です。[Framelink](https://framelink.ai?utm_source=github&utm_medium=readme&utm_campaign=readme)サイトで詳細情報をご覧ください。
