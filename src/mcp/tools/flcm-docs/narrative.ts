// Hand-written narrative fragments — the conceptual half of the docs that generation can't author:
// the mental model, the CSS subset, the fail-loud boundary, render/keys, the ADR-0003 promise. The
// drift-prone half (every verb/prop/type/example) is GENERATED from the schema (see reference.ts); this
// file holds only the prose that explains, frames, and warns.
//
// ADR-0003 (faithful CSS): the CSS surface is faithful — Figma's quirks are absorbed in code or fail
// loud, never surfaced here as "this behaves differently than you'd expect" footguns. So there is NO
// blur-×2 note (the code applies it) and NO alignItems:"stretch" no-op warning (the bridge now synthesizes
// container stretch per-child, so it just works). What stays documented is the fail-loud boundary: what
// we reject rather than approximate — plus the ONE honest silent exception (an unrenderable glyph).

export const MENTAL_MODEL = `You **describe** a tree of nodes with plain function calls, then **render** it once.

- **Constructors are inert.** \`flcm.frame(...)\`, \`flcm.text(...)\`, etc. build plain description objects and create *nothing* on the canvas. Only \`await flcm.render(tree)\` creates live nodes — so you can freely build, nest, and compose trees before rendering.
- **Leaf values are CSS-familiar.** Colors, gradients, shadows, and metrics are written the way you'd write them in CSS (\`"#0B1020"\`, \`"rgba(255,255,255,0.06)"\`, \`"linear-gradient(180deg, …)"\`, \`"24px"\`, \`"-0.02em"\`). You write this one familiar format; we translate it to Figma-native values for you. The catch: CSS can spell things Figma can't realize, so values **outside the documented subset fail loud** (a specific error) rather than rendering wrong pixels.

There is no autocomplete and no type-checking where your code runs (a QuickJS sandbox), so everything you can write is spelled out in this reference. If a verb, prop, or value isn't documented, it isn't supported.`;

export const CHILDREN = `- A frame's children are the **second positional argument**: an array (or a single child).
- Children may be **falsy** — \`null\`, \`false\`, \`undefined\` are skipped, so \`showError && flcm.text(...)\` composes cleanly.
- **Z-order is document order: declare back-to-front.** Earlier children sit behind later ones; there is no \`z\`/\`layer\` prop. An absolute-positioned decoration that should sit behind content is declared first.`;

export const RICH_TEXT = `\`flcm.text\` takes **either** a plain string **or** an array of **runs** — one text node, multiple styles. The frequent decorations are **markdown right in the string**; a runs array carries anything markdown can't say.

**Markdown in a plain string** — \`**bold**\`, \`*italic*\`, \`~~strike~~\`, \`[text](url)\` — parses to styled spans:

\`\`\`js
flcm.text("Ship it **today** — see the [runbook](https://ex.co/run) first.");
\`\`\`

To render one of those characters **literally**, backslash-escape it: \`"save 20% \\\\*today\\\\*"\` renders \`save 20% *today*\`. Only \`\\ * _ ~ [ ] ( ) { }\` are escapable; every other character is already literal, and a backslash before one of them (\`"20\\\\%"\`) renders the backslash too. This escape convention is shared with figma-mcp's read output, so text you read back and re-author round-trips exactly. Markdown **image** syntax \`![alt](url)\` fails loud — text can't embed an image; use \`flcm.image(url)\`.

**Runs array** — a run is a **bare string** (a plain segment) or a **\`[text, style]\` tuple** (a styled span). The tuple's \`style\` is a **delta** over the node-level \`textStyle\` base (the \`textStyle\` object in the second argument), so you set the base once and each styled span carries only what it changes; a run's text may itself contain markdown.

\`\`\`js
// a feed caption as ONE node: a colored @handle, plain body, a muted "more"
flcm.text(
  [ ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
    " summited at golden hour. ",
    ["more", { color: "#8E8E93" }] ],
  { textStyle: { fontSize: 14 } },   // base style; run deltas layer over it
);
\`\`\`

A run delta can override \`fontWeight\`, \`fontSize\`, \`fontFamily\`, \`fontStyle\` (\`"italic"\`/\`"normal"\`), \`textDecoration\` (\`"underline"\`/\`"line-through"\`/\`"none"\`), \`color\`, \`lineHeight\`, \`letterSpacing\`, and \`hyperlink\` — the canonical \`textStyle\` field names, plus \`color\` and \`hyperlink\` (base text color lives in the node's fill; base links are read-only). \`textAlign\`/\`lineClamp\` are whole-node, not per-run. A run's font resolves exactly like the node's: an unknown family falls back to Inter, a weight snaps to the nearest available style, and \`fontStyle: "italic"\` snaps to the family's italic variant. Each run's resolved font is preloaded and applied to its span, so a \`semibold\` run really renders semibold instead of silently inheriting the base weight. A fixed \`width\` still wraps the whole node into a flowing paragraph, so a styled paragraph is just runs + a width.`;

export const PERCENT_SIZING = `\`width\`, \`height\`, and \`absolute.x\`/\`absolute.y\` accept a **percent** string — \`"50%"\` — resolved against the parent's size on that axis, so you don't hand-compute pixels against a parent width you had to guess.

\`\`\`js
// a progress bar filled to 35% of its track's width
flcm.frame({ width: 300, height: 8, borderRadius: 4, fill: "#E5E7EB" }, [
  flcm.rect({ width: "35%", height: 8, borderRadius: 4, fill: "#6366F1" }),
]);

// a badge pinned to the horizontal centre of a card
flcm.rect({ width: 40, height: 40, absolute: { x: "50%", y: 12 } });
\`\`\`

**Percent resolves against the parent's *realized* size** — its actual rendered width/height on the canvas, not a size you had to declare up front. So a percent child of a \`"fill"\` track or a percent-sized parent resolves fine: the parent's real size is read after the layout settles. There is exactly **one** case that can't work, and it **fails loud** (never a wrong guess):

- **An in-flow \`%\`-*size* child of an auto-layout parent that *hugs* that axis.** The parent hugs to fit its children while the child sizes to a fraction of the parent — a genuine cycle. Give the parent a fixed or \`"fill"\` size on that axis, use \`"fill"\`/\`"hug"\` on the child, or lift the child out with \`absolute\` (an out-of-flow child doesn't feed the hug, so it resolves fine). A percent on the **root** node also fails loud — it has no parent.

Percent always resolves to a fixed pixel *now*. Whether it also *reflows* when the parent is later resized depends on where it sits (next section) — a percent child of an auto-layout parent is static-only, and that boundary is called out, not hidden.

**Responsive by default.** Percent (and \`"fill"\`) render to fixed pixels *now*, but a **positioned** child also gets a Figma **constraint** set automatically, so the design still reflows when the parent is later resized (in Figma, or by a downstream edit) — no frozen snapshot that only *looks* responsive. "Positioned" means a child of a **free-form** parent, or any **\`absolute\`** child (an absolute child is out of the flow, so it honors constraints even inside an auto-layout parent — that's how a badge sticks to a corner). The constraint is derived from how you sized/placed the child:

| You wrote | Auto constraint | On resize |
| --- | --- | --- |
| \`width:"fill"\` | stretch | grows/shrinks with the parent |
| \`width:"N%"\` | scale | scales proportionally |
| \`absolute:{ x:"N%" }\` (percent position) | center | holds its relative spot |
| a plain number (or numeric \`absolute.x\`) | pinned to the near edge | stays put top-left (Figma default) |

A \`width:"fill"\` child of a free-form parent now genuinely **stretches to the parent box** (it used to warn and do nothing). This is per-axis: \`width\` drives the horizontal constraint, \`height\` the vertical.

**Override with \`pin\`** when the auto choice is wrong — e.g. a badge that should hug the *right* edge instead of the left:

\`\`\`js
// a close button pinned to the top-right of a free-form card, so it stays there when the card widens
flcm.frame({ width: 320, height: 200 }, [
  flcm.rect({ width: 28, height: 28, absolute: { x: 284, y: 12 }, pin: { x: "right", y: "top" } }),
]);
\`\`\`

\`pin\` is \`{ x?, y? }\` — \`x\`: \`"left"\`/\`"center"\`/\`"right"\`/\`"stretch"\`/\`"scale"\`; \`y\`: \`"top"\`/\`"center"\`/\`"bottom"\`/\`"stretch"\`/\`"scale"\`. It's honored for a **free-form** parent's child and for any **\`absolute\`** child; an **in-flow** auto-layout child reflows through \`fill\`/\`hug\` (\`layoutGrow\`/stretch) instead, so \`pin\` is ignored there. A bad \`pin\` value fails loud.

**Anchor an \`absolute\` child by a point other than its top-left** with \`absolute.anchor\`. By default \`x\`/\`y\` place the node's **top-left corner**, so centring a knob on a mark means subtracting half its width by hand. \`anchor\` removes that math — it names which point of the node lands on \`x\`/\`y\`:

\`\`\`js
// a scrub knob centred on the 40% mark of a track — no half-width offset
flcm.frame({ width: 320, height: 8, borderRadius: 4, fill: "#E5E7EB" }, [
  flcm.rect({ width: "40%", height: 8, borderRadius: 4, fill: "#6366F1" }),
  flcm.ellipse({ width: 16, height: 16, fill: "#6366F1", absolute: { x: "40%", y: "50%", anchor: { x: "center", y: "center" } } }),
]);
\`\`\`

\`anchor\` is \`{ x?, y? }\` — \`x\`: \`"left"\`/\`"center"\`/\`"right"\`; \`y\`: \`"top"\`/\`"center"\`/\`"bottom"\` (default \`{ left, top }\`). It works with a numeric or percent \`x\`/\`y\`, and pairs naturally with percent position — \`x:"100%", anchor:{ x:"right" }\` pins a badge's right edge to the parent's right edge. A bad anchor value fails loud.`;

export const VECTOR_INTRO = `Render real vector art — icons, logos, glyphs — instead of composing them from rects/ellipses or leaning on emoji/unicode glyphs (which render inconsistently and read as *content*, not iconography). There is **no built-in icon catalog**: bring your own SVG markup or path data.

Two verbs, two deliberately different contracts — they are **not** interchangeable:

- **\`flcm.svg(markup, props?)\`** — paste a whole \`<svg>…</svg>\` document (a logo, a multi-color icon) and get it as-is. **Colors are baked into the markup**, so \`fill\`/\`stroke\` do **not** apply (passing them fails loud); it takes size/position only. Use this as the opaque escape hatch.
- **\`flcm.path(props)\`** — one vector node from a single \`d\` path string. It takes our appearance props (\`fill\`, \`stroke\`, \`strokeWidth\`, \`effects\`) directly, so it **themes like any other primitive**. \`d\` is required.

\`\`\`js
// a themeable play triangle — fills with the theme color like a rect
flcm.path({ d: "M8 5 L19 12 L8 19 Z", fill: "#6366F1", width: 24, height: 24 });

// an opaque brand logo — colors live in the markup
flcm.svg('<svg viewBox="0 0 24 24"><path d="M12 2 L22 20 L2 20 Z" fill="#0B1020"/></svg>', { width: 32, height: 32 });
\`\`\`

A \`path\` with no \`fill\` is transparent (like a rect with no fill) — give it a \`fill\` or a \`stroke\`. Unparseable SVG markup or bad path \`d\` data fails loud rather than leaving a blank node.

**Sizing differs.** A \`path\` sizes to its \`d\` data's own bounding box (the coordinates in the string); \`width\`/\`height\` then scale that box, so a \`path\` needs no \`width\`/\`height\` to appear at its natural size. An \`svg\` instead scales its \`viewBox\` into the \`width\`/\`height\` you give it.

**For uniform translucency, use the node-level \`opacity\` prop** — it flattens the whole vector, then fades it as one layer (clean). \`fill-opacity\`/\`stroke-opacity\` baked into \`svg\` markup composite per-subpath, so they **seam** where subpaths overlap; reach for them only when you genuinely want per-subpath alpha.`;

export const PAINT_INTRO = `A paint value (for \`fill\`, \`stroke\`, \`color\`) is one of:

- a **solid color string** — \`"#FF0000"\`, \`"#FF0000AA"\`, \`"rgba(255,0,0,0.5)"\`;
- a **gradient string** — \`"linear-gradient(…)"\` / \`"radial-gradient(…)"\`;
- the result of \`flcm.gradient(...)\` (below); or
- the result of \`flcm.image(url)\` — a raster image fill (see **Images**).

\`\`\`js
flcm.frame({ fill: "#0B1020" });
flcm.frame({ fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" });
flcm.frame({ fill: flcm.gradient({ stops: ["#0B1020", "#131A2E"], angle: 180 }) });
\`\`\`

**\`flcm.gradient(...)\`** builds a gradient fill value without writing the CSS string. Two call forms:

\`\`\`js
flcm.gradient({ type, stops, angle, at });          // object form
flcm.gradient("linear" | "radial", stops, angle);   // positional form
\`\`\``;

export const IMAGE_INTRO = `Place a **real raster image** — feed media, an avatar, a thumbnail — instead of faking it with a gradient or solid fill (which carries no signal it was ever meant to be an image).

\`flcm.image(url, opts?)\` is a **paint value**, like \`flcm.gradient\` — not a node type. An image in Figma is a fill, so **any shape carries one**: a \`rect\` for a photo, an \`ellipse\` for a circular avatar, a \`frame\` for a hero.

\`\`\`js
// a circular avatar: an ellipse filled with an image
flcm.ellipse({ width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") });

// a feed photo, explicit scaleMode; mark a stand-in as a placeholder
flcm.rect({ width: 390, height: 260, fill: flcm.image("https://example.com/photo.jpg", { scaleMode: "FILL", placeholder: true }) });
\`\`\`

- **The server fetches the bytes — your code never touches the network.** You pass a url; the trusted server fetches, validates, and downscales it, then the image renders. Any *public* http(s) url works.
- An **unfetchable, blocked (private/loopback range), oversize, or non-image url fails loud** — never a silent blank fill.

\`opts\` (\`scaleMode\`, \`placeholder\`) are documented in the field table below.`;

export const EFFECTS_INTRO = `An \`effects\` value is either the result of \`flcm.effects({...})\` (recommended) or a CSS-string bag: \`{ boxShadow?, textShadow?, filter?, backdropFilter? }\`.

\`\`\`js
flcm.frame({ effects: flcm.effects({ shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" }, backgroundBlur: 16 }) });
flcm.frame({ effects: { boxShadow: "0px 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(16px)" } });
\`\`\`

Blur values are written in **CSS px** — you always write the CSS number and we map it to Figma's scale for you.

**\`glass\` needs a high-frequency backdrop to read as glass.** \`refraction\` and \`dispersion\` bend what is *behind* the pane, so over a flat fill or a smooth gradient there is nothing to bend and the result looks like a plain frosted tint — that's the physics of the scene, not a broken effect. Put busy content behind it (an image, dense text, an icon grid, a sharp-edged shape) and the refraction becomes visible.`;

export const RENDER_KEYS = `\`render\` is **async** — always \`await\` it. It loads the fonts your text needs, walks the tree creating live nodes, stamps each \`key\`, and returns:

\`\`\`js
{
  root:  Handle,               // the top node of the tree
  keyed: { [key]: Handle }     // every node you gave a \`key\`
}
\`\`\`

A **Handle** is a small plain object safe to return or log: \`{ id, type, name, width, height, key?, text?, intent?, position?, left?, top? }\` (\`text\` on text nodes, \`key\` when the node had one).

\`width\`/\`height\` are **always numbers** — the real px measured after the whole tree is laid out, so \`bar.width + 8\` always works. They are the node's **own** size, unaffected by any \`rotate\` you applied.

\`\`\`js
out.keyed.bar.width;      // 320       — what it came out at
out.keyed.bar.intent;     // { width: "fill" }
out.keyed.chip.intent;    // undefined — a plainly fixed node
\`\`\`

**\`intent\` tells you whether that number is yours to keep.** It appears only on an axis the *layout* owns — one you sized \`"fill"\` or \`"hug"\` — because such an axis re-measures whenever its parent or content changes. Reading \`320\` off a \`"fill"\` bar and hardcoding \`w: 320\` is how a responsive design silently becomes a fixed one. On a plainly fixed axis there is no \`intent\`: the measurement *is* what you asked for.

\`left\`/\`top\` are the offset inside the parent, and appear **only when the parent doesn't place the node** (a child of a plain frame, or one you positioned with \`absolute\`); under \`row\`/\`column\` the parent decides the position, so there is nothing to report. An \`absolute\` child of a \`row\`/\`column\` parent also carries \`position: "absolute"\`.

The read verbs (\`get\`, \`find\`) name geometry the same way, so a node you just rendered and a node you looked up read alike. They differ in one place: having only just measured it, \`render\` can hand you the number *and* the rule, while \`find\` has one field for both — it reports \`width: "fill"\` and withholds the px, so nothing tempts you to pin a size the design didn't fix.

**Keys are opt-in addressing.** Only keyed nodes appear in \`out.keyed\`; unkeyed nodes stay anonymous. Keys must be **unique within a single render** (a duplicate is a loud error) and are global to the render — namespace by hand (\`"email:input"\`). The key is stored on the node (\`pluginData("flcm/key")\`).

\`\`\`js
const out = await flcm.render(screen);
out.root.id;                  // the top frame's id
out.keyed.card.type;          // "FRAME"
out.keyed["email:input"].id;  // a nested keyed node
\`\`\`

**Return ids or handles, never live Figma nodes.** A live node can't cross the bridge (it collapses to a bare \`{ id }\`), so returning one is a loud error telling you to return the id instead. The handles from \`render\` are safe to return as-is.`;

// The one fragment that documents a *tool* rather than a DSL verb. That crossing is deliberate: the
// build→see→fix loop spans both layers, and this reference is the agent's whole map — a loop documented
// only on one side is the loop an agent never runs. The wording keeps the layer distinction explicit so
// it can't read as "get_screenshot is part of flcm".
export const VERIFY_READBACK = `You cannot judge what you built from the code you wrote — hairlines, grain, glass, 1px strokes, and unrenderable glyphs all *look* fine in source. **Build → screenshot → look → fix.**

\`get_screenshot\` is a separate **MCP tool**, a sibling of \`figma_execute_code\` — **not** an \`flcm\` verb. There is no \`flcm.screenshot\`. Each \`figma_execute_code\` call runs in its own sandbox scope, so a live handle can't be handed to another tool call; what crosses is a **string you copy** out of the render result.

\`\`\`js
// call 1 — figma_execute_code
const out = await flcm.render(card);
return { id: out.root.id, bar: out.keyed.transportBar.id };
\`\`\`

\`\`\`
// call 2 — get_screenshot
{ "nodeId": "12:345" }             // the id you just returned
{ "key": "transportBar" }          // or a key you authored — resolved on the current page
{ "nodeId": "12:345", "scale": 3 } // 3× resolution, to inspect fine detail
\`\`\`

- **\`nodeId\`** — any handle's \`.id\` from \`render\` (\`out.root.id\`, \`out.keyed.<key>.id\`), or an id from a read verb.
- **\`key\`** — a \`key\` you authored, resolved against \`pluginData("flcm/key")\` on the current page. A key matching **no** node, or **more than one** (duplicating a node copies its key), fails loud naming the problem — a failed lookup never quietly falls back to a page-wide capture.
- **Omit both** to capture the whole current page.
- **\`scale\`** (>0, ≤4; default 1) multiplies export resolution. Detail below ~24px — a 1px stroke, a hairline divider, grain, glass refraction, small type — is not reliably judgeable at 1×; screenshot it at 2–4×.

Pass a param name the tool doesn't know and it says so, naming the key and the valid ones. It does **not** silently ignore it, so a typo costs one retry rather than a wrong conclusion.

### The raw \`figma.*\` escape hatch

The full Figma plugin API global is in scope inside \`figma_execute_code\`, alongside \`flcm\`. **Author with \`flcm\`** — it's the surface that fails loud instead of rendering wrong pixels. **Drop to \`figma.*\`** for the things the DSL deliberately doesn't cover: page and viewport operations (\`figma.currentPage\`, \`figma.viewport.scrollAndZoomIntoView([node])\`), selection, node deletion, and anything else about the *document* rather than the *design*.

\`\`\`js
const out = await flcm.render(screen);                                  // author with flcm
const node = await figma.getNodeByIdAsync(out.root.id);                 // drop out for document ops
figma.viewport.scrollAndZoomIntoView([node]);
return out.root.id;
\`\`\`

Raw \`figma.*\` gives up every guarantee this DSL makes (fills are 0–1 and must be assigned as a new array, fonts must be loaded before \`characters\`, a node is invisible until appended) — so use it for *plumbing*, and come back to \`flcm\` to author.`;

export const CSS_SUBSET = `Leaf values are CSS-familiar, but only a **documented subset** is supported. Anything outside it throws a specific error naming what went wrong — it never renders wrong pixels.

### Colors

- Hex: \`#rgb\`, \`#rgba\`, \`#rrggbb\`, \`#rrggbbaa\` (the 4th/8th component is alpha).
- \`rgb(r, g, b)\` / \`rgba(r, g, b, a)\` — channels are **0–255**, alpha is **0–1**. Comma, space, or slash separators are all fine (\`rgb(255 0 0 / 0.5)\`).
- **Not** supported (these throw): named colors (\`red\`, \`transparent\`), percent channels (\`rgb(100% 0% 0%)\`), other color spaces (\`hsl()\`, \`lab()\`). Use hex or \`rgb\`/\`rgba\`.

### Gradients

\`linear-gradient(<head>?, <stop>, <stop>, …)\`:
- \`<head>\` is optional: an **angle** \`"<deg>deg"\` (default \`180\`, top→bottom) **or** a side \`"to top|right|bottom|left"\`.
- Not supported: \`grad\`/\`rad\`/\`turn\` angles, corner sides (\`to top right\`).

\`radial-gradient(<geometry>?, <stop>, …)\`:
- \`<geometry>\` is optional: \`circle\` (renders as a radial), \`ellipse\` (renders as a diamond), and/or an \`at X% Y%\` center (**percentages only**).
- Not supported: pixel/keyword centers, size keywords (\`closest-side\`).

\`conic-gradient(...)\` is **not supported** (it maps to an angular gradient, outside the subset) — it throws.

**Stops** (both types): \`<color> [<position>%]\`, e.g. \`#0B1020 0%\`, \`rgba(0,0,0,0.5) 70%\`. A stop with no position is placed by an even spread.

\`\`\`js
"linear-gradient(180deg, #0B1020 0%, #131A2E 100%)"    // ok
"linear-gradient(to right, #000, #fff)"                // ok
"radial-gradient(circle, #2A3A66 0%, #0B102000 70%)"   // ok — fades to transparent
"conic-gradient(#000, #fff)"                           // ✗ throws (angular, out of subset)
"linear-gradient(0.25turn, #000, #fff)"                // ✗ throws (only deg)
\`\`\`

### Effects (CSS strings)

When you pass effects as CSS strings (\`effects: { … }\`):
- \`boxShadow\` / \`textShadow\`: \`[inset] <x>px <y>px <blur>px [<spread>px] <color>\`, comma-separated for multiple.
- \`filter\`: **\`blur(Npx)\` only** — a layer blur. Any other function (\`drop-shadow(...)\`, \`brightness(...)\`) throws.
- \`backdropFilter\`: **\`blur(Npx)\` only** — a background blur. Figma's background blur has just a radius: \`saturate()\`/\`brightness()\`/\`contrast()\` and other backdrop-filter functions have no equivalent and throw.

### Blend mode

\`mixBlendMode\` takes a CSS \`mix-blend-mode\` name — \`multiply\`, \`screen\`, \`overlay\`, \`soft-light\`, \`hard-light\`, \`color-dodge\`, \`color-burn\`, \`darken\`, \`lighten\`, \`difference\`, \`exclusion\`, \`hue\`, \`saturation\`, \`color\`, \`luminosity\`, or \`normal\`. Any other name throws. (Figma's \`pass-through\` and the linear burn/dodge modes have no CSS spelling and aren't offered.)

### Metrics

| Where | Accepts |
| --- | --- |
| \`layout.gap\`, \`strokeWidth\`, \`borderRadius\` | number or \`"Npx"\` |
| \`layout.padding\` (and its \`x\`/\`y\`/\`top\`/…) | **numbers only** (not \`"px"\` strings) |
| \`width\`, \`height\` | a **number** (fixed px), \`"N%"\` (percent of the parent's realized size — see Percent sizing), or \`"fill"\` / \`"hug"\` |
| \`absolute.x/y\` | a number (px) or \`"N%"\` (percent of the parent axis); \`absolute.anchor\` sets which point of the node lands there |
| \`textStyle.fontSize\`, \`rotation\`, \`length\`, \`opacity\` | numbers |
| \`textStyle.lineHeight\`, \`textStyle.letterSpacing\` | number(px), \`"Npx"\`, \`"N%"\`, \`"Nem"\` (lineHeight also \`"auto"\`) |`;

export const FAILS_LOUD = `The whole point of accepting CSS is fidelity, so the boundaries are strict. These throw a specific error rather than guessing or silently doing nothing:

| Situation | What happens |
| --- | --- |
| A color / gradient / effect outside the [CSS subset](#the-css-subset) | A parse error naming the offending value and why. |
| A **read-artifact image fill** (\`{ type: "IMAGE", imageRef, … }\`) on \`fill\`/\`stroke\`/\`color\` | Rejected: it's a ref to bytes we don't have. Author an image with \`flcm.image(url)\` instead. |
| An \`flcm.image\` url that is unfetchable, blocked (private/loopback range), oversize, or not a real image | Rejected server-side: never a silent blank fill. |
| A \`flcm.text\` value that is neither a plain string nor a runs array (a structured read object), or text carrying figma-mcp style-ref tokens (\`{ts1}…{/ts1}\`) | Rejected: those are read artifacts. Author styled text as **markdown** or a **runs array** (see Rich text). A plain-string \`**\` is now **markdown** (bold), not literal — backslash-escape (\`\\\\*\\\\*\`) for a literal. |
| Markdown **image** syntax \`![alt](url)\` inside a \`flcm.text\` string, or an unrealizable \`fontStyle\`/\`textDecoration\` value (e.g. \`"oblique"\`, \`"overline"\`) | Rejected: text can't embed an image (use \`flcm.image(url)\`); the enum value names the supported set. |
| A **duplicate \`key\`** within one render | Rejected: keys must be unique per render. |
| A node \`type\` other than FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR | Rejected: those are the only createable types. |
| \`fill\`/\`stroke\` on \`flcm.svg\` | Rejected: colors are baked into the SVG markup, so they'd be a no-op. Edit the markup, or use \`flcm.path\` for a themeable vector. |
| Unparseable SVG markup (\`flcm.svg\`) or bad path \`d\` data (\`flcm.path\`) | Rejected: never a silent empty/blank node. |
| Returning a **live Figma node** from your code | Rejected: return the id string (or a handle) instead. |
| A bad \`pin\` value (not \`{ x?, y? }\`, or an axis outside its set) | Rejected: naming the offending value and the allowed names. |
| A percent \`width\`/\`height\` (\`"N%"\`) on an **in-flow** child of an **auto-layout** parent that **hugs** that axis (the child both sets and depends on the parent's size — a cycle), or a percent on the **root** node | Rejected: this is the one percent case a runtime read can't break. Give the parent a fixed or \`"fill"\` size on that axis, use \`"fill"\`/\`"hug"\` on the child, or lift it out with \`absolute\` (an out-of-flow child doesn't feed the hug, so it resolves fine). Every other percent — against a fixed, \`"fill"\`, \`"hug"\`, or percent-sized parent — resolves against the parent's realized size. |
| A bad \`absolute.anchor\` value (an axis outside \`left\`/\`center\`/\`right\` or \`top\`/\`center\`/\`bottom\`) | Rejected: naming the offending value and the allowed names. |
| An unknown \`mixBlendMode\` value (not a CSS \`mix-blend-mode\` name) | Rejected: naming the offending value and the supported set. |
| An unrealizable \`layout.justifyContent\`/\`layout.alignItems\` value — notably \`"space-around"\`/\`"space-evenly"\` | Rejected: Figma auto-layout has no space-around/space-evenly. Use \`"space-between"\` or add \`layout.gap\`/\`layout.padding\`; never faked with spacer nodes (they'd read as content). |
| \`textStyle.lineClamp\` on a **width-hugging** text (no bounded \`width\`) | Rejected: truncation needs a width to wrap against — a hugging text grows on one line, so \`textStyle.lineClamp\` would do nothing. Set \`width\` to a number, \`"fill"\`, or \`"N%"\`. |

Components, variables, and prototype interactions are deliberately **out of v1** — read concepts with no create path yet. Rejecting them loudly is intentional, so you never half-write something unrealizable. (Rich text is now authorable as a runs array, and images via \`flcm.image(url)\` — both above.)

### The one silent exception: unrenderable glyphs

Everything above fails **loud**. There is exactly one case that does not, because the Figma plugin API exposes no glyph-coverage check to key it off: **a character the resolved font can't render draws as nothing** — no glyph, no tofu box, no error. This bites emoji and private-use codepoints (e.g. SF Symbols) in fonts like Inter that don't carry them. If text you set renders blank, suspect a missing glyph before anything else, and switch to a font that covers the codepoint. This is the sole place the surface can silently whiff; treat unusual codepoints with suspicion until you've eyeballed a screenshot.`;
