
<h3><a href="https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=readme&utm_campaign=readme">クイックスタートガイドを見る →</a></h3>

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
