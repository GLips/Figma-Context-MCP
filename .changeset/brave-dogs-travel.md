---
"figma-developer-mcp": minor
---

Add configurable `--host` CLI option for remote deployments. Use `--host` CLI argument or `FRAMELINK_HOST` environment variable to bind to addresses other than localhost (e.g., `0.0.0.0` for network access).

Also adds `FRAMELINK_PORT` environment variable (with backwards-compatible fallback to `PORT`).
