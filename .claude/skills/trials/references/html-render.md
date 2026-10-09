# Rendering a Figma read as HTML

How to turn what the Framelink MCP returns for a node into a file Graham can open and eyeball. The point is to see what the MCP conveys, not to make it look nice.

## Rules

- **Self-contained, no network at view time.** Inline `<style>`, no external CSS, no JS frameworks, no remote URLs.
- **Images: download and reference, don't base64-bloat.** Call `download_figma_images` into the render's assets folder and use relative `src` paths. A multi-MB inline data URI is worse, not "more self-contained." Inlining a tiny SVG in the markup is fine. If an image won't download, use a placeholder box.
- **Faithful, not creative.** Translate the layout and styling the data gives you. Don't invent decisions the data doesn't support.

## Paths

Everything goes under the scratch dir's `renders/` folder (`~/.framelink/trials/renders/`):

```
renders/<stamp>-<slug>.html
renders/assets/<stamp>-<slug>/        # downloaded images, referenced as assets/<stamp>-<slug>/x.png
```

`<stamp>` is `date "+%Y-%m-%d-%H%M"`; `<slug>` is a short kebab-case name for what was fetched (`pricing-card`, `nav-bar`). Keying the assets folder to the HTML keeps the two together and stops old renders colliding.

## After writing

`open <path>` so it pops up in the browser, then report the path in one line. `open` fails inside the Bash sandbox (`procNotFound` / `kLSNoExecutableErr`) — run it with `dangerouslyDisableSandbox: true` the first time rather than retrying sandboxed.
