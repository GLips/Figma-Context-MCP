# render — fetch a Figma node and render it as HTML

Runs in _this_ session, not a sidequest: a quick look at how the current read output translates into a real layout. Not a trial — nothing is interviewed or reported.

## Procedure

1. Parse the target out of the argument. A Figma URL (`https://www.figma.com/design/<fileKey>/<name>?node-id=4002-634`) gives `fileKey` and `nodeId` (`4002-634` → `4002:634`); a bare node id or file key works too. A second argument, if given, is the slug.
2. Fetch fresh with `mcp__framelink-mcp__get_figma_data` — never reuse an earlier fetch; the point is the latest output. If the tool is deferred, load it with `ToolSearch` (`select:mcp__framelink-mcp__get_figma_data,mcp__framelink-mcp__download_figma_images`) and carry on without asking.
3. Write the HTML following [`../references/html-render.md`](../references/html-render.md) — rules, paths, and the `open` step are all there.

Done when the file is open in the browser and its path is reported.
