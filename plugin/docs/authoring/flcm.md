> **Generated — do not edit.** Regenerate with `pnpm docs:gen`.
> Source: `plugin/src/preamble/schema.ts` (verbs/props) + `src/mcp/tools/flcm-docs/{narrative,examples}`.

# Authoring with `flcm`

You **describe** a tree of nodes with plain function calls, then **render** it once.

- **Constructors are inert.** `flcm.frame(...)`, `flcm.text(...)`, etc. build plain description objects and create *nothing* on the canvas. Only `await flcm.render(tree)` creates live nodes — so you can freely build, nest, and compose trees before rendering.
- **CSS is the dialect — prop NAMES as well as values.** When CSS has a word for something, that is the word: `color`, `fontSize`, `fontWeight`, `borderRadius`, `opacity`, `gap`, `padding`, `justifyContent`, `alignItems`, `mixBlendMode` — camelCased, and `column`/`row` for direction. If you find yourself inventing a shorter name (`radius`, `size`, `weight`), reach for the CSS one instead. Where flcm has no CSS counterpart (`key`, `absolute`, `pin`, `width: "fill"|"hug"`) the props page is the only source — read it before your first render rather than guessing.
- **Leaf values are CSS too.** Colors, gradients, shadows, and metrics are written the way you'd write them in CSS (`"#0B1020"`, `"rgba(255,255,255,0.06)"`, `"linear-gradient(180deg, …)"`, `"24px"`, `"-0.02em"`). You write this one familiar format; we translate it to Figma-native values for you. The catch: CSS can spell things Figma can't realize, so values **outside the documented subset fail loud** (a specific error) rather than rendering wrong pixels.

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
| `flcm.image(src, opts?)` | an image fill value | an https url or a local file path (under the server's asset root) first, then { scaleMode?, placeholder? } |
| `flcm.effects({...})` | an effects value | an { shadow, blur, backgroundBlur } bag |
| `await flcm.render(tree)` | live nodes | returns { root, keyed } |
| `await flcm.edit(target, changes)` | a nudged existing node (returns its updated Handle) | target (an flcm/key, node id, flcm.id(id), or handle), then a partial delta in the same vocabulary as create |
| `await flcm.editMany(entries, scope?)` | a whole set of nudges, applied atomically (returns a Handle per entry, in order) | an array of { target, changes } — the same delta vocabulary as flcm.edit — and optionally { within } to scope key resolution. One invalid entry rejects the batch naming every offender, and nothing is applied |
| `await flcm.append(parent, thing)` | `thing` placed as the LAST child of `parent` | a parent target, then either a constructor spec (built there → { root, keyed, parent }) or a target naming a live node (MOVED there → { node, from, to }) |
| `await flcm.prepend(parent, thing)` | the same, placed FIRST | same as append |
| `await flcm.insertBefore(sibling, thing)` | `thing` placed just before `sibling` | a SIBLING target (the parent is inferred from it), then a spec or a live target |
| `await flcm.insertAfter(sibling, thing)` | `thing` placed just after `sibling` | same as insertBefore |
| `await flcm.move(target, parent)` | the node reparented as `parent`'s last child | a live target, then a parent target. Creating is append's job — a spec here fails loud |
| `await flcm.remove(target)` | nothing — deletes the node and its subtree | a target; returns { removedId, parent } |
| `await flcm.clone(target, parent?)` | a faithful live duplicate (key-less) | a target, and optionally where the copy lands (default: beside the original). The copy path for subtrees a spec rebuild can't reproduce — anything holding an INSTANCE |
| `flcm.fromRead(spec)` | a `get` result re-authored as a buildable spec | a spec from flcm.get, subtree and all — the constructor is picked by each node's `type` and `children` recurse. Returns a constructor-built node — render it, or place it with append/prepend/insertBefore/insertAfter. (A single node's spec can also spread straight into its constructor: flcm.rect({ ...spec, width: 320 }).) Anything the read shape carries that flcm has no word for (an INSTANCE, a paint stack, a grid) fails loud by name; flcm.clone is the faithful copy for those |
| `await flcm.get(target)` | a node's full read spec (values inline) | target: an flcm/key, a node id, flcm.id(id), or a handle |
| `await flcm.find(query?, predicate?)` | matching nodes as slim handles | query { type?, name?, key?, within? } AND-combined — a filter, not an address; only `within` takes a target. Optional predicate over the full read shape (n => n.fills?.[0] === '#FFF') |
| `await flcm.findOne(query?, predicate?)` | exactly one slim handle (throws on 0 or >1) | same query + predicate as find |
| `await flcm.selection()` | the current selection as slim handles | no args |
| `await flcm.page.current()` | where you are — { fileName, page, pages } | no args. The orientation call: the file's name, the page every other verb acts on, and the file's other pages |
| `await flcm.page.use(nameOrId)` | the switched-to page's info | a page name or page id. Never creates: a miss fails loud listing the file's pages |
| `await flcm.page.new(name)` | a new page, switched to | a page name the file doesn't already use (a taken name fails loud and creates nothing, so a retry can't mint a twin) |
| `flcm.id(nodeId)` | a raw-id target ref | a node id string — resolved as an id, never scanned as an flcm/key |

`FRAME`, `TEXT`, `RECTANGLE`, `ELLIPSE`, `LINE`, and `VECTOR` (via `flcm.svg`/`flcm.path`) are the **only** node types you can create — anything else fails loud at render. `flcm.gradient` and `flcm.effects` don't build nodes; they build *values* you pass to a `fill`/`effects` prop (you can also write the equivalent CSS string directly).

### Children and composition

- A frame's children are the **second positional argument**: an array (or a single child).
- Children may be **falsy** — `null`, `false`, `undefined` are skipped, so `showError && flcm.text(...)` composes cleanly.
- **Z-order is document order: declare back-to-front.** Earlier children sit behind later ones; there is no `z`/`layer` prop. An absolute-positioned decoration that should sit behind content is declared first.

## Props by node

Every prop is optional; an omitted prop is simply not applied (a frame with no `fill` is transparent, not white).

**A `get` result's own spellings are accepted too.** Spread a read spec into any constructor or `flcm.edit` — `flcm.rect({ ...spec, width: 320 })`, `flcm.text(spec)` — and its `fills`/`strokes`, `left`/`top`, node-level `boldWeight` and `text` land on the matching props below; naming one thing both ways in one call (`fills` and `fill`) fails loud. Fields flcm has no word for (an INSTANCE's `componentId`, `strokeDashes`, a grid) fail loud by name. A spec with `children` needs `flcm.fromRead(spec)`, which rebuilds the whole subtree.

### Shared by every node

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | string | Layer name. |
| `key` | string | An address for this node — only keyed nodes come back in render()'s `keyed` map. Author-unique per render. |
| `opacity` | number (0–1) | Whole-node opacity, 0–1. |
| `mixBlendMode` | "normal" \| "multiply" \| "screen" \| "overlay" \| "soft-light" \| … (CSS mix-blend-mode) | A CSS mix-blend-mode name. An unknown one fails loud. |
| `visible` | boolean | Layer visibility. A hidden node is invisible to find/get too, so re-target it by id. |
| `locked` | boolean | Locks the layer against pointer edits in Figma's UI. flcm.edit still writes to it. |

### Size & position (frame, text, rect, ellipse)

(A `line` sizes differently — it takes a numeric `length`/`w` and ignores `h`/`"fill"`/`"hug"`.)

| Prop | Type | Notes |
| --- | --- | --- |
| `width` | number \| "Npx" \| "N%" \| "fill" \| "hug" | A fixed size (a number or "Npx"), "N%" of the parent axis, "fill" (stretch to the parent — rejected on the root), or "hug" (shrink to content — only a row/column container or text can hug). |
| `height` | number \| "fill" \| "hug" \| "N%" | Same rules as width. On TEXT the height follows the content: set `width` or use "fill"; a fixed, "hug", or percent height is rejected. |
| `absolute` | { x?, y?, anchor?: { x?, y? } } \| "none" — x/y number, "Npx" or "N%" | Pins the node at x/y in its parent, lifting it out of auto-layout flow (badges, overlays). On a render root it is where on the PAGE the tree lands — without it every root stacks at the origin. `anchor` picks the node's own reference point (default { left, top }), so anchor:{ x:"center" } with x:"50%" centres it. Under edit, "none" returns the node to the flow. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how the node responds when its parent resizes, replacing the automatic choice. Honored for a child of a free-form parent and for any `absolute` child; on an in-flow auto-layout child it is stored but inert (fill/hug governs there) until the node leaves the flow. Under edit, "none" restores the default near-edge pin. |

#### Percent sizing

`width`, `height`, and `absolute.x`/`absolute.y` take a percent string — `"50%"` of the parent's size on that axis, resolved against its *realized* size once layout settles (so a percent child of a `"fill"` or percent-sized parent is fine).

```js
flcm.frame({ width: 300, height: 8, borderRadius: 4, fill: "#E5E7EB" }, [
  flcm.rect({ width: "35%", height: 8, borderRadius: 4, fill: "#6366F1" }),   // 35% of the track
]);
```

One case can't resolve and **fails loud**: an in-flow percent-*sized* child of an auto-layout parent that *hugs* that axis — the parent sizes to the child while the child sizes to the parent. Give the parent a fixed or `"fill"` size, or lift the child out with `absolute`. A percent (or `"fill"`) on the **root** fails loud too: its parent is the page, which is unbounded.

**Responsive by default.** A percent renders to fixed pixels now, and a **positioned** child — one in a free-form parent, or any `absolute` child — also gets a Figma constraint, so it still reflows when the parent is resized later. Per axis, derived from how you sized it:

| You wrote | Auto constraint | On resize |
| --- | --- | --- |
| `width:"fill"` | stretch | grows/shrinks with the parent |
| `width:"N%"` | scale | scales proportionally |
| `absolute:{ x:"N%" }` | center | holds its relative spot |
| a plain number | near edge | stays put (Figma default) |

**`pin`** overrides that choice; **`absolute.anchor`** picks which point of the node lands on `x`/`y` (default top-left), which is what saves the half-width subtraction when centring:

```js
// a close button that stays top-right as the card widens
flcm.frame({ width: 320, height: 200 }, [
  flcm.rect({ width: 28, height: 28, absolute: { x: 284, y: 12 }, pin: { x: "right", y: "top" } }),
]);

// a knob centred on the 40% mark
flcm.ellipse({ width: 16, height: 16, absolute: { x: "40%", y: "50%", anchor: { x: "center", y: "center" } } });
```

`pin` is ignored on an in-flow auto-layout child, which reflows through `fill`/`hug` instead. A bad `pin` or `anchor` value fails loud.

### flcm.frame — container props

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | color / gradient | Background paint: a color/gradient string or flcm.gradient(...). "none" removes it. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only. |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |
| `layout` | { mode?, gap?, padding?, justifyContent?, alignItems? } | Auto-layout config. Omitted or mode:"none" = free-form, where children position absolutely. |
| `clip` | boolean | Clip children to the frame's bounds. Default false, like CSS overflow: visible. |

#### Auto-layout config (the `layout` object)

| Prop | Type | Notes |
| --- | --- | --- |
| `mode` | "row" \| "column" \| "none" | Auto-layout direction. Default "none" = free-form, where the other layout words reject loud. No grid: "grid" fails loud. |
| `gap` | number \| "Npx" | Space between children. |
| `padding` | number \| "12px 16px" \| { x?, y? } \| { top?, right?, bottom?, left? } | A number, the CSS box shorthand ("12px 16px"), { x, y } (x→left+right, y→top+bottom), or per-edge. Edge values take a number or "Npx". |
| `justifyContent` | "flex-start" \| "flex-end" \| "center" \| "space-between" | CSS justify-content, main axis. Figma has no space-around/space-evenly — those fail loud. |
| `alignItems` | "flex-start" \| "flex-end" \| "center" \| "stretch" | CSS align-items, cross axis. "stretch" stretches every auto-sized child (a fixed cross-axis size wins); one child alone stretches via width/height "fill". |

### flcm.text — text props

| Prop | Type | Notes |
| --- | --- | --- |
| `textStyle` | { fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, boldWeight?, lineClamp? } | The text style base. Runs layer over it. |
| `color` | color / gradient | Text color — the node-level spelling of the text's fill. |

`content` is passed first: a plain string, or an array of styled runs (below). A fixed `width` makes it wrap (grows in height); otherwise it grows sideways.

#### Text style (the `textStyle` object)

| Prop | Type | Notes |
| --- | --- | --- |
| `fontFamily` | string | An unknown family falls back to Inter. |
| `fontWeight` | number (100–900) \| name | Snapped to the nearest available style. Numbers 100–900, or CSS names (light, normal, medium, semibold, bold, black, …). |
| `fontSize` | number | Font size in px. |
| `fontStyle` | "italic" \| "normal" | CSS font-style, no oblique. Snaps to the family's italic variant. On the base only "italic" means anything; "normal" is a run delta clearing an italic base. |
| `lineHeight` | number(px) \| "Npx" \| "N%" \| "Nem" \| "auto" | Line height. "auto"/"normal" = the font default. |
| `letterSpacing` | number(px) \| "Npx" \| "N%" \| "Nem" | Tracking. |
| `textDecoration` | "underline" \| "line-through" \| "none" | CSS text-decoration-line. On the base "none" means nothing; it is a run delta clearing an inherited decoration. Strikethrough is also inline: ~~text~~. |
| `textAlign` | "left" \| "center" \| "right" \| "justify" | CSS text-align. |
| `textAlignVertical` | "top" \| "center" \| "bottom" | Vertical alignment in the text box. Whole-node only, never a run delta. |
| `textTransform` | "uppercase" \| "lowercase" \| "capitalize" \| "none" | CSS text-transform — re-cases the glyphs, not the characters. "none" restores the original casing and clears a fontVariant (same Figma slot). |
| `fontVariant` | "small-caps" \| "all-small-caps" | CSS font-variant-caps. Shares one Figma slot with `textTransform`, so naming both fails loud. |
| `paragraphSpacing` | number \| "Npx" | Space between paragraphs. |
| `paragraphIndent` | number \| "Npx" | First-line indent. |
| `listSpacing` | number \| "Npx" | Space between list items. |
| `hyperlink` | string (url) \| { type: "URL", url } | A URL over the whole text node — a url string, or the read form { type: "URL", url }. Links to a NODE are read-only and fail loud. |
| `boldWeight` | number (100–900) \| name | What `**bold**` resolves to in this node. Default 700 — pass back the `boldWeight` a `get` reports and the copy emphasizes like the original. Same spellings as fontWeight. |
| `lineClamp` | number (≥1) \| "none" | Truncate to at most N lines with an ellipsis. Needs a bounded `width` so the text wraps — on a hugging text it fails loud. `"none"` removes a clamp. |

### flcm.text — rich text (runs)

`flcm.text` takes **either** a plain string **or** an array of **runs** — one text node, several styles.

**Markdown in a plain string** — `**bold**`, `*italic*`, `~~strike~~`, `[text](url)` — parses to styled spans:

```js
flcm.text("Ship it **today** — see the [runbook](https://ex.co/run) first.");
```

Backslash-escape to render one literally: `"save 20% \\*today\\*"`. Only `\ * _ ~ [ ] ( ) { }` are escapable, and this matches figma-mcp's read output, so text you read back round-trips. `![alt](url)` fails loud — use `flcm.image(url)`.

**Runs array** — a run is a bare string or a `[text, style]` tuple. The style is a **delta** over the node-level `textStyle` base, so each span carries only what it changes:

```js
// a feed caption as ONE node: a colored @handle, plain body, a muted "more"
flcm.text(
  [ ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
    " summited at golden hour. ",
    ["more", { color: "#8E8E93" }] ],
  { textStyle: { fontSize: 14 } },
);
```

A run resolves its font exactly as the node does, and its delta may set any field in the table below. `textAlign`, `textAlignVertical` and `lineClamp` are whole-node only. A fixed `width` wraps the node into a flowing paragraph, so a styled paragraph is runs + a width.

Each styled run's delta fields:

| Prop | Type | Notes |
| --- | --- | --- |
| `fontWeight` | number (100–900) \| name | Snapped to the nearest available style. Numbers 100–900, or CSS names (light, normal, medium, semibold, bold, black, …). |
| `fontSize` | number | Font size in px. |
| `fontFamily` | string | An unknown family falls back to Inter. |
| `fontStyle` | "italic" \| "normal" | CSS font-style, no oblique. Snaps to the family's italic variant. On the base only "italic" means anything; "normal" is a run delta clearing an italic base. |
| `lineHeight` | number(px) \| "Npx" \| "N%" \| "Nem" \| "auto" | Line height. "auto"/"normal" = the font default. |
| `letterSpacing` | number(px) \| "Npx" \| "N%" \| "Nem" | Tracking. |
| `textDecoration` | "underline" \| "line-through" \| "none" | CSS text-decoration-line. On the base "none" means nothing; it is a run delta clearing an inherited decoration. Strikethrough is also inline: ~~text~~. |
| `textTransform` | "uppercase" \| "lowercase" \| "capitalize" \| "none" | CSS text-transform — re-cases the glyphs, not the characters. "none" restores the original casing and clears a fontVariant (same Figma slot). |
| `fontVariant` | "small-caps" \| "all-small-caps" | CSS font-variant-caps. Shares one Figma slot with `textTransform`, so naming both fails loud. |
| `paragraphSpacing` | number \| "Npx" | Space between paragraphs. |
| `paragraphIndent` | number \| "Npx" | First-line indent. |
| `listSpacing` | number \| "Npx" | Space between list items. |
| `color` | color / gradient | Per-span text color. |
| `hyperlink` | string (url) \| { type: "URL", url } | A URL over THIS span — inline `[text](url)` is usually simpler. Links to a NODE are read-only and fail loud. |

### flcm.rect / flcm.ellipse — shape props

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | color / gradient | Background paint: a color/gradient string or flcm.gradient(...). "none" removes it. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only. |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |

### flcm.line — line props

| Prop | Type | Notes |
| --- | --- | --- |
| `stroke` | color / gradient | The line's paint. Wins over `color`. |
| `color` | color / gradient | The line's paint (alias for stroke). |
| `strokeWidth` | number \| "Npx" | Thickness. Defaults to 1. |
| `length` | number | The line's length in px. |
| `w` | number | Alias for `length`, which wins if both are set. |
| `rotation` | number (deg) | Degrees — 90° makes a horizontal line vertical. |
| `absolute` | { x?, y?, anchor?: { x?, y? } } \| "none" — x/y number, "Npx" or "N%" | Pins the node at x/y in its parent, lifting it out of auto-layout flow (badges, overlays). On a render root it is where on the PAGE the tree lands — without it every root stacks at the origin. `anchor` picks the node's own reference point (default { left, top }), so anchor:{ x:"center" } with x:"50%" centres it. Under edit, "none" returns the node to the flow. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how the node responds when its parent resizes, replacing the automatic choice. Honored for a child of a free-form parent and for any `absolute` child; on an in-flow auto-layout child it is stored but inert (fill/hug governs there) until the node leaves the flow. Under edit, "none" restores the default near-edge pin. |

### flcm.path — vector props

(`flcm.svg` takes only the shared and size/position props above — colors are baked into the markup.)

| Prop | Type | Notes |
| --- | --- | --- |
| `d` | string | SVG path data, e.g. "M12 2 L22 20 L2 20 Z". Every standard command works (relative/shorthand are normalized); only malformed data fails. Required. |
| `fill` | color / gradient | Background paint: a color/gradient string or flcm.gradient(...). "none" removes it. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |

## Vector art (svg & path)

Render real vector art — icons, logos, glyphs — instead of composing them from rects/ellipses or leaning on emoji (which render inconsistently and read as *content*, not iconography). There is **no built-in icon catalog**: bring your own SVG markup or path data.

Two verbs, two contracts — not interchangeable:

- **`flcm.svg(markup, props?)`** — paste a whole `<svg>…</svg>` and get it as-is. Colors are baked into the markup, so `fill`/`stroke` fail loud here; it takes size/position only.
- **`flcm.path(props)`** — one vector from a single `d` string, taking our appearance props, so it themes like any other primitive. `d` is required.

```js
// a themeable play triangle — fills with the theme color like a rect
flcm.path({ d: "M8 5 L19 12 L8 19 Z", fill: "#6366F1", width: 24, height: 24 });

// an opaque brand logo — colors live in the markup
flcm.svg('<svg viewBox="0 0 24 24"><path d="M12 2 L22 20 L2 20 Z" fill="#0B1020"/></svg>', { width: 32, height: 32 });
```

A `path` with no `fill` is transparent, like a rect. Unparseable markup or bad `d` data fails loud rather than leaving a blank node.

**Sizing differs.** A `path` sizes to its `d` data's bounding box and needs no `width`/`height` to appear at natural size; `width`/`height` scale that box. An `svg` scales its `viewBox` into the size you give it.

**For uniform translucency use node-level `opacity`** — it flattens the vector and fades it as one layer. `fill-opacity`/`stroke-opacity` inside markup composite per-subpath, so they seam where subpaths overlap.

## Paint & gradients

A paint value (for `fill`, `stroke`, `color`) is one of:

- a **solid color string** — `"#FF0000"`, `"#FF0000AA"`, `"rgba(255,0,0,0.5)"`;
- a **gradient string** — `"linear-gradient(…)"` / `"radial-gradient(…)"`;
- `flcm.gradient(...)`, which builds the same value without the string; or
- `flcm.image(src)` — a raster fill from a url or local path (see **Images**).

```js
flcm.frame({ fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" });
flcm.frame({ fill: flcm.gradient({ stops: ["#0B1020", "#131A2E"], angle: 180 }) });
flcm.gradient("linear" | "radial", stops, angle);   // the positional form
```

### flcm.gradient fields

| Prop | Type | Notes |
| --- | --- | --- |
| `type` | "linear" \| "radial" | Gradient type. Default "linear". |
| `stops` | array of color strings or { color, pos } | Color stops. Each is a color string ("#0B1020") or { color, pos } where pos is a percentage. With no pos, stops spread evenly. Required, non-empty. |
| `angle` | number (deg) | Linear only. Degrees; 180 = top→bottom (default). |
| `at` | { x?, y? } percent | Radial only — the center, in percent. Default { x: 50, y: 50 }. |

## Images

Place a **real raster image** — feed media, an avatar, a thumbnail — instead of faking it with a gradient (which carries no signal it was ever meant to be an image).

`flcm.image(src, opts?)` is a **paint value**, like `flcm.gradient` — not a node type. An image in Figma is a fill, so any shape carries one: a `rect` for a photo, an `ellipse` for a circular avatar, a `frame` for a hero. `src` is an https url or a local file path, like CSS `url()`.

```js
flcm.ellipse({ width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") });
flcm.rect({ width: 120, height: 40, fill: flcm.image("public/logo.png", { scaleMode: "FIT" }) });
```

- **The server loads the bytes** — your code never touches the network or the filesystem. Any public http(s) url works.
- **Local paths are confined to the server's asset root** (`--asset-root`, default: the directory the server started in). A path outside it is refused, naming the root.
- An **unfetchable, blocked, out-of-root, oversize, or non-image source fails loud** — never a silent blank fill.

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

**`glass` needs a high-frequency backdrop to read as glass.** `refraction` and `dispersion` bend what is *behind* the pane, so over a flat fill or a smooth gradient there is nothing to bend and the result looks like a plain frosted tint — that's the physics of the scene, not a broken effect. Put busy content behind it (an image, dense text, an icon grid, a sharp-edged shape) and the refraction becomes visible.

### flcm.effects fields

| Prop | Type | Notes |
| --- | --- | --- |
| `shadow` | true \| object \| array | A drop (or inner) shadow. `true` for the default, or { x?, y?, blur?, spread?, color?, inner? }. Defaults: x:0, y:4, blur:8, spread:0, color:"rgba(0,0,0,0.25)". `blur` is 1:1 with CSS. |
| `blur` | number \| { layer? } | A layer blur (blurs the node itself), in CSS px. |
| `backgroundBlur` | number \| { background? } | A background blur (frosted glass — blurs what's behind), in CSS px. |
| `glass` | true \| object | Native glass (refractive frosted pane) — no CSS equivalent, so object form only. `true` for a usable default pane, or { lightIntensity 0–1, lightAngle°, refraction 0–1, depth ≥1, dispersion 0–1, radius (frost px) }. Values are raw Figma units (not CSS-scaled). |
| `noise` | true \| object | Grain overlay — object form only. `true` for a default monotone grain, or { type: "monotone"\|"duotone"\|"multitone", color, secondaryColor, opacity, noiseSize, density }. Two fields are scoped to one `type` and are REJECTED on any other: `secondaryColor` is **duotone only**, and `opacity` is **multitone only** — on the default monotone grain it fails, so vary `density`/`color` alpha instead. Note: the running runtime does not accept a per-noise blendMode (typing-ahead-of-runtime), so it is not exposed. |
| `texture` | true \| object | Textured surface — object form only. `true` for a default, or { noiseSize, radius, clipToShape }. |
| `progressiveBlur` | number \| object | A layer blur that ramps across the node — object form only. A number is the end radius; or { startRadius, endRadius, startOffset, endOffset }. Offsets are normalized 0–1 object space (default fade top→bottom: {x:0,y:0}→{x:0,y:1}). Raw Figma radii (not CSS-scaled). |

## render(), keys & handles

`render` is **async** — always `await` it. It loads fonts, creates the nodes, stamps each `key`, and returns:

```js
{
  root:  Handle,               // the top node of the tree
  keyed: { [key]: Handle }     // every node you gave a `key`
}
```

A **Handle** is a plain object safe to return or log: `{ id, type, name, width, height, key?, text?, intent?, position?, left?, top? }`.

`width`/`height` are **always numbers** — real px measured after layout settles, so `bar.width + 8` works. They're the node's own size, unaffected by `rotation`.

```js
out.keyed.bar.width;      // 320       — what it came out at
out.keyed.bar.intent;     // { width: "fill" }
out.keyed.chip.intent;    // undefined — a plainly fixed node
```

**`intent` tells you whether that number is yours to keep.** It appears only on an axis the layout owns (`"fill"`/`"hug"`), which re-measures whenever the parent or content changes — reading `320` off a `"fill"` bar and hardcoding it is how a responsive design silently becomes fixed.

`left`/`top` are the offset in the parent, present **only when the parent doesn't place the node** (a child of a plain frame, or an `absolute` one — which also carries `position: "absolute"`).

`get`/`find` name geometry the same way, with one difference: `render` just measured, so it gives the number *and* the rule; `find` reports `width: "fill"` and withholds the px, so nothing tempts you to pin a size the design didn't fix.

**Keys are opt-in addressing.** Only keyed nodes appear in `out.keyed`. They must be unique within a render (a duplicate is a loud error) and are global to it, so namespace by hand (`"email:input"`). The key is stored on the node (`pluginData("flcm/key")`).

**Return ids or handles, never live Figma nodes** — a live node can't cross the bridge, so returning one is a loud error.

## edit() / editMany() — changing existing nodes

`await flcm.edit(target, changes)` applies a partial delta to one existing node and returns its updated handle. The target is anything the read verbs accept: an flcm/key, a node id, `flcm.id(id)`, or a handle from `render`/`find`. The delta uses the **same words as create** — there is no separate edit dialect — and only the fields you pass change; everything else on the node is untouched.

### Editable fields

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | string | Layer name. |
| `opacity` | number (0–1) | Whole-node opacity, 0–1. |
| `mixBlendMode` | "normal" \| "multiply" \| "screen" \| "overlay" \| "soft-light" \| … (CSS mix-blend-mode) | A CSS mix-blend-mode name. An unknown one fails loud. |
| `visible` | boolean | Layer visibility. A hidden node is invisible to find/get too, so re-target it by id. |
| `locked` | boolean | Locks the layer against pointer edits in Figma's UI. flcm.edit still writes to it. |
| `fill` | color / gradient | Background paint: a color/gradient string or flcm.gradient(...). "none" removes it. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only. |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |
| `clip` | boolean | Clip children to the frame's bounds. Default false, like CSS overflow: visible. |
| `width` | number \| "Npx" \| "N%" \| "fill" \| "hug" | A fixed size (a number or "Npx"), "N%" of the parent axis, "fill" (stretch to the parent — rejected on the root), or "hug" (shrink to content — only a row/column container or text can hug). |
| `height` | number \| "fill" \| "hug" \| "N%" | Same rules as width. On TEXT the height follows the content: set `width` or use "fill"; a fixed, "hug", or percent height is rejected. |
| `absolute` | { x?, y?, anchor?: { x?, y? } } \| "none" — x/y number, "Npx" or "N%" | Pins the node at x/y in its parent, lifting it out of auto-layout flow (badges, overlays). On a render root it is where on the PAGE the tree lands — without it every root stacks at the origin. `anchor` picks the node's own reference point (default { left, top }), so anchor:{ x:"center" } with x:"50%" centres it. Under edit, "none" returns the node to the flow. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how the node responds when its parent resizes, replacing the automatic choice. Honored for a child of a free-form parent and for any `absolute` child; on an in-flow auto-layout child it is stored but inert (fill/hug governs there) until the node leaves the flow. Under edit, "none" restores the default near-edge pin. |
| `layout` | { mode?, gap?, padding?, justifyContent?, alignItems? } | Auto-layout config. Omitted or mode:"none" = free-form, where children position absolutely. |
| `length` | number | The line's length in px. |
| `w` | number | Alias for `length`, which wins if both are set. |
| `content` | string \| run[] | Replacement text — the same string-or-runs input flcm.text takes first. Replaces the whole content. |
| `textStyle` | { fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, boldWeight?, lineClamp? } | The text style base. Runs layer over it. |
| `color` | color / gradient | Text color — the node-level spelling of the text's fill. |

### Words by node type

- **FRAME** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `fill`, `stroke`, `strokeWidth`, `borderRadius`, `effects`, `rotation`, `layout`, `clip`
- **TEXT** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `textStyle`, `color`, `content`
- **RECTANGLE / ELLIPSE** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `fill`, `stroke`, `strokeWidth`, `borderRadius`, `effects`, `rotation`
- **LINE** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `stroke`, `color`, `strokeWidth`, `length`, `w`, `rotation`, `absolute`, `pin`
- **VECTOR (path- or svg-born)** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `fill`, `stroke`, `strokeWidth`, `effects`, `rotation`

On a node type flcm can't create (GROUP, INSTANCE, COMPONENT, …) only the shared words apply: `name`, `opacity`, `mixBlendMode`, `visible`, `locked`.

### Removal — the `"none"` word

`"none"` is the one removal word, surface-wide: `fill`/`stroke` clear the paint, `effects` clears every effect, `absolute` returns the node to its parent's flow, `pin` (or `pin: { x: "none" }` per axis) restores the near-edge default, `layout: { mode: "none" }` switches auto-layout off. The same spellings are legal at create, where they mean the explicit default. Sizes are never removed, only replaced within the number/`"fill"`/`"hug"` trio — `width: "hug"` is how a fixed width comes off.

### Rules

- **A node type takes exactly the words create accepts for it.** `fill` on a LINE, `clip` on a TEXT, `borderRadius` on a VECTOR — each rejects loud, naming the prop, the type, and that type's editable words.
- **Only the fields you pass change — per axis, too.** `pin: { x: "center" }` keeps the y pin; `absolute: { x: 10 }` keeps the live y; `width: "hug"` leaves the height alone.
- **Un-filling really un-fills.** `width: 80` or `"hug"` on a `"fill"` child clears the grow/stretch marks — the new size governs.
- **Container edits ripple by stated rules.** `layout.alignItems: "stretch"` walks the live children setting their stretch marks; any other value clears every one (Figma doesn't record which child stretched because of the container, so a child that should keep filling needs its own `height: "fill"`). Changing direction — row↔column, or `"none"` to either — clears both flow marks on every in-flow child, since the axes they meant just moved.
- **Layout legality is create's rule set, applied to live facts** and rejected before any write: a percent on an in-flow child of a hugging parent, `"fill"`/`"N%"` under the page, `"hug"` with nothing to measure, a fixed/hug/percent `height` on TEXT, or container words on a frame that isn't (and after this delta still won't be) a row/column container. Percents resolve immediately against the live parent.
- **Text words read the LIVE node.** `content` replaces the whole text and collapses it to its LEADING run's style — prior bold spans and per-range colors do NOT survive, so style the new text in the same edit. A `textStyle` naming part of the font triple keeps the live rest (`fontWeight: "bold"` on italic Roboto stays bold italic Roboto). A text that already MIXES fonts has no single base: a partial font change, or a styled `content` run without its own `fontFamily`, rejects loud — anchor `textStyle.fontFamily` in the same edit, or give every run its family. `lineClamp` needs a bounded width.
- **Edits inside a component INSTANCE apply as overrides.** A property Figma forbids overriding rejects, naming the instance — edit the main component (flcm never auto-detaches).
- **`key` is immutable** — re-keying could mint a duplicate address. Set `name` to change the layers panel.
- **No bare `x`/`y`** — position is `absolute: { x, y }`, resize behavior is `pin`.
- **An empty delta is rejected**, since it would still mint an undo step.
- **Each edit is one undo step.** The whole delta validates before the first write; a Figma refusal mid-apply rolls the node back, and the error carries the target's identity, Figma's reason, and how many earlier mutating calls still stand.
- Delta values are **absolute**, never relative (`+10`), so re-running an edit converges instead of compounding.

### Many at once — `flcm.editMany`

`await flcm.editMany([{ target, changes }, …], { within? })` applies a whole set of deltas as **one** call, returning a handle per entry in order. Each `changes` is exactly an `flcm.edit` delta.

Reach for it whenever you're nudging more than one node — a loop over `flcm.edit` is not the same thing:

- **The set is atomic.** Every target resolves and every delta validates before the first write; a loop would already have mutated entries 1–3 when entry 4's typo surfaced.
- **One rejection names every bad entry**, indexed, so you fix the batch in one pass.
- **The whole batch is one undo step.**
- **Order doesn't matter** — entries settle ancestors-first, so turning a parent into a row and setting its child to `width: "fill"` works either way round.
- **Two entries for the same node reject** rather than last-wins; put both fields in one entry.

Props only: tree shape stays with `append`/`move`/`remove`/`clone`.

## Tree shape — placing, moving, removing

Tree shape is its own set of verbs, and **position is the verb** — no index argument, no options bag. `append`/`prepend` take the parent; `insertBefore`/`insertAfter` take a **sibling** and work out the parent from it.

`thing` is one of two, meaning what they mean in the DOM:

- a **constructor spec** — built inside the destination. Returns `{ root, keyed, to }`: what `render` gives you, plus the container it landed in.
- a **target naming a live node** — **moved** there, as `appendChild` moves an attached DOM node. Returns `{ node, from, to }`.

Three more complete the set: `flcm.move(target, parent)` is the plain reparent (subject named first, node lands last), `flcm.remove(target)` deletes a node and its subtree, `flcm.clone(target, parent?)` duplicates one.

**`clone` is the copy path for subtrees a rebuild can't reproduce** — anything containing an INSTANCE, which is most real content. It duplicates the LIVE node, and the copy comes back **key-less** (a raw `node.clone()` would copy the `flcm/key` too, giving two nodes one address). It is faithful down to coordinates, so in a free-form parent it lands on top of the original — edit its `absolute` to separate them.

Every return carries the subject plus each container whose geometry could have changed — flat handles with fresh geometry, never nested trees. `to` is where things ended up, `from` is what something left; either is absent when that container is the page, and `from` is absent when you reordered inside one parent.

### Rules

- **Sizing that depends on the parent works on insert.** The node is attached *before* it is sized, so `width: "fill"` on an appended spec fills the destination.
- **Layout legality is re-asked against the DESTINATION**, with the new parent's facts: `"fill"`/`"N%"` into a page parent, a TEXT `height: "fill"` landing out of a row/column flow, a percent child of a hugging parent, or any parent-relative word under a GRID parent each reject loud before anything moves. Legal where a node sat is not automatically legal where it lands.
- **A move re-aims the moved node's fill.** `"fill"` is a mark on the parent's primary or counter axis, and those axes move with the node, so it is cleared and re-applied against the new parent. Fixed sizes are untouched.
- **A stretch container does not stretch what you insert.** Figma stores no container-level stretch — a stretched child is indistinguishable from one that asked for counter-axis `"fill"` — so re-assert it with `flcm.edit(parent, { layout: { alignItems: "stretch" } })`, which re-synthesizes the marks over every child.
- **An instance's CHILD LIST is closed.** Placing into an instance, or moving/removing one of its children, rejects loud and names it — edit the main component instead. The instance itself is an ordinary node: moving, removing and cloning it are fine.
- **A node can't be placed inside itself or its own subtree**; the refusal names both nodes.
- **Each call is one undo step**, with `edit`'s contract: validate before the first write, roll the whole call back on a Figma refusal.

### Cut, copy, paste

No separate clipboard API — the verbs compose:

| You want | Use |
| --- | --- |
| cut & paste | `flcm.move(target, parent)` |
| paste a faithful copy | `flcm.clone(target, parent?)` — any subtree, instances included |
| paste with modifications | `flcm.append(parent, flcm.fromRead(spec))`, or `clone` then `edit` |
| delete | `flcm.remove(target)` |

A `get` result is not authoring input on its own: a bare read spec passed to `append` is rejected rather than quietly treated as a move, because the spec carries a live `id` exactly as a handle does — only you can say copy or move. `flcm.fromRead(spec)` says copy: it re-authors the subtree through the constructors, so you can edit the spec first (`{ ...spec, width: 320 }`), and the copy comes back key-less. A single node's spec also spreads straight into its constructor or an edit — `flcm.rect({ ...spec, width: 320 })` — since the constructors read the read shape's spellings; `fromRead` is for a subtree, whose `children` are specs rather than built nodes.

`fromRead` rebuilds; `clone` duplicates. Rebuilding reaches only what flcm can author, so an INSTANCE, a stacked paint, a grid container or a flattened `IMAGE-SVG` fails loud naming the field — `clone` is the answer for those.

## Seeing what you built (get_screenshot)

You cannot judge what you built from the code you wrote — hairlines, grain, glass, 1px strokes and missing glyphs all *look* fine in source. **Build → screenshot → look → fix.**

`get_screenshot` is a separate **MCP tool**, not an `flcm` verb (there is no `flcm.screenshot`). Each `figma_execute_code` call runs in its own scope, so what crosses between calls is a **string you copy** out of the render result.

```js
// call 1 — figma_execute_code
const out = await flcm.render(card);
return { id: out.root.id, bar: out.keyed.transportBar.id };
```

```
// call 2 — get_screenshot
{ "nodeId": "12:345" }             // the id you just returned
{ "key": "transportBar" }          // or a key you authored — resolved on the current page
{ "nodeId": "12:345", "scale": 3 } // 3× resolution, to inspect fine detail
```

- **`nodeId`** — any handle's `.id`, or an id from a read verb.
- **`key`** — a key you authored. Matching no node, or more than one, fails loud; a failed lookup never falls back to a page-wide capture.
- **Omit both** to capture the whole current page.
- **`scale`** (>0, ≤4; default 1) multiplies export resolution. Detail below ~24px — a 1px stroke, a hairline, grain, small type — isn't reliably judgeable at 1×; shoot it at 2–4×.

An unknown param name is named back to you, not ignored, so a typo costs one retry rather than a wrong conclusion.

### The raw `figma.*` escape hatch

The full Figma plugin API is in scope alongside `flcm`. **Author with `flcm`** — it's the surface that fails loud instead of rendering wrong pixels. **Drop to `figma.*`** for what the DSL doesn't cover: viewport, selection, and other *document* rather than *design* operations.

```js
const out = await flcm.render(screen);                                  // author with flcm
const node = await figma.getNodeByIdAsync(out.root.id);                 // drop out for document ops
figma.viewport.scrollAndZoomIntoView([node]);
return out.root.id;
```

**Pages** are covered — every verb acts on the current page, and `flcm.page` is how you see and change which one that is:

```js
await flcm.page.current();          // { fileName, page: { id, name }, pages: [ … ] } — where am I?
await flcm.page.new("pricing");     // make it and switch to it; a name already in the file fails loud
await flcm.page.use("pricing");     // switch to one that exists (name or id); never creates
```

Switch **before** you render — a render lands on whatever page is current when it runs. Don't reach for `figma.currentPage = page`: under `documentAccess: "dynamic-page"` that property is read-only and assigning it throws, which is the trap `flcm.page` removes.

Raw `figma.*` gives up every guarantee this DSL makes (fills are 0–1 assigned as a new array, fonts load before `characters`, a node is invisible until appended) — use it for plumbing, and come back to `flcm` to author.

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

Accepting CSS is a fidelity promise, so the boundaries are strict. Each of these throws a specific error naming the offending value — never a guess, never a silent no-op:

| Situation | Why, and the fix |
| --- | --- |
| A color / gradient / effect outside the [CSS subset](#the-css-subset) | Parse error naming the value. |
| A read-artifact image fill (`{ type: "IMAGE", imageRef, … }`) on `fill`/`stroke`/`color` | A ref to bytes we don't have — author with `flcm.image(url)`. |
| An `flcm.image` source that is unfetchable, blocked (private/loopback), outside the server's asset root, oversize, or not an image | Rejected server-side with the reason, never a blank fill. |
| An `flcm.text` value that is neither a string nor a runs array, or text carrying read style-ref tokens (`{ts1}…{/ts1}`) | Those are read artifacts. Author styled text as markdown or runs. `**` in a plain string is markdown — backslash-escape for a literal. |
| `![alt](url)` in a text string, or an unrealizable `fontStyle`/`textDecoration` (`"oblique"`, `"overline"`) | Text can't embed an image (`flcm.image`); the enum names the supported set. |
| A duplicate `key` in one render | Keys are unique per render. |
| A node `type` outside FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR | Those are the only createable types. |
| A hand-built node POJO (including a spread-copy of a real one) | The constructors validate at the boundary; a hand-assembled shape could smuggle a combination they'd refuse. Nodes compile at construction and are sealed, so mutating one afterwards throws. |
| `fill`/`stroke` on `flcm.svg` | Colors are baked into the markup — edit it, or use `flcm.path` for a themeable vector. |
| Unparseable SVG markup, or bad path `d` data | Never a silent blank node. |
| Returning a live Figma node | Return the id string or a handle. |
| A bad `pin` or `absolute.anchor` value | Names the value and the allowed set. |
| A percent `width`/`height` on an in-flow child of a parent that hugs that axis, or a percent/`"fill"` on the root | A genuine cycle (and the page is unbounded). Give the parent a fixed or `"fill"` size, or lift the child out with `absolute`. |
| An unknown `mixBlendMode` | Names the value and the supported set. |
| `layout.justifyContent`/`alignItems` Figma can't realize — `"space-around"`, `"space-evenly"` | Use `"space-between"` or `gap`/`padding`. Never faked with spacer nodes, which read as content. |
| `textStyle.lineClamp` on a width-hugging text | Truncation needs a width to wrap against. Set `width` to a number, `"fill"`, or `"N%"`. |
| A layout word the node can't realize — a fixed/`"hug"`/percent `height` on TEXT, `"hug"` with nothing to measure, or container words without `layout.mode` | The same rules govern create and edit alike, so a word that wouldn't land names the fix instead. |

Components, variables, and prototype interactions are deliberately **out of v1** — read concepts with no create path. They're rejected loudly so you never half-write something unrealizable.

### The one silent exception: unrenderable glyphs

Everything above fails loud. One case can't, because the plugin API exposes no glyph-coverage check: **a character the resolved font can't render draws as nothing** — no glyph, no tofu, no error. This bites emoji and private-use codepoints (SF Symbols) in fonts like Inter. If text renders blank, suspect a missing glyph first and switch to a font that covers it. Treat unusual codepoints with suspicion until you've seen a screenshot.

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

### Copying what's already on the canvas (get → fromRead)

The read↔write seam: `flcm.get` reads a live subtree as the canonical shape, you edit that shape like any object, and `flcm.fromRead` re-authors it through the constructors so a structural verb places a COPY. `flcm.clone` stays the faithful duplicate for subtrees a rebuild can't reproduce.

```js
// Copy a card that already exists on the canvas into a different container, widened on the way.
// `get` reads it as the canonical shape; `fromRead` re-authors that shape through the constructors,
// which is what makes it a COPY. A bare read spec carries the original's live id, so passing one
// straight to `append` is refused rather than read as "move the node I just looked at".
const spec = await flcm.get("card");
const wider = flcm.fromRead({ ...spec, width: 480, name: "Card (wide)" });
const placed = await flcm.append("sidebar", wider);

// fromRead REBUILDS, so it reaches only what flcm can author: an INSTANCE, a stacked paint, or a grid
// container fails loud naming the field. flcm.clone(target, parent) duplicates the live node whole —
// faithful, but not editable as a spec first.
return placed;
```
