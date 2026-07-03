> **Generated — do not edit.** Regenerate with `pnpm docs:gen`.
> Source: `plugin/src/preamble/schema.ts` (verbs/props) + `src/mcp/tools/flcm-docs/{narrative,examples}`.

# Authoring with `flcm`

You **describe** a tree of nodes with plain function calls, then **render** it once.

- **Constructors are inert.** `flcm.frame(...)`, `flcm.text(...)`, etc. build plain description objects and create *nothing* on the canvas. Only `await flcm.render(tree)` creates live nodes — so you can freely build, nest, and compose trees before rendering.
- **Leaf values are CSS-familiar.** Colors, gradients, shadows, and metrics are written the way you'd write them in CSS (`"#0B1020"`, `"rgba(255,255,255,0.06)"`, `"linear-gradient(180deg, …)"`, `"24px"`, `"-0.02em"`). You write this one familiar format; we translate it to Figma-native values for you. The catch: CSS can spell things Figma can't realize, so values **outside the documented subset fail loud** (a specific error) rather than rendering wrong pixels.

There is no autocomplete and no type-checking where your code runs (a QuickJS sandbox), so everything you can write is spelled out in this reference. If a verb, prop, or value isn't documented, it isn't supported.

## The verbs

`flcm` exposes exactly these. Nothing else is on the `flcm` object.

| Verb | Builds | Arguments |
| --- | --- | --- |
| `flcm.frame(props?, children?)` | a FRAME (container) | props object, then an array of children |
| `flcm.text(content, props?)` | a TEXT node | content (a string or a runs array) first, then props |
| `flcm.rect(props?)` | a RECTANGLE | props object |
| `flcm.ellipse(props?)` | an ELLIPSE | props object |
| `flcm.line(props?)` | a LINE | props object |
| `flcm.svg(markup, props?)` | a VECTOR from SVG markup | SVG markup string first, then size/position props |
| `flcm.path(props)` | a themeable VECTOR | props object including `d` (path data) |
| `flcm.gradient(...)` | a gradient fill value | object or positional form |
| `flcm.image(url, opts?)` | an image fill value | the image url first, then { scaleMode?, placeholder? } |
| `flcm.effects({...})` | an effects value | an { shadow, blur, backgroundBlur } bag |
| `await flcm.render(tree)` | live nodes | returns { root, keyed } |

`FRAME`, `TEXT`, `RECTANGLE`, `ELLIPSE`, `LINE`, and `VECTOR` (via `flcm.svg`/`flcm.path`) are the **only** node types you can create — anything else fails loud at render. `flcm.gradient` and `flcm.effects` don't build nodes; they build *values* you pass to a `fill`/`effects` prop (you can also write the equivalent CSS string directly).

### Children and composition

- A frame's children are the **second positional argument**: an array (or a single child).
- Children may be **falsy** — `null`, `false`, `undefined` are skipped, so `showError && flcm.text(...)` composes cleanly.
- **Z-order is document order: declare back-to-front.** Earlier children sit behind later ones; there is no `z`/`layer` prop. An absolute-positioned decoration that should sit behind content is declared first.

## Props by node

Every prop is optional; an omitted prop is simply not applied (a frame with no `fill` is transparent, not white).

### Shared by every node

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | string | The node's layer name in Figma. |
| `key` | string | An address for this node — only keyed nodes come back in render()'s `keyed` map. Author-unique per render. |
| `opacity` | number (0–1) | Whole-node opacity, 0–1. |
| `mixBlendMode` | "normal" \| "multiply" \| "screen" \| "overlay" \| "soft-light" \| … (CSS mix-blend-mode) | Blend mode — a CSS mix-blend-mode name (multiply, screen, overlay, soft-light, color-dodge, …). Composites this node against what's behind it. An unknown name fails loud. |

### Size & position (frame, text, rect, ellipse)

(A `line` sizes differently — it takes a numeric `length`/`w` and ignores `h`/`"fill"`/`"hug"`.)

| Prop | Type | Notes |
| --- | --- | --- |
| `width` | number \| "fill" \| "hug" \| "N%" | Width. A number is fixed px; "N%" is a percent of the parent on this axis (free-form parent with a fixed size only). "fill" stretches to the parent (needs an auto-layout parent); "hug" shrinks to content. Not a "px" string. |
| `height` | number \| "fill" \| "hug" \| "N%" | Height. Same rules as width. |
| `absolute` | { x?, y?, anchor?: { x?, y? } } — x/y number or "N%" | Lifts the node out of its parent's auto-layout flow and pins it at x/y relative to the parent. Use for overlays, badges, decorations. x/y are px numbers or "N%" (percent of the parent axis). `anchor` picks which point of the node lands on x/y — x: "left"\|"center"\|"right", y: "top"\|"center"\|"bottom" (default { left, top }); e.g. anchor:{ x:"center" } with x:"50%" centres the node on the midpoint instead of offsetting it by its own width. |
| `pin` | { x?, y? } — x: left/center/right/stretch/scale, y: top/center/bottom/stretch/scale | Constraint override — how this node responds when its parent resizes. Overrides the auto choice (w:"fill"→stretch, "N%"→scale, percent absolute position→center, else pinned to the near edge). x: "left"\|"center"\|"right"\|"stretch"\|"scale"; y: "top"\|"center"\|"bottom"\|"stretch"\|"scale". Honored for a child of a free-form parent and for any `absolute` child; ignored on an in-flow auto-layout child (which reflows via fill/hug instead). |

#### Percent sizing

`width`, `height`, and `absolute.x`/`absolute.y` accept a **percent** string — `"50%"` — resolved against the parent's size on that axis, so you don't hand-compute pixels against a parent width you had to guess.

```js
// a progress bar filled to 35% of its track's width
flcm.frame({ width: 300, height: 8, borderRadius: 4, fill: "#E5E7EB" }, [
  flcm.rect({ width: "35%", height: 8, borderRadius: 4, fill: "#6366F1" }),
]);

// a badge pinned to the horizontal centre of a card
flcm.rect({ width: 40, height: 40, absolute: { x: "50%", y: 12 } });
```

**Percent resolves against the parent's *realized* size** — its actual rendered width/height on the canvas, not a size you had to declare up front. So a percent child of a `"fill"` track or a percent-sized parent resolves fine: the parent's real size is read after the layout settles. There is exactly **one** case that can't work, and it **fails loud** (never a wrong guess):

- **An in-flow `%`-*size* child of an auto-layout parent that *hugs* that axis.** The parent hugs to fit its children while the child sizes to a fraction of the parent — a genuine cycle. Give the parent a fixed or `"fill"` size on that axis, use `"fill"`/`"hug"` on the child, or lift the child out with `absolute` (an out-of-flow child doesn't feed the hug, so it resolves fine). A percent on the **root** node also fails loud — it has no parent.

Percent always resolves to a fixed pixel *now*. Whether it also *reflows* when the parent is later resized depends on where it sits (next section) — a percent child of an auto-layout parent is static-only, and that boundary is called out, not hidden.

**Responsive by default.** Percent (and `"fill"`) render to fixed pixels *now*, but a **positioned** child also gets a Figma **constraint** set automatically, so the design still reflows when the parent is later resized (in Figma, or by a downstream edit) — no frozen snapshot that only *looks* responsive. "Positioned" means a child of a **free-form** parent, or any **`absolute`** child (an absolute child is out of the flow, so it honors constraints even inside an auto-layout parent — that's how a badge sticks to a corner). The constraint is derived from how you sized/placed the child:

| You wrote | Auto constraint | On resize |
| --- | --- | --- |
| `width:"fill"` | stretch | grows/shrinks with the parent |
| `width:"N%"` | scale | scales proportionally |
| `absolute:{ x:"N%" }` (percent position) | center | holds its relative spot |
| a plain number (or numeric `absolute.x`) | pinned to the near edge | stays put top-left (Figma default) |

A `width:"fill"` child of a free-form parent now genuinely **stretches to the parent box** (it used to warn and do nothing). This is per-axis: `width` drives the horizontal constraint, `height` the vertical.

**Override with `pin`** when the auto choice is wrong — e.g. a badge that should hug the *right* edge instead of the left:

```js
// a close button pinned to the top-right of a free-form card, so it stays there when the card widens
flcm.frame({ width: 320, height: 200 }, [
  flcm.rect({ width: 28, height: 28, absolute: { x: 284, y: 12 }, pin: { x: "right", y: "top" } }),
]);
```

`pin` is `{ x?, y? }` — `x`: `"left"`/`"center"`/`"right"`/`"stretch"`/`"scale"`; `y`: `"top"`/`"center"`/`"bottom"`/`"stretch"`/`"scale"`. It's honored for a **free-form** parent's child and for any **`absolute`** child; an **in-flow** auto-layout child reflows through `fill`/`hug` (`layoutGrow`/stretch) instead, so `pin` is ignored there. A bad `pin` value fails loud.

**Anchor an `absolute` child by a point other than its top-left** with `absolute.anchor`. By default `x`/`y` place the node's **top-left corner**, so centring a knob on a mark means subtracting half its width by hand. `anchor` removes that math — it names which point of the node lands on `x`/`y`:

```js
// a scrub knob centred on the 40% mark of a track — no half-width offset
flcm.frame({ width: 320, height: 8, borderRadius: 4, fill: "#E5E7EB" }, [
  flcm.rect({ width: "40%", height: 8, borderRadius: 4, fill: "#6366F1" }),
  flcm.ellipse({ width: 16, height: 16, fill: "#6366F1", absolute: { x: "40%", y: "50%", anchor: { x: "center", y: "center" } } }),
]);
```

`anchor` is `{ x?, y? }` — `x`: `"left"`/`"center"`/`"right"`; `y`: `"top"`/`"center"`/`"bottom"` (default `{ left, top }`). It works with a numeric or percent `x`/`y`, and pairs naturally with percent position — `x:"100%", anchor:{ x:"right" }` pins a badge's right edge to the parent's right edge. A bad anchor value fails loud.

### flcm.frame — container props

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | color / gradient | Background paint — a color/gradient string, or flcm.gradient(...). |
| `stroke` | color / gradient | Border paint. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only (ellipses ignore it). |
| `effects` | effects value | Shadows / blur — flcm.effects({...}), or a CSS-string bag. |
| `rotation` | number (deg) | Rotation in degrees. |
| `layout` | { mode?, gap?, padding?, justifyContent?, alignItems? } | Auto-layout container config (mode/gap/padding/justifyContent/alignItems). Omitted or mode:"none" = free-form (children position absolutely). |
| `clip` | boolean | Clip children to the frame's bounds (clipsContent). Default false — like CSS, overflow is visible unless you set clip:true. |

#### Auto-layout config (the `layout` object)

| Prop | Type | Notes |
| --- | --- | --- |
| `mode` | "row" \| "column" \| "none" | Auto-layout direction. Default "none" (free-form; gap/padding/justifyContent/alignItems then do nothing). flcm cannot author grid — a "grid" attempt fails loud. |
| `gap` | number \| "Npx" | Space between children. |
| `padding` | number \| { x?, y? } \| { top?, right?, bottom?, left? } | Padding, in numbers (not "px" strings). { x, y } is shorthand: x→left+right, y→top+bottom. |
| `justifyContent` | "flex-start" \| "flex-end" \| "center" \| "space-between" | Distribution along the main axis (CSS justify-content). Realizable subset: "flex-start" (default) \| "flex-end" \| "center" \| "space-between". Figma auto-layout has no space-around/space-evenly — those fail loud. |
| `alignItems` | "flex-start" \| "flex-end" \| "center" \| "stretch" | Alignment on the cross axis (CSS align-items). "stretch" stretches every auto-sized child across the cross axis; a child with a fixed cross-axis size keeps it. (You can also stretch a single child by setting its width/height to "fill".) |

### flcm.text — text props

| Prop | Type | Notes |
| --- | --- | --- |
| `textStyle` | { fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textAlign?, lineClamp? } | Text style base (fontFamily/fontWeight/fontSize/fontStyle/lineHeight/letterSpacing/textDecoration/textAlign/lineClamp). Runs layer over it. |
| `color` | color / gradient | Text color (a solid color, normally) — a node-level sugar prop compiling to the text node's fill. |

`content` is passed first: a plain string, or an array of styled runs (below). A fixed `width` makes it wrap (grows in height); otherwise it grows sideways.

#### Text style (the `textStyle` object)

| Prop | Type | Notes |
| --- | --- | --- |
| `fontFamily` | string | Font family. An unknown family falls back to Inter. |
| `fontWeight` | number (100–900) \| name | Font weight, snapped to the nearest available style. Numbers 100–900, or names: thin/hairline, extralight/ultralight, light, normal/regular/book, medium, semibold/demibold, bold, extrabold/ultrabold, black/heavy. |
| `fontSize` | number | Font size in px. |
| `fontStyle` | "italic" \| "normal" | CSS font-style — "italic" or "normal" (no oblique). Snaps to the family's italic variant. On the base only "italic" is meaningful; "normal" is a run-delta inverse override on an italic base. |
| `lineHeight` | number(px) \| "Npx" \| "N%" \| "Nem" \| "auto" | Line height. "auto"/"normal" = the font default. em/% are relative to font size. |
| `letterSpacing` | number(px) \| "Npx" \| "N%" \| "Nem" | Tracking. em/% are relative to font size. |
| `textDecoration` | "underline" \| "line-through" \| "none" | CSS text-decoration-line — "underline" \| "line-through" \| "none". On the base only "underline"/"line-through"; "none" is a run-delta inverse override clearing an inherited decoration. (Strikethrough is also authorable inline as ~~text~~.) |
| `textAlign` | "left" \| "center" \| "right" \| "justify" | Horizontal text alignment (CSS text-align). |
| `lineClamp` | number (≥1) | Clamp the text to at most N lines, truncating with an ellipsis (…). Needs a bounded width — a fixed/`"fill"`/`"N%"` `width` — so the text wraps; on a width-hugging text there is nothing to truncate and it fails loud. N must be a whole number ≥ 1. |

### flcm.text — rich text (runs)

`flcm.text` takes **either** a plain string **or** an array of **runs** — one text node, multiple styles. The frequent decorations are **markdown right in the string**; a runs array carries anything markdown can't say.

**Markdown in a plain string** — `**bold**`, `*italic*`, `~~strike~~`, `[text](url)` — parses to styled spans:

```js
flcm.text("Ship it **today** — see the [runbook](https://ex.co/run) first.");
```

To render one of those characters **literally**, backslash-escape it: `"save 20\\% \\*today\\*"` renders `save 20% *today*`. This escape convention is shared with figma-mcp's read output, so text you read back and re-author round-trips exactly. Markdown **image** syntax `![alt](url)` fails loud — text can't embed an image; use `flcm.image(url)`.

**Runs array** — a run is a **bare string** (a plain segment) or a **`[text, style]` tuple** (a styled span). The tuple's `style` is a **delta** over the node-level `textStyle` base (the `textStyle` object in the second argument), so you set the base once and each styled span carries only what it changes; a run's text may itself contain markdown.

```js
// a feed caption as ONE node: a colored @handle, plain body, a muted "more"
flcm.text(
  [ ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
    " summited at golden hour. ",
    ["more", { color: "#8E8E93" }] ],
  { textStyle: { fontSize: 14 } },   // base style; run deltas layer over it
);
```

A run delta can override `fontWeight`, `fontSize`, `fontFamily`, `fontStyle` (`"italic"`/`"normal"`), `textDecoration` (`"underline"`/`"line-through"`/`"none"`), `color`, `lineHeight`, `letterSpacing`, and `hyperlink` — the canonical `textStyle` field names, plus `color` and `hyperlink` (base text color lives in the node's fill; base links are read-only). `textAlign`/`lineClamp` are whole-node, not per-run. A run's font resolves exactly like the node's: an unknown family falls back to Inter, a weight snaps to the nearest available style, and `fontStyle: "italic"` snaps to the family's italic variant. Each run's resolved font is preloaded and applied to its span, so a `semibold` run really renders semibold instead of silently inheriting the base weight. A fixed `width` still wraps the whole node into a flowing paragraph, so a styled paragraph is just runs + a width.

Each styled run's delta fields:

| Prop | Type | Notes |
| --- | --- | --- |
| `fontWeight` | number (100–900) \| name | Font weight, snapped to the nearest available style. Numbers 100–900, or names: thin/hairline, extralight/ultralight, light, normal/regular/book, medium, semibold/demibold, bold, extrabold/ultrabold, black/heavy. |
| `fontSize` | number | Font size in px. |
| `fontFamily` | string | Font family. An unknown family falls back to Inter. |
| `fontStyle` | "italic" \| "normal" | CSS font-style — "italic" or "normal" (no oblique). Snaps to the family's italic variant. On the base only "italic" is meaningful; "normal" is a run-delta inverse override on an italic base. |
| `lineHeight` | number(px) \| "Npx" \| "N%" \| "Nem" \| "auto" | Line height. "auto"/"normal" = the font default. em/% are relative to font size. |
| `letterSpacing` | number(px) \| "Npx" \| "N%" \| "Nem" | Tracking. em/% are relative to font size. |
| `textDecoration` | "underline" \| "line-through" \| "none" | CSS text-decoration-line — "underline" \| "line-through" \| "none". On the base only "underline"/"line-through"; "none" is a run-delta inverse override clearing an inherited decoration. (Strikethrough is also authorable inline as ~~text~~.) |
| `color` | color / gradient | Per-span text color. |
| `hyperlink` | string (url) | URL hyperlink over this span. The inline form [text](url) is usually simpler; this sets it explicitly on a tuple. URL only (a design's NODE links are read-only). |

### flcm.rect / flcm.ellipse — shape props

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | color / gradient | Background paint — a color/gradient string, or flcm.gradient(...). |
| `stroke` | color / gradient | Border paint. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only (ellipses ignore it). |
| `effects` | effects value | Shadows / blur — flcm.effects({...}), or a CSS-string bag. |
| `rotation` | number (deg) | Rotation in degrees. |

### flcm.line — line props

| Prop | Type | Notes |
| --- | --- | --- |
| `stroke` | color / gradient | The line's paint. stroke wins if both stroke and color are set. |
| `color` | color / gradient | The line's paint (alias for stroke). |
| `strokeWidth` | number \| "Npx" | Thickness. Defaults to 1. |
| `length` | number | The line's length in px. |
| `w` | number | The line's length in px — alias for `length` (`length` wins if both are set). |
| `rotation` | number (deg) | Degrees. A horizontal line rotated 90° becomes vertical. |
| `absolute` | { x?, y?, anchor?: { x?, y? } } — x/y number or "N%" | Lifts the node out of its parent's auto-layout flow and pins it at x/y relative to the parent. Use for overlays, badges, decorations. x/y are px numbers or "N%" (percent of the parent axis). `anchor` picks which point of the node lands on x/y — x: "left"\|"center"\|"right", y: "top"\|"center"\|"bottom" (default { left, top }); e.g. anchor:{ x:"center" } with x:"50%" centres the node on the midpoint instead of offsetting it by its own width. |
| `pin` | { x?, y? } — x: left/center/right/stretch/scale, y: top/center/bottom/stretch/scale | Constraint override — how this node responds when its parent resizes. Overrides the auto choice (w:"fill"→stretch, "N%"→scale, percent absolute position→center, else pinned to the near edge). x: "left"\|"center"\|"right"\|"stretch"\|"scale"; y: "top"\|"center"\|"bottom"\|"stretch"\|"scale". Honored for a child of a free-form parent and for any `absolute` child; ignored on an in-flow auto-layout child (which reflows via fill/hug instead). |

### flcm.path — vector props

(`flcm.svg` takes only the shared and size/position props above — colors are baked into the markup.)

| Prop | Type | Notes |
| --- | --- | --- |
| `d` | string | SVG path data — the `d` attribute string, e.g. "M12 2 L22 20 L2 20 Z". Any standard command works (H V S T A and relative/lowercase are auto-normalized); only genuinely malformed data fails. Required. |
| `fill` | color / gradient | Background paint — a color/gradient string, or flcm.gradient(...). |
| `stroke` | color / gradient | Border paint. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `effects` | effects value | Shadows / blur — flcm.effects({...}), or a CSS-string bag. |
| `rotation` | number (deg) | Rotation in degrees. |

## Vector art (svg & path)

Render real vector art — icons, logos, glyphs — instead of composing them from rects/ellipses or leaning on emoji/unicode glyphs (which render inconsistently and read as *content*, not iconography). There is **no built-in icon catalog**: bring your own SVG markup or path data.

Two verbs, two deliberately different contracts — they are **not** interchangeable:

- **`flcm.svg(markup, props?)`** — paste a whole `<svg>…</svg>` document (a logo, a multi-color icon) and get it as-is. **Colors are baked into the markup**, so `fill`/`stroke` do **not** apply (passing them fails loud); it takes size/position only. Use this as the opaque escape hatch.
- **`flcm.path(props)`** — one vector node from a single `d` path string. It takes our appearance props (`fill`, `stroke`, `strokeWidth`, `effects`) directly, so it **themes like any other primitive**. `d` is required.

```js
// a themeable play triangle — fills with the theme color like a rect
flcm.path({ d: "M8 5 L19 12 L8 19 Z", fill: "#6366F1", width: 24, height: 24 });

// an opaque brand logo — colors live in the markup
flcm.svg('<svg viewBox="0 0 24 24"><path d="M12 2 L22 20 L2 20 Z" fill="#0B1020"/></svg>', { width: 32, height: 32 });
```

A `path` with no `fill` is transparent (like a rect with no fill) — give it a `fill` or a `stroke`. Unparseable SVG markup or bad path `d` data fails loud rather than leaving a blank node.

**Sizing differs.** A `path` sizes to its `d` data's own bounding box (the coordinates in the string); `width`/`height` then scale that box, so a `path` needs no `width`/`height` to appear at its natural size. An `svg` instead scales its `viewBox` into the `width`/`height` you give it.

**For uniform translucency, use the node-level `opacity` prop** — it flattens the whole vector, then fades it as one layer (clean). `fill-opacity`/`stroke-opacity` baked into `svg` markup composite per-subpath, so they **seam** where subpaths overlap; reach for them only when you genuinely want per-subpath alpha.

## Paint & gradients

A paint value (for `fill`, `stroke`, `color`) is one of:

- a **solid color string** — `"#FF0000"`, `"#FF0000AA"`, `"rgba(255,0,0,0.5)"`;
- a **gradient string** — `"linear-gradient(…)"` / `"radial-gradient(…)"`;
- the result of `flcm.gradient(...)` (below); or
- the result of `flcm.image(url)` — a raster image fill (see **Images**).

```js
flcm.frame({ fill: "#0B1020" });
flcm.frame({ fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" });
flcm.frame({ fill: flcm.gradient({ stops: ["#0B1020", "#131A2E"], angle: 180 }) });
```

**`flcm.gradient(...)`** builds a gradient fill value without writing the CSS string. Two call forms:

```js
flcm.gradient({ type, stops, angle, at });          // object form
flcm.gradient("linear" | "radial", stops, angle);   // positional form
```

### flcm.gradient fields

| Prop | Type | Notes |
| --- | --- | --- |
| `type` | "linear" \| "radial" | Gradient type. Default "linear". |
| `stops` | array of color strings or { color, pos } | Color stops. Each is a color string ("#0B1020") or { color, pos } where pos is a percentage. With no pos, stops spread evenly. Required, non-empty. |
| `angle` | number (deg) | Linear only. Degrees; 180 = top→bottom (default). |
| `at` | { x?, y? } percent | Radial only — the center, in percent. Default { x: 50, y: 50 }. |

## Images

Place a **real raster image** — feed media, an avatar, a thumbnail — instead of faking it with a gradient or solid fill (which carries no signal it was ever meant to be an image).

`flcm.image(url, opts?)` is a **paint value**, like `flcm.gradient` — not a node type. An image in Figma is a fill, so **any shape carries one**: a `rect` for a photo, an `ellipse` for a circular avatar, a `frame` for a hero.

```js
// a circular avatar: an ellipse filled with an image
flcm.ellipse({ width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") });

// a feed photo, explicit scaleMode; mark a stand-in as a placeholder
flcm.rect({ width: 390, height: 260, fill: flcm.image("https://example.com/photo.jpg", { scaleMode: "FILL", placeholder: true }) });
```

- **The server fetches the bytes — your code never touches the network.** You pass a url; the trusted server fetches, validates, and downscales it, then the image renders. Any *public* http(s) url works.
- An **unfetchable, blocked (private/loopback range), oversize, or non-image url fails loud** — never a silent blank fill.

`opts` (`scaleMode`, `placeholder`) are documented in the field table below.

### flcm.image opts

| Prop | Type | Notes |
| --- | --- | --- |
| `scaleMode` | "FILL" \| "FIT" \| "CROP" \| "TILE" | How the image maps into the node box. Default "FILL" (cover). "FIT" contains it, "CROP" uses the crop transform, "TILE" repeats it. |
| `placeholder` | boolean | Mark this as a stand-in, not a real asset. Persisted on the node so a later read can tell a placeholder from a real image (and not hardcode the stand-in url as the real src). Default false. |

## Effects

An `effects` value is either the result of `flcm.effects({...})` (recommended) or a CSS-string bag: `{ boxShadow?, textShadow?, filter?, backdropFilter? }`.

```js
flcm.frame({ effects: flcm.effects({ shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" }, backgroundBlur: 16 }) });
flcm.frame({ effects: { boxShadow: "0px 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(16px)" } });
```

Blur values are written in **CSS px** — you always write the CSS number and we map it to Figma's scale for you.

### flcm.effects fields

| Prop | Type | Notes |
| --- | --- | --- |
| `shadow` | true \| object \| array | A drop (or inner) shadow. `true` for the default, or { x?, y?, blur?, spread?, color?, inner? }. Defaults: x:0, y:4, blur:8, spread:0, color:"rgba(0,0,0,0.25)". `blur` is 1:1 with CSS. |
| `blur` | number \| { layer? } | A layer blur (blurs the node itself), in CSS px. |
| `backgroundBlur` | number \| { background? } | A background blur (frosted glass — blurs what's behind), in CSS px. |
| `glass` | true \| object | Native glass (refractive frosted pane) — no CSS equivalent, so object form only. `true` for a usable default pane, or { lightIntensity 0–1, lightAngle°, refraction 0–1, depth ≥1, dispersion 0–1, radius (frost px) }. Values are raw Figma units (not CSS-scaled). |
| `noise` | true \| object | Grain overlay — object form only. `true` for a default monotone grain, or { type: "monotone"\|"duotone"\|"multitone", color, secondaryColor (duotone), opacity (multitone), noiseSize, density }. Note: the running runtime does not accept a per-noise blendMode (typing-ahead-of-runtime), so it is not exposed. |
| `texture` | true \| object | Textured surface — object form only. `true` for a default, or { noiseSize, radius, clipToShape }. |
| `progressiveBlur` | number \| object | A layer blur that ramps across the node — object form only. A number is the end radius; or { startRadius, endRadius, startOffset, endOffset }. Offsets are normalized 0–1 object space (default fade top→bottom: {x:0,y:0}→{x:0,y:1}). Raw Figma radii (not CSS-scaled). |

## render(), keys & handles

`render` is **async** — always `await` it. It loads the fonts your text needs, walks the tree creating live nodes, stamps each `key`, and returns:

```js
{
  root:  Handle,               // the top node of the tree
  keyed: { [key]: Handle }     // every node you gave a `key`
}
```

A **Handle** is a small plain object safe to return or log: `{ id, type, name, boundingBox, key?, text? }` (`text` on text nodes, `key` when the node had one). `boundingBox` is the node's **resolved** geometry — `{ x, y, width, height }`, measured after the whole tree is laid out, with `x`/`y` relative to the parent — so you can read a computed size (a 35%-wide bar, a hugged frame's real height) instead of assuming a parent width.

**Keys are opt-in addressing.** Only keyed nodes appear in `out.keyed`; unkeyed nodes stay anonymous. Keys must be **unique within a single render** (a duplicate is a loud error) and are global to the render — namespace by hand (`"email:input"`). The key is stored on the node (`pluginData("flcm/key")`).

```js
const out = await flcm.render(screen);
out.root.id;                  // the top frame's id
out.keyed.card.type;          // "FRAME"
out.keyed["email:input"].id;  // a nested keyed node
```

**Return ids or handles, never live Figma nodes.** A live node can't cross the bridge (it collapses to a bare `{ id }`), so returning one is a loud error telling you to return the id instead. The handles from `render` are safe to return as-is.

## The CSS subset

Leaf values are CSS-familiar, but only a **documented subset** is supported. Anything outside it throws a specific error naming what went wrong — it never renders wrong pixels.

### Colors

- Hex: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the 4th/8th component is alpha).
- `rgb(r, g, b)` / `rgba(r, g, b, a)` — channels are **0–255**, alpha is **0–1**. Comma, space, or slash separators are all fine (`rgb(255 0 0 / 0.5)`).
- **Not** supported (these throw): named colors (`red`, `transparent`), percent channels (`rgb(100% 0% 0%)`), other color spaces (`hsl()`, `lab()`). Use hex or `rgb`/`rgba`.

### Gradients

`linear-gradient(<head>?, <stop>, <stop>, …)`:
- `<head>` is optional: an **angle** `"<deg>deg"` (default `180`, top→bottom) **or** a side `"to top|right|bottom|left"`.
- Not supported: `grad`/`rad`/`turn` angles, corner sides (`to top right`).

`radial-gradient(<geometry>?, <stop>, …)`:
- `<geometry>` is optional: `circle` (renders as a radial), `ellipse` (renders as a diamond), and/or an `at X% Y%` center (**percentages only**).
- Not supported: pixel/keyword centers, size keywords (`closest-side`).

`conic-gradient(...)` is **not supported** (it maps to an angular gradient, outside the subset) — it throws.

**Stops** (both types): `<color> [<position>%]`, e.g. `#0B1020 0%`, `rgba(0,0,0,0.5) 70%`. A stop with no position is placed by an even spread.

```js
"linear-gradient(180deg, #0B1020 0%, #131A2E 100%)"    // ok
"linear-gradient(to right, #000, #fff)"                // ok
"radial-gradient(circle, #2A3A66 0%, #0B102000 70%)"   // ok — fades to transparent
"conic-gradient(#000, #fff)"                           // ✗ throws (angular, out of subset)
"linear-gradient(0.25turn, #000, #fff)"                // ✗ throws (only deg)
```

### Effects (CSS strings)

When you pass effects as CSS strings (`effects: { … }`):
- `boxShadow` / `textShadow`: `[inset] <x>px <y>px <blur>px [<spread>px] <color>`, comma-separated for multiple.
- `filter`: **`blur(Npx)` only** — a layer blur. Any other function (`drop-shadow(...)`, `brightness(...)`) throws.
- `backdropFilter`: **`blur(Npx)` only** — a background blur. Figma's background blur has just a radius: `saturate()`/`brightness()`/`contrast()` and other backdrop-filter functions have no equivalent and throw.

### Blend mode

`mixBlendMode` takes a CSS `mix-blend-mode` name — `multiply`, `screen`, `overlay`, `soft-light`, `hard-light`, `color-dodge`, `color-burn`, `darken`, `lighten`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`, or `normal`. Any other name throws. (Figma's `pass-through` and the linear burn/dodge modes have no CSS spelling and aren't offered.)

### Metrics

| Where | Accepts |
| --- | --- |
| `layout.gap`, `strokeWidth`, `borderRadius` | number or `"Npx"` |
| `layout.padding` (and its `x`/`y`/`top`/…) | **numbers only** (not `"px"` strings) |
| `width`, `height` | a **number** (fixed px), `"N%"` (percent of the parent's realized size — see Percent sizing), or `"fill"` / `"hug"` |
| `absolute.x/y` | a number (px) or `"N%"` (percent of the parent axis); `absolute.anchor` sets which point of the node lands there |
| `textStyle.fontSize`, `rotation`, `length`, `opacity` | numbers |
| `textStyle.lineHeight`, `textStyle.letterSpacing` | number(px), `"Npx"`, `"N%"`, `"Nem"` (lineHeight also `"auto"`) |

## What fails loud

The whole point of accepting CSS is fidelity, so the boundaries are strict. These throw a specific error rather than guessing or silently doing nothing:

| Situation | What happens |
| --- | --- |
| A color / gradient / effect outside the [CSS subset](#the-css-subset) | A parse error naming the offending value and why. |
| A **read-artifact image fill** (`{ type: "IMAGE", imageRef, … }`) on `fill`/`stroke`/`color` | Rejected: it's a ref to bytes we don't have. Author an image with `flcm.image(url)` instead. |
| An `flcm.image` url that is unfetchable, blocked (private/loopback range), oversize, or not a real image | Rejected server-side: never a silent blank fill. |
| A `flcm.text` value that is neither a plain string nor a runs array (a structured read object), or text carrying figma-mcp style-ref tokens (`{ts1}…{/ts1}`) | Rejected: those are read artifacts. Author styled text as **markdown** or a **runs array** (see Rich text). A plain-string `**` is now **markdown** (bold), not literal — backslash-escape (`\\*\\*`) for a literal. |
| Markdown **image** syntax `![alt](url)` inside a `flcm.text` string, or an unrealizable `fontStyle`/`textDecoration` value (e.g. `"oblique"`, `"overline"`) | Rejected: text can't embed an image (use `flcm.image(url)`); the enum value names the supported set. |
| A **duplicate `key`** within one render | Rejected: keys must be unique per render. |
| A node `type` other than FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR | Rejected: those are the only createable types. |
| `fill`/`stroke` on `flcm.svg` | Rejected: colors are baked into the SVG markup, so they'd be a no-op. Edit the markup, or use `flcm.path` for a themeable vector. |
| Unparseable SVG markup (`flcm.svg`) or bad path `d` data (`flcm.path`) | Rejected: never a silent empty/blank node. |
| Returning a **live Figma node** from your code | Rejected: return the id string (or a handle) instead. |
| A bad `pin` value (not `{ x?, y? }`, or an axis outside its set) | Rejected: naming the offending value and the allowed names. |
| A percent `width`/`height` (`"N%"`) on an **in-flow** child of an **auto-layout** parent that **hugs** that axis (the child both sets and depends on the parent's size — a cycle), or a percent on the **root** node | Rejected: this is the one percent case a runtime read can't break. Give the parent a fixed or `"fill"` size on that axis, use `"fill"`/`"hug"` on the child, or lift it out with `absolute` (an out-of-flow child doesn't feed the hug, so it resolves fine). Every other percent — against a fixed, `"fill"`, `"hug"`, or percent-sized parent — resolves against the parent's realized size. |
| A bad `absolute.anchor` value (an axis outside `left`/`center`/`right` or `top`/`center`/`bottom`) | Rejected: naming the offending value and the allowed names. |
| An unknown `mixBlendMode` value (not a CSS `mix-blend-mode` name) | Rejected: naming the offending value and the supported set. |
| An unrealizable `layout.justifyContent`/`layout.alignItems` value — notably `"space-around"`/`"space-evenly"` | Rejected: Figma auto-layout has no space-around/space-evenly. Use `"space-between"` or add `layout.gap`/`layout.padding`; never faked with spacer nodes (they'd read as content). |
| `textStyle.lineClamp` on a **width-hugging** text (no bounded `width`) | Rejected: truncation needs a width to wrap against — a hugging text grows on one line, so `textStyle.lineClamp` would do nothing. Set `width` to a number, `"fill"`, or `"N%"`. |

Components, variables, and prototype interactions are deliberately **out of v1** — read concepts with no create path yet. Rejecting them loudly is intentional, so you never half-write something unrealizable. (Rich text is now authorable as a runs array, and images via `flcm.image(url)` — both above.)

### The one silent exception: unrenderable glyphs

Everything above fails **loud**. There is exactly one case that does not, because the Figma plugin API exposes no glyph-coverage check to key it off: **a character the resolved font can't render draws as nothing** — no glyph, no tofu box, no error. This bites emoji and private-use codepoints (e.g. SF Symbols) in fonts like Inter that don't carry them. If text you set renders blank, suspect a missing glyph before anything else, and switch to a font that covers the codepoint. This is the sole place the surface can silently whiff; treat unusual codepoints with suspicion until you've eyeballed a screenshot.

## Worked examples

### The login screen

A gradient background, an absolute radial-glow decoration declared first (so it sits behind), a frosted card with a shadow + background blur, fixed and "fill" sizing, rgba/hex solids, numeric font weights, and keyed nodes addressed after render.

```js
const field = (key: string, label: string, placeholder: string) =>
  flcm.frame({ key, layout: { mode: "column", gap: 6 }, width: "fill" }, [
    flcm.text(label, {
      textStyle: { fontSize: 13, fontWeight: 500 },
      color: "rgba(255,255,255,0.7)",
    }),
    flcm.frame(
      {
        layout: { mode: "row", alignItems: "center", padding: { x: 16 } },
        width: "fill",
        height: 48,
        borderRadius: 12,
        fill: "rgba(255,255,255,0.06)",
        stroke: "rgba(255,255,255,0.12)",
        strokeWidth: 1,
      },
      [flcm.text(placeholder, { textStyle: { fontSize: 15 }, color: "rgba(255,255,255,0.4)" })],
    ),
  ]);

const screen = flcm.frame(
  {
    key: "login",
    name: "Login",
    layout: { mode: "column", gap: 28, padding: 32 },
    width: 390,
    height: 844,
    fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)",
  },
  [
    // Declared first → sits behind everything. Absolute, so it's out of the column flow.
    flcm.ellipse({
      name: "Glow",
      absolute: { x: -80, y: -60 },
      width: 180,
      height: 180,
      fill: "radial-gradient(circle, #2A3A66 0%, #0B102000 70%)",
      opacity: 0.6,
    }),
    flcm.text("Welcome back", {
      key: "title",
      color: "#FFFFFF",
      textStyle: { fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: "32px" },
    }),
    flcm.frame(
      {
        key: "card",
        name: "Card",
        layout: { mode: "column", gap: 16, padding: 28 },
        width: "fill",
        borderRadius: 20,
        fill: "rgba(255,255,255,0.04)",
        stroke: "rgba(255,255,255,0.08)",
        strokeWidth: 1,
        effects: flcm.effects({
          shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" },
          backgroundBlur: 16,
        }),
      },
      [
        field("email", "Email", "you@example.com"),
        field("password", "Password", "••••••••"),
        flcm.frame(
          {
            key: "submit",
            name: "Submit",
            layout: { mode: "row", justifyContent: "center", alignItems: "center" },
            width: "fill",
            height: 48,
            borderRadius: 12,
            fill: "#6366F1",
          },
          [
            flcm.text("Sign in", {
              textStyle: { fontSize: 15, fontWeight: 600 },
              color: "#FFFFFF",
            }),
          ],
        ),
      ],
    ),
  ],
);

const out = await flcm.render(screen);

return {
  root: out.root.id, // the login frame's id
  card: out.keyed.card.id, // a keyed node, addressed after render
  title: out.keyed.title.text, // "Welcome back"
};
```

### A feed caption (rich text)

One `flcm.text` node carrying three styled runs — a colored `@handle`, plain body copy, and a muted `more` — over shared base props, wrapped to a fixed width. Replaces four hand-split text nodes.

```js
// One text node, three styles: a colored @handle, plain body copy, a muted "more". The base props
// (size 15, a line height) apply to every run; each run overrides only what it changes.
const caption = flcm.text(
  [
    ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
    " summited at golden hour — the whole valley lit up. ",
    ["more", { color: "#8E8E93" }],
  ],
  {
    key: "caption",
    color: "#111827",
    width: 340,
    textStyle: { fontSize: 15, lineHeight: "20px" },
  },
);

const out = await flcm.render(caption);
return { caption: out.keyed.caption.id, text: out.keyed.caption.text };
```

### Vector art (svg & path)

Both vector contracts side by side: a themeable `flcm.path` triangle that fills with the accent color like any primitive, and an opaque `flcm.svg` mark pasted verbatim (its colors baked into the markup). No icon catalog — you bring the path data or markup.

```js
// A round "play" button: a themed circle, with a themeable play triangle (flcm.path) centered on top,
// and a brand mark pasted verbatim from SVG markup (flcm.svg) in the corner.
const player = flcm.frame({ width: 96, height: 96, borderRadius: 48, fill: "#111827" }, [
  // path themes like any primitive — the triangle fills with the accent color
  flcm.path({
    key: "play",
    d: "M38 30 L70 48 L38 66 Z",
    fill: "#6366F1",
    absolute: { x: 30, y: 24 },
  }),
  // svg pastes opaque markup (its colors are baked in — fill/stroke would be rejected here)
  flcm.svg('<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#22C55E"/></svg>', {
    width: 16,
    height: 16,
    absolute: { x: 8, y: 8 },
  }),
]);

const out = await flcm.render(player);
return { root: out.root.id, play: out.keyed.play.id };
```

### Images (real raster fills)

A feed post with a real photo as a `rect` fill and a circular avatar as an `ellipse` filled with an image. `flcm.image(url)` is a paint value, so any shape carries one; the server fetches the bytes.

```js
// A feed post: a real photo as a rect fill, and a circular avatar as an ellipse filled with an image.
// flcm.image is a paint value — any shape carries one. The server fetches the bytes; your code doesn't.
const post = flcm.frame({ layout: { mode: "column", gap: 8 }, width: 390 }, [
  flcm.rect({ width: 390, height: 260, fill: flcm.image("https://example.com/photo.jpg") }),
  flcm.frame({ layout: { mode: "row", gap: 8, padding: 12, alignItems: "center" } }, [
    flcm.ellipse({
      width: 40,
      height: 40,
      fill: flcm.image("https://example.com/avatar.jpg", { scaleMode: "FILL" }),
    }),
    flcm.text("@ridgeline", { textStyle: { fontWeight: "semibold", fontSize: 14 } }),
  ]),
]);

const out = await flcm.render(post);
return out.root.id;
```
