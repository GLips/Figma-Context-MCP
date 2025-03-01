# Docker Support for Figma Context MCP

This document explains how to use the Docker container for the Figma Context MCP server.

## Build Docker Image:

```bash
docker build -t figma-dev-mcp .
```

## Test Run Docker Image:
  ```bash
    docker run -i --rm -e FIGMA_API_KEY="Your Figma Access Token" figma-dev-mcp "npx figma-developer-mcp --stdio"
  ```
## Expected Output:
    ```
        Configuration:
        - FIGMA_API_KEY: ****ABC_ (source: env)
        - PORT: 3333 (source: default)

        Initializing Figma MCP Server in stdio mode...
        Connecting to transport...
        Server connected and ready to process requests

        Available tools:
        - get_file: Fetch Figma file information
        - get_node: Fetch specific node information

    ```
  You can stop the containe in Docker if you get that terminal output and then configure Cline/Claude.

## Cline / Claude MCP Settings:

 ```json
  "figma-developer-mcp": {
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "-e", "FIGMA_API_KEY=<Your Figma Access Token>",
      "figma-dev-mcp",
      "npx figma-developer-mcp --stdio"
    ]
  }
  ```

  You should now have access to the following tools:
  - get_file
  - get_node
