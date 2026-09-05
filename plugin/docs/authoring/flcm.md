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
| `name` | string | The node's layer name in Figma. |
| `key` | string | An address for this node — only keyed nodes come back in render()'s `keyed` map. Author-unique per render. |
| `opacity` | number (0–1) | Whole-node opacity, 0–1. |
| `mixBlendMode` | "normal" \| "multiply" \| "screen" \| "overlay" \| "soft-light" \| … (CSS mix-blend-mode) | Blend mode — a CSS mix-blend-mode name (multiply, screen, overlay, soft-light, color-dodge, …). Composites this node against what's behind it. An unknown name fails loud. |
| `visible` | boolean | Layer visibility. A hidden node is invisible to the read verbs too — find/get cover the RENDERED document — so re-target it by id, not by a fresh find. |
| `locked` | boolean | Lock the layer against USER pointer edits in the Figma UI. The API (and flcm.edit) still writes to a locked node. |

### Size & position (frame, text, rect, ellipse)

(A `line` sizes differently — it takes a numeric `length`/`w` and ignores `h`/`"fill"`/`"hug"`.)

| Prop | Type | Notes |
| --- | --- | --- |
| `width` | number \| "fill" \| "hug" \| "N%" | Width. A number is fixed px; "N%" is a percent of the parent on this axis (free-form parent with a fixed size only). "fill" stretches to the parent (any parent frame — rejected on the root, whose parent is the page); "hug" shrinks to content, which only a row/column container or text can measure (rejected elsewhere). Not a "px" string. |
| `height` | number \| "fill" \| "hug" \| "N%" | Height. Same rules as width — except on TEXT, whose height follows its content and wrap: set `width` (the height follows) or use "fill" in-flow; a fixed, "hug", or percent height is rejected. |
| `absolute` | { x?, y?, anchor?: { x?, y? } } \| "none" — x/y number or "N%" | Pins the node at x/y relative to its parent — inside a frame that means lifting it out of the parent's auto-layout flow (overlays, badges, decorations); on a render root, whose parent is the page, it is where on the page the tree lands. Without it a root goes to the page origin, so successive renders stack. x/y are px numbers or "N%" (percent of the parent axis). `anchor` picks which point of the node lands on x/y — x: "left"\|"center"\|"right", y: "top"\|"center"\|"bottom" (default { left, top }); e.g. anchor:{ x:"center" } with x:"50%" centres the node on the midpoint instead of offsetting it by its own width. In flcm.edit, "none" returns the node to its parent's flow. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how this node responds when its parent resizes. Overrides the auto choice (w:"fill"→stretch, "N%"→scale, percent absolute position→center, else pinned to the near edge). x: "left"\|"center"\|"right"\|"stretch"\|"scale"; y: "top"\|"center"\|"bottom"\|"stretch"\|"scale". Honored for a child of a free-form parent and for any `absolute` child; inert on an in-flow auto-layout child (which reflows via fill/hug instead) — stored, and governs if the node later leaves the flow. In flcm.edit, "none" on an axis (or the whole prop) restores the default near-edge pin. |

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

- **An in-flow `%`-*size* child of an auto-layout parent that *hugs* that axis.** The parent hugs to fit its children while the child sizes to a fraction of the parent — a genuine cycle. Give the parent a fixed or `"fill"` size on that axis, use `"fill"`/`"hug"` on the child, or lift the child out with `absolute` (an out-of-flow child doesn't feed the hug, so it resolves fine). A percent — or `"fill"` — on the **root** node also fails loud: its parent is the page, which has no bounded size.

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
| `fill` | color / gradient | Background paint — a color/gradient string, or flcm.gradient(...). "none" removes the paint. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only (ellipses ignore it). |
| `effects` | effects value | Shadows / blur — flcm.effects({...}), or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |
| `layout` | { mode?, gap?, padding?, justifyContent?, alignItems? } | Auto-layout container config (mode/gap/padding/justifyContent/alignItems). Omitted or mode:"none" = free-form (children position absolutely). |
| `clip` | boolean | Clip children to the frame's bounds (clipsContent). Default false — like CSS, overflow is visible unless you set clip:true. |

#### Auto-layout config (the `layout` object)

| Prop | Type | Notes |
| --- | --- | --- |
| `mode` | "row" \| "column" \| "none" | Auto-layout direction. Default "none" (free-form; gap/padding/justifyContent/alignItems then reject loud — name mode: "row"\|"column" to use them). flcm cannot author grid — a "grid" attempt fails loud. |
| `gap` | number \| "Npx" | Space between children. |
| `padding` | number \| "12px 16px" \| { x?, y? } \| { top?, right?, bottom?, left? } | Padding. A number, or { x, y } shorthand (x→left+right, y→top+bottom), or per-edge. Also takes the read shape's CSS box shorthand string ("12px", "12px 16px") so a `get` result's layout re-authors as-is. |
| `justifyContent` | "flex-start" \| "flex-end" \| "center" \| "space-between" | Distribution along the main axis (CSS justify-content). Realizable subset: "flex-start" (default) \| "flex-end" \| "center" \| "space-between". Figma auto-layout has no space-around/space-evenly — those fail loud. |
| `alignItems` | "flex-start" \| "flex-end" \| "center" \| "stretch" | Alignment on the cross axis (CSS align-items). "stretch" stretches every auto-sized child across the cross axis; a child with a fixed cross-axis size keeps it. (You can also stretch a single child by setting its width/height to "fill".) |

### flcm.text — text props

| Prop | Type | Notes |
| --- | --- | --- |
| `textStyle` | { fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, boldWeight?, lineClamp? } | Text style base (font identity, metrics, casing, paragraph spacing, alignment, lineClamp). Runs layer over it. |
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
| `textAlignVertical` | "top" \| "center" \| "bottom" | Vertical alignment inside the text box. Default "top". Whole-node only — a styled run cannot set it. |
| `textTransform` | "uppercase" \| "lowercase" \| "capitalize" \| "none" | CSS text-transform — re-cases the rendered glyphs without changing the characters. "none" restores the original casing (and clears a fontVariant small-caps, which Figma stores in the same slot). |
| `fontVariant` | "small-caps" \| "all-small-caps" | CSS font-variant-caps. Shares Figma's single `textCase` slot with `textTransform`, so naming both in one style fails loud — pick one. |
| `paragraphSpacing` | number \| "Npx" | Space between paragraphs (after each newline). |
| `paragraphIndent` | number \| "Npx" | First-line indent of each paragraph. |
| `listSpacing` | number \| "Npx" | Space between list items. |
| `hyperlink` | string (url) \| { type: "URL", url } | A URL link over the whole text node. Takes a url string, or the read form { type: "URL", url } so a `get` result round-trips. A design's NODE links (a link to another node) are read-only and fail loud. |
| `boldWeight` | number (100–900) \| name | The weight `**bold**` resolves to in THIS node. Default "bold" (700). A design that emphasizes with Semi Bold reads back `boldWeight: 600` — pass it through and the copy emphasizes the same way instead of jumping to 700. Same spellings as fontWeight. |
| `lineClamp` | number (≥1) \| "none" | Clamp the text to at most N lines, truncating with an ellipsis (…). Needs a bounded width — a fixed/`"fill"`/`"N%"` `width` — so the text wraps; on a width-hugging text there is nothing to truncate and it fails loud. N must be a whole number ≥ 1. `"none"` removes an existing clamp (under edit; at create it is the explicit default). |

### flcm.text — rich text (runs)

`flcm.text` takes **either** a plain string **or** an array of **runs** — one text node, multiple styles. The frequent decorations are **markdown right in the string**; a runs array carries anything markdown can't say.

**Markdown in a plain string** — `**bold**`, `*italic*`, `~~strike~~`, `[text](url)` — parses to styled spans:

```js
flcm.text("Ship it **today** — see the [runbook](https://ex.co/run) first.");
```

To render one of those characters **literally**, backslash-escape it: `"save 20% \\*today\\*"` renders `save 20% *today*`. Only `\ * _ ~ [ ] ( ) { }` are escapable; every other character is already literal, and a backslash before one of them (`"20\\%"`) renders the backslash too. This escape convention is shared with figma-mcp's read output, so text you read back and re-author round-trips exactly. Markdown **image** syntax `![alt](url)` fails loud — text can't embed an image; use `flcm.image(url)`.

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
| `textTransform` | "uppercase" \| "lowercase" \| "capitalize" \| "none" | CSS text-transform — re-cases the rendered glyphs without changing the characters. "none" restores the original casing (and clears a fontVariant small-caps, which Figma stores in the same slot). |
| `fontVariant` | "small-caps" \| "all-small-caps" | CSS font-variant-caps. Shares Figma's single `textCase` slot with `textTransform`, so naming both in one style fails loud — pick one. |
| `paragraphSpacing` | number \| "Npx" | Space between paragraphs (after each newline). |
| `paragraphIndent` | number \| "Npx" | First-line indent of each paragraph. |
| `listSpacing` | number \| "Npx" | Space between list items. |
| `color` | color / gradient | Per-span text color. |
| `hyperlink` | string (url) \| { type: "URL", url } | A URL link over THIS span. Takes a url string, or the read form { type: "URL", url } so a `get` result round-trips. The inline `[text](url)` markdown spelling is usually simpler. A design's NODE links are read-only and fail loud. |

### flcm.rect / flcm.ellipse — shape props

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | color / gradient | Background paint — a color/gradient string, or flcm.gradient(...). "none" removes the paint. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only (ellipses ignore it). |
| `effects` | effects value | Shadows / blur — flcm.effects({...}), or a CSS-string bag. "none" removes all effects. |
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
| `absolute` | { x?, y?, anchor?: { x?, y? } } \| "none" — x/y number or "N%" | Pins the node at x/y relative to its parent — inside a frame that means lifting it out of the parent's auto-layout flow (overlays, badges, decorations); on a render root, whose parent is the page, it is where on the page the tree lands. Without it a root goes to the page origin, so successive renders stack. x/y are px numbers or "N%" (percent of the parent axis). `anchor` picks which point of the node lands on x/y — x: "left"\|"center"\|"right", y: "top"\|"center"\|"bottom" (default { left, top }); e.g. anchor:{ x:"center" } with x:"50%" centres the node on the midpoint instead of offsetting it by its own width. In flcm.edit, "none" returns the node to its parent's flow. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how this node responds when its parent resizes. Overrides the auto choice (w:"fill"→stretch, "N%"→scale, percent absolute position→center, else pinned to the near edge). x: "left"\|"center"\|"right"\|"stretch"\|"scale"; y: "top"\|"center"\|"bottom"\|"stretch"\|"scale". Honored for a child of a free-form parent and for any `absolute` child; inert on an in-flow auto-layout child (which reflows via fill/hug instead) — stored, and governs if the node later leaves the flow. In flcm.edit, "none" on an axis (or the whole prop) restores the default near-edge pin. |

### flcm.path — vector props

(`flcm.svg` takes only the shared and size/position props above — colors are baked into the markup.)

| Prop | Type | Notes |
| --- | --- | --- |
| `d` | string | SVG path data — the `d` attribute string, e.g. "M12 2 L22 20 L2 20 Z". Any standard command works (H V S T A and relative/lowercase are auto-normalized); only genuinely malformed data fails. Required. |
| `fill` | color / gradient | Background paint — a color/gradient string, or flcm.gradient(...). "none" removes the paint. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `effects` | effects value | Shadows / blur — flcm.effects({...}), or a CSS-string bag. "none" removes all effects. |
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
- the result of `flcm.image(src)` — a raster image fill from a url or local file path (see **Images**).

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

`flcm.image(src, opts?)` is a **paint value**, like `flcm.gradient` — not a node type. An image in Figma is a fill, so **any shape carries one**: a `rect` for a photo, an `ellipse` for a circular avatar, a `frame` for a hero. The source is an **https url** or a **local file path** — like CSS `url()`, both work in the same place.

```js
// a circular avatar: an ellipse filled with an image
flcm.ellipse({ width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") });

// a project asset by relative path — resolved against the server's asset root
flcm.rect({ width: 120, height: 40, fill: flcm.image("public/logo.png", { scaleMode: "FIT" }) });

// a feed photo, explicit scaleMode; mark a stand-in as a placeholder
flcm.rect({ width: 390, height: 260, fill: flcm.image("https://example.com/photo.jpg", { scaleMode: "FILL", placeholder: true }) });
```

- **The server loads the bytes — your code never touches the network or the filesystem.** You pass a source; the trusted server fetches (or reads), validates, and downscales it, then the image renders. Any *public* http(s) url works.
- **Local paths are confined to the server's asset root** (`--asset-root`, defaulting to the directory the server was started in). A path that resolves outside it is refused, naming the root — use it for assets already in the project (`public/logo.png`, `assets/icons/star.png`).
- An **unfetchable, blocked (private/loopback range), outside-the-root, oversize, or non-image source fails loud** — never a silent blank fill.

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

`render` is **async** — always `await` it. It loads the fonts your text needs, walks the tree creating live nodes, stamps each `key`, and returns:

```js
{
  root:  Handle,               // the top node of the tree
  keyed: { [key]: Handle }     // every node you gave a `key`
}
```

A **Handle** is a small plain object safe to return or log: `{ id, type, name, width, height, key?, text?, intent?, position?, left?, top? }` (`text` on text nodes, `key` when the node had one).

`width`/`height` are **always numbers** — the real px measured after the whole tree is laid out, so `bar.width + 8` always works. They are the node's **own** size, unaffected by any `rotate` you applied.

```js
out.keyed.bar.width;      // 320       — what it came out at
out.keyed.bar.intent;     // { width: "fill" }
out.keyed.chip.intent;    // undefined — a plainly fixed node
```

**`intent` tells you whether that number is yours to keep.** It appears only on an axis the *layout* owns — one you sized `"fill"` or `"hug"` — because such an axis re-measures whenever its parent or content changes. Reading `320` off a `"fill"` bar and hardcoding `w: 320` is how a responsive design silently becomes a fixed one. On a plainly fixed axis there is no `intent`: the measurement *is* what you asked for.

`left`/`top` are the offset inside the parent, and appear **only when the parent doesn't place the node** (a child of a plain frame, or one you positioned with `absolute`); under `row`/`column` the parent decides the position, so there is nothing to report. An `absolute` child of a `row`/`column` parent also carries `position: "absolute"`.

The read verbs (`get`, `find`) name geometry the same way, so a node you just rendered and a node you looked up read alike. They differ in one place: having only just measured it, `render` can hand you the number *and* the rule, while `find` has one field for both — it reports `width: "fill"` and withholds the px, so nothing tempts you to pin a size the design didn't fix.

**Keys are opt-in addressing.** Only keyed nodes appear in `out.keyed`; unkeyed nodes stay anonymous. Keys must be **unique within a single render** (a duplicate is a loud error) and are global to the render — namespace by hand (`"email:input"`). The key is stored on the node (`pluginData("flcm/key")`).

```js
const out = await flcm.render(screen);
out.root.id;                  // the top frame's id
out.keyed.card.type;          // "FRAME"
out.keyed["email:input"].id;  // a nested keyed node
```

**Return ids or handles, never live Figma nodes.** A live node can't cross the bridge (it collapses to a bare `{ id }`), so returning one is a loud error telling you to return the id instead. The handles from `render` are safe to return as-is.

## edit() / editMany() — changing existing nodes

`await flcm.edit(target, changes)` applies a partial delta to one existing node and returns its updated handle. The target is anything the read verbs accept: an flcm/key, a node id, `flcm.id(id)`, or a handle from `render`/`find`. The delta uses the **same words as create** — there is no separate edit dialect — and only the fields you pass change; everything else on the node is untouched.

### Editable fields

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | string | The node's layer name in Figma. |
| `opacity` | number (0–1) | Whole-node opacity, 0–1. |
| `mixBlendMode` | "normal" \| "multiply" \| "screen" \| "overlay" \| "soft-light" \| … (CSS mix-blend-mode) | Blend mode — a CSS mix-blend-mode name (multiply, screen, overlay, soft-light, color-dodge, …). Composites this node against what's behind it. An unknown name fails loud. |
| `visible` | boolean | Layer visibility. A hidden node is invisible to the read verbs too — find/get cover the RENDERED document — so re-target it by id, not by a fresh find. |
| `locked` | boolean | Lock the layer against USER pointer edits in the Figma UI. The API (and flcm.edit) still writes to a locked node. |
| `fill` | color / gradient | Background paint — a color/gradient string, or flcm.gradient(...). "none" removes the paint. |
| `stroke` | color / gradient | Border paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only (ellipses ignore it). |
| `effects` | effects value | Shadows / blur — flcm.effects({...}), or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |
| `clip` | boolean | Clip children to the frame's bounds (clipsContent). Default false — like CSS, overflow is visible unless you set clip:true. |
| `width` | number \| "fill" \| "hug" \| "N%" | Width. A number is fixed px; "N%" is a percent of the parent on this axis (free-form parent with a fixed size only). "fill" stretches to the parent (any parent frame — rejected on the root, whose parent is the page); "hug" shrinks to content, which only a row/column container or text can measure (rejected elsewhere). Not a "px" string. |
| `height` | number \| "fill" \| "hug" \| "N%" | Height. Same rules as width — except on TEXT, whose height follows its content and wrap: set `width` (the height follows) or use "fill" in-flow; a fixed, "hug", or percent height is rejected. |
| `absolute` | { x?, y?, anchor?: { x?, y? } } \| "none" — x/y number or "N%" | Pins the node at x/y relative to its parent — inside a frame that means lifting it out of the parent's auto-layout flow (overlays, badges, decorations); on a render root, whose parent is the page, it is where on the page the tree lands. Without it a root goes to the page origin, so successive renders stack. x/y are px numbers or "N%" (percent of the parent axis). `anchor` picks which point of the node lands on x/y — x: "left"\|"center"\|"right", y: "top"\|"center"\|"bottom" (default { left, top }); e.g. anchor:{ x:"center" } with x:"50%" centres the node on the midpoint instead of offsetting it by its own width. In flcm.edit, "none" returns the node to its parent's flow. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how this node responds when its parent resizes. Overrides the auto choice (w:"fill"→stretch, "N%"→scale, percent absolute position→center, else pinned to the near edge). x: "left"\|"center"\|"right"\|"stretch"\|"scale"; y: "top"\|"center"\|"bottom"\|"stretch"\|"scale". Honored for a child of a free-form parent and for any `absolute` child; inert on an in-flow auto-layout child (which reflows via fill/hug instead) — stored, and governs if the node later leaves the flow. In flcm.edit, "none" on an axis (or the whole prop) restores the default near-edge pin. |
| `layout` | { mode?, gap?, padding?, justifyContent?, alignItems? } | Auto-layout container config (mode/gap/padding/justifyContent/alignItems). Omitted or mode:"none" = free-form (children position absolutely). |
| `length` | number | The line's length in px. |
| `w` | number | The line's length in px — alias for `length` (`length` wins if both are set). |
| `content` | string \| run[] | Replacement text: a plain string (markdown inline styling works: **bold**, *italic*, ~~strike~~, [link](url)) or an array of styled runs — exactly what flcm.text takes as its first argument. Replaces the node's whole content. |
| `textStyle` | { fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, boldWeight?, lineClamp? } | Text style base (font identity, metrics, casing, paragraph spacing, alignment, lineClamp). Runs layer over it. |
| `color` | color / gradient | Text color (a solid color, normally) — a node-level sugar prop compiling to the text node's fill. |

### Words by node type

- **FRAME** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `fill`, `stroke`, `strokeWidth`, `borderRadius`, `effects`, `rotation`, `layout`, `clip`
- **TEXT** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `textStyle`, `color`, `content`
- **RECTANGLE / ELLIPSE** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `fill`, `stroke`, `strokeWidth`, `borderRadius`, `effects`, `rotation`
- **LINE** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `stroke`, `color`, `strokeWidth`, `length`, `w`, `rotation`, `absolute`, `pin`
- **VECTOR (path- or svg-born)** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `width`, `height`, `absolute`, `pin`, `fill`, `stroke`, `strokeWidth`, `effects`, `rotation`

On a node type flcm can't create (GROUP, INSTANCE, COMPONENT, …) only the shared words apply: `name`, `opacity`, `mixBlendMode`, `visible`, `locked`.

### Removal — the `"none"` word

`"none"` (CSS's own absence spelling) is the one removal word, surface-wide: `fill: "none"` / `stroke: "none"` clear the paint, `effects: "none"` clears all effects, `absolute: "none"` returns the node to its parent's flow, `pin: "none"` (or `pin: { x: "none" }` per axis) restores the default near-edge pin, `layout: { mode: "none" }` switches auto-layout off (children convert per Figma's own semantics — look, then nudge). The same spellings are legal at create, where they mean the explicit default (a transparent fill, free-form layout). Sizes are never *removed*, only replaced within the number/`"fill"`/`"hug"` trio: `width: "hug"` is how a fixed or filled width comes off.

### Rules

- **A node type takes exactly the words create accepts for it.** `fill` on a LINE, `clip` on a TEXT, `borderRadius` on a VECTOR — each rejects loud naming the prop, the node type, and that type's editable words, the same way the constructor would.
- **Only the fields you pass change — per axis, too.** `pin: { x: "center" }` keeps the y pin; `absolute: { x: 10 }` keeps the live y; `width: "hug"` leaves the height's sizing alone.
- **Un-filling really un-fills.** `width: 80` or `"hug"` on a child that was `"fill"` clears the grow/stretch marks fill installed — the new size governs, not the old fill.
- **Container edits ripple by stated rules.** `layout.alignItems: "stretch"` walks the live children setting their stretch marks; writing any other alignItems clears every stretch mark (Figma doesn't store which child stretched because of the container — a child that should keep filling gets its own `height: "fill"` edit after; an un-stretched child keeps its current size rather than re-hugging). Changing the layout direction — row↔column, or `"none"` to either — clears both flow marks (grow and stretch) on every in-flow child: the axes they meant just moved.
- **Layout legality is the same rule set create enforces, applied against live facts.** Rejected loud, before any write: a percent on an in-flow child of an auto-layout parent that hugs that axis (a cycle), `"fill"`/`"N%"` on a node whose parent is the page (no bounded size), `"hug"` on a node with nothing to measure (not — and after this delta still not — a row/column container or text), a fixed/hug/percent `height` on TEXT (its height follows content — edit `width`, or use `height: "fill"`), and container words (`gap`/`padding`/`justifyContent`/`alignItems`) on a frame that isn't — or after this delta won't be — a row/column container. Percents resolve immediately against the live parent's size.
- **Text words read the LIVE node.** `content` replaces the whole text (a string or run array, markdown included; re-running the same edit converges). The replacement collapses the text to its LEADING run's style — prior bold spans or per-range colors do NOT survive — so style the new text explicitly, with styled runs or `textStyle` in the same edit. `textStyle` naming part of the font triple keeps the live rest (`fontWeight: "bold"` on an italic Roboto stays bold italic Roboto). A text that already MIXES fonts has no single base: a partial font change or a styled `content` run without its own `fontFamily` rejects loud — anchor `textStyle.fontFamily` in the same edit (a whole-node reset), or give each run its family. `lineClamp` needs a bounded width to truncate against (set `width` in the same edit if the text hugs), and `lineClamp: "none"` removes the clamp.
- **Edits inside a component INSTANCE apply as overrides.** A property Figma forbids overriding rejects with an error naming the instance — edit the main component instead (flcm never auto-detaches an instance).
- **`key` is immutable.** Keys are set at creation and are how later calls address the node — re-keying could mint a duplicate address. To rename what you see in the layers panel, set `name`.
- **No bare `x`/`y`** — position is spelled `absolute: { x, y }`, resize behavior is `pin`.
- **An empty delta is rejected**, not silently committed — an empty edit would still mint an undo step.
- **Each edit is one undo step.** The whole delta validates before the first write; if Figma refuses a write mid-apply, the edit rolls back to how the node was and the error carries the target's identity, Figma's reason, and how many earlier mutating calls in the run still stand.
- Delta values are **absolute** (a fill, an opacity), never relative (`+10`) — re-running the same edit converges instead of compounding.

### Many at once — `flcm.editMany`

`await flcm.editMany([{ target, changes }, …], { within? })` applies a whole set of deltas as **one** call, and returns a handle per entry in the order you wrote them. Each `changes` is exactly an `flcm.edit` delta — same words, same rules as everything above.

Reach for it whenever you're nudging more than one node, because a loop over `flcm.edit` is **not** the same thing:

- **The set is atomic, not just each call.** Every target resolves and every delta validates before the first write. A loop would already have mutated entries 1–3 by the time entry 4's typo surfaced; here nothing moves and the canvas is exactly as you found it.
- **One rejection names every bad entry**, indexed — `[2] …`, `[5] …` — so you fix the whole batch in one pass instead of one round trip per mistake.
- **The whole batch is one undo step.** Your user steps back over the change they asked for, not over nine of them.
- **Order doesn't matter.** Entries settle ancestors-first, so turning a parent into a row *and* setting its child to `width: "fill"` works whichever way round you write them.
- **Two entries for the same node reject** rather than silently last-wins — put both fields in one entry.

Only props: tree shape stays with `append`/`move`/`remove`/`clone`, one call each.

## Tree shape — placing, moving, removing

Tree shape is its own set of verbs, and **position is the verb** — there is no index argument and no options bag. `flcm.append(parent, thing)` and `flcm.prepend(parent, thing)` take the parent; `flcm.insertBefore(sibling, thing)` and `flcm.insertAfter(sibling, thing)` take a **sibling** and work out the parent from it.

`thing` is either of two things, and they mean what they mean in the DOM:

- a **constructor spec** — `flcm.frame(...)`, `flcm.text(...)`, an inert tree — which is built inside the destination. Returns `{ root, keyed, to }`: the same `root`/`keyed` `render` gives you, plus the container it landed in.
- a **target naming a live node** (an flcm/key, a node id, `flcm.id(id)`, or a handle) — which **moves** that node there, exactly as `appendChild` moves an attached DOM node. Returns `{ node, from, to }`.

Three more complete the set: `flcm.move(target, parent)` is the plain reparent (the node lands last inside `parent` — the same placement `append` does, with the subject named first), `flcm.remove(target)` deletes a node and its subtree, and `flcm.clone(target, parent?)` duplicates one.

**`clone` is the copy path for subtrees a rebuild can't reproduce** — anything containing a component INSTANCE, which is most real content. It duplicates the LIVE node rather than re-authoring it, so nothing is lost in translation, and the copy comes back **key-less**: a raw `node.clone()` copies the original's `flcm/key` too, quietly giving two live nodes one address. Key the copy yourself if you want to address it later. The copy is faithful down to its coordinates, so in a **free-form** parent it lands directly on top of the original — `flcm.edit` its `absolute` position to separate them. (In a row/column parent it simply lands last.)

Every return carries the subject plus each container whose geometry the operation could have changed — a hugging parent reflows whenever its children change, and those are the nodes you would otherwise have to re-read. They are flat handles with fresh geometry, never nested trees; `get` is still how you dive. Containers are always named `to` (where things ended up) and `from` (one something left), so `out.to` reads the same whichever kind of `thing` you placed. Either is absent when that container is the page (a page has no box to measure), and `from` is absent when you reordered inside one parent.

### Rules

- **Sizing that depends on the parent works on insert.** The node is attached *before* it is sized, so `width: "fill"` on an appended spec fills the destination — the ordering hazard is handled for you, not something to work around.
- **Layout legality is re-asked against the DESTINATION.** The same rule set create and edit enforce, with the new parent's facts: `"fill"`/`"N%"` into a page parent, a TEXT `height: "fill"` landing out of a row/column flow, a percent child of a hugging auto-layout parent, or any parent-relative word under a GRID parent each reject loud, before anything moves. A layout that was legal where a node sat is not automatically legal where it lands.
- **A move re-aims the moved node's fill.** `"fill"` is stored as a mark on the parent's *primary* or *counter* axis, and those axes move with the node — so a moved node's fill is cleared and re-applied against the new parent (filling a row's width becomes filling a column's width, and a fill into a free-form parent covers its box). Fixed sizes are untouched.
- **A stretch container does not stretch what you insert.** Figma stores no container-level `alignItems: "stretch"` — a stretched child is indistinguishable from one that asked for counter-axis `"fill"` itself — so an inserted child doesn't inherit it. Re-assert it with `flcm.edit(parent, { layout: { alignItems: "stretch" } })`, which re-synthesizes the marks over every child including the new one.
- **An instance's CHILD LIST is closed.** Placing into an instance (or anything inside one), and moving or removing one of its children, both reject loud and name the instance: those children come from the main component, so edit that instead — flcm never auto-detaches. The instance **itself** is an ordinary node in its own parent: moving, removing and cloning it are all fine.
- **A node can't be placed inside itself or its own subtree**, and the refusal names both nodes rather than surfacing Figma's own cycle error.
- **Each call is one undo step**, with the same contract as `edit`: everything validates before the first write, and a Figma refusal mid-apply rolls the whole call back.

### Cut, copy, paste

There is no separate clipboard API — the verbs compose into one:

| You want | Use |
| --- | --- |
| cut & paste | `flcm.move(target, parent)` |
| paste a faithful copy | `flcm.clone(target, parent?)` — works on any subtree, instances included |
| paste with modifications | `flcm.append(parent, flcm.fromRead(spec))` — or `flcm.clone(...)` then `flcm.edit` the copy |
| delete | `flcm.remove(target)` |

A `get` result is not authoring input **on its own**: passing a bare read spec to `append` is rejected, not quietly treated as a move — the spec carries a live `id` exactly as a handle does, so only you can say whether you mean copy or move. `flcm.fromRead(spec)` is how you say copy: it re-authors the subtree through the constructors, so you can edit the spec first (`{ ...spec, width: 320 }`) and the copy comes back key-less. A single node's spec also spreads straight into its own constructor or an edit — `flcm.rect({ ...spec, width: 320 })`, `flcm.edit(target, { fills: spec.fills })` — since the constructors read the read shape's spellings; `fromRead` is for a subtree, whose `children` are read specs rather than built nodes.

`fromRead` rebuilds; `clone` duplicates. Rebuilding only reaches what flcm can author, so anything it can't — an INSTANCE, a stacked paint, a grid container, a flattened `IMAGE-SVG` — fails loud naming the field, and `clone` is the answer for those.

## Seeing what you built (get_screenshot)

You cannot judge what you built from the code you wrote — hairlines, grain, glass, 1px strokes, and unrenderable glyphs all *look* fine in source. **Build → screenshot → look → fix.**

`get_screenshot` is a separate **MCP tool**, a sibling of `figma_execute_code` — **not** an `flcm` verb. There is no `flcm.screenshot`. Each `figma_execute_code` call runs in its own sandbox scope, so a live handle can't be handed to another tool call; what crosses is a **string you copy** out of the render result.

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

- **`nodeId`** — any handle's `.id` from `render` (`out.root.id`, `out.keyed.<key>.id`), or an id from a read verb.
- **`key`** — a `key` you authored, resolved against `pluginData("flcm/key")` on the current page. A key matching **no** node, or **more than one** (duplicating a node copies its key), fails loud naming the problem — a failed lookup never quietly falls back to a page-wide capture.
- **Omit both** to capture the whole current page.
- **`scale`** (>0, ≤4; default 1) multiplies export resolution. Detail below ~24px — a 1px stroke, a hairline divider, grain, glass refraction, small type — is not reliably judgeable at 1×; screenshot it at 2–4×.

Pass a param name the tool doesn't know and it says so, naming the key and the valid ones. It does **not** silently ignore it, so a typo costs one retry rather than a wrong conclusion.

### The raw `figma.*` escape hatch

The full Figma plugin API global is in scope inside `figma_execute_code`, alongside `flcm`. **Author with `flcm`** — it's the surface that fails loud instead of rendering wrong pixels. **Drop to `figma.*`** for the things the DSL deliberately doesn't cover: page and viewport operations (`figma.currentPage`, `figma.viewport.scrollAndZoomIntoView([node])`), selection, node deletion, and anything else about the *document* rather than the *design*.

```js
const out = await flcm.render(screen);                                  // author with flcm
const node = await figma.getNodeByIdAsync(out.root.id);                 // drop out for document ops
figma.viewport.scrollAndZoomIntoView([node]);
return out.root.id;
```

Raw `figma.*` gives up every guarantee this DSL makes (fills are 0–1 and must be assigned as a new array, fonts must be loaded before `characters`, a node is invisible until appended) — so use it for *plumbing*, and come back to `flcm` to author.

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
| An `flcm.image` source that is unfetchable, blocked (private/loopback range), a local path outside the server's asset root, oversize, or not a real image | Rejected server-side, naming the reason (and, for a path, the root): never a silent blank fill. |
| A `flcm.text` value that is neither a plain string nor a runs array (a structured read object), or text carrying figma-mcp style-ref tokens (`{ts1}…{/ts1}`) | Rejected: those are read artifacts. Author styled text as **markdown** or a **runs array** (see Rich text). A plain-string `**` is now **markdown** (bold), not literal — backslash-escape (`\\*\\*`) for a literal. |
| Markdown **image** syntax `![alt](url)` inside a `flcm.text` string, or an unrealizable `fontStyle`/`textDecoration` value (e.g. `"oblique"`, `"overline"`) | Rejected: text can't embed an image (use `flcm.image(url)`); the enum value names the supported set. |
| A **duplicate `key`** within one render | Rejected: keys must be unique per render. |
| A node `type` other than FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR | Rejected: those are the only createable types. |
| A **hand-built node object** (a POJO not made by an flcm constructor, including a spread-copy of one) | Rejected: the constructors are the authoring surface — they validate every prop at the boundary, and a hand-assembled shape could smuggle combinations they'd refuse. Clone a node by re-calling its constructor. Nodes also compile **at construction**: they're sealed, so mutating a node (or the children array you passed) afterwards throws rather than silently changing nothing. |
| `fill`/`stroke` on `flcm.svg` | Rejected: colors are baked into the SVG markup, so they'd be a no-op. Edit the markup, or use `flcm.path` for a themeable vector. |
| Unparseable SVG markup (`flcm.svg`) or bad path `d` data (`flcm.path`) | Rejected: never a silent empty/blank node. |
| Returning a **live Figma node** from your code | Rejected: return the id string (or a handle) instead. |
| A bad `pin` value (not `{ x?, y? }`, or an axis outside its set) | Rejected: naming the offending value and the allowed names. |
| A percent `width`/`height` (`"N%"`) on an **in-flow** child of an **auto-layout** parent that **hugs** that axis (the child both sets and depends on the parent's size — a cycle), or a percent or `"fill"` on the **root** node (its parent is the page, which has no bounded size) | Rejected: this is the one percent case a runtime read can't break. Give the parent a fixed or `"fill"` size on that axis, use `"fill"`/`"hug"` on the child, or lift it out with `absolute` (an out-of-flow child doesn't feed the hug, so it resolves fine). Every other percent — against a fixed, `"fill"`, `"hug"`, or percent-sized parent — resolves against the parent's realized size. |
| A bad `absolute.anchor` value (an axis outside `left`/`center`/`right` or `top`/`center`/`bottom`) | Rejected: naming the offending value and the allowed names. |
| An unknown `mixBlendMode` value (not a CSS `mix-blend-mode` name) | Rejected: naming the offending value and the supported set. |
| An unrealizable `layout.justifyContent`/`layout.alignItems` value — notably `"space-around"`/`"space-evenly"` | Rejected: Figma auto-layout has no space-around/space-evenly. Use `"space-between"` or add `layout.gap`/`layout.padding`; never faked with spacer nodes (they'd read as content). |
| `textStyle.lineClamp` on a **width-hugging** text (no bounded `width`) | Rejected: truncation needs a width to wrap against — a hugging text grows on one line, so `textStyle.lineClamp` would do nothing. Set `width` to a number, `"fill"`, or `"N%"`. |
| A layout word the node **can't realize** — a fixed, `"hug"`, or percent `height` on TEXT (its height follows content and wrap; set `width` or use `height: "fill"`), `"hug"` on a node with nothing to measure (not a row/column container or text), or container words (`layout.gap`/`padding`/`justifyContent`/`alignItems`) without `layout.mode: "row"`/`"column"` | Rejected — the same rule set governs **create and edit alike**, so a word that would silently not land instead names the fix. |

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
