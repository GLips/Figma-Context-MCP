#!/bin/bash
# If FIGMA_API_KEY environment variable is set, use it
if [ -n "$FIGMA_API_KEY" ]; then
  exec npx figma-developer-mcp --stdio --figma-api-key="$FIGMA_API_KEY"
else
  # Otherwise, look for arguments
  exec npx figma-developer-mcp --stdio "$@"
fi