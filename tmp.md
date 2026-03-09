# Running via Docker Compose

## Prerequisites

Generate a `package-lock.json` if you don't have one:

```bash
npm install
```

## Start the server

```bash
docker compose up --build
```

Server will be available at `http://localhost:3333`.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/mcp` | POST | MCP (StreamableHTTP) |
| `/sse` | GET | MCP (SSE, legacy) |
| `/messages` | POST | MCP (SSE, legacy) |

## MCP Client Configuration

Use the StreamableHTTP transport pointing at `/mcp`:

```json
{
  "mcpServers": {
    "figma": {
      "url": "http://localhost:3333/mcp"
    }
  }
}
```

## Tool Usage

Both tools now require `figma_api_key` as a parameter — no server-level token needed.

### get_figma_data

```json
{
  "figma_api_key": "figd_...",
  "fileKey": "ABC123xyz",
  "nodeId": "1234:5678"
}
```

### download_figma_images

```json
{
  "figma_api_key": "figd_...",
  "fileKey": "ABC123xyz",
  "localPath": "/absolute/path/to/images",
  "nodes": [
    {
      "nodeId": "1234:5678",
      "fileName": "hero.png"
    }
  ]
}
```

## Getting a Figma Personal Access Token

1. Go to Figma → Account Settings → Security
2. Under **Personal access tokens**, click **Generate new token**
3. Use that token as `figma_api_key` in every tool call
