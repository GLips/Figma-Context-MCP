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
- **CSS is the dialect — prop NAMES as well as values.** When CSS has a word for something, that is the word: \`color\`, \`fontSize\`, \`fontWeight\`, \`borderRadius\`, \`opacity\`, \`gap\`, \`padding\`, \`justifyContent\`, \`alignItems\`, \`mixBlendMode\` — camelCased, and \`column\`/\`row\` for direction. If you find yourself inventing a shorter name (\`radius\`, \`size\`, \`weight\`), reach for the CSS one instead. Where flcm has no CSS counterpart (\`key\`, \`anchor\`, \`pin\`, \`width: "fill"|"hug"\`) the props page is the only source — read it before your first render rather than guessing.
- **Leaf values are CSS too.** Colors, gradients, shadows, and metrics are written the way you'd write them in CSS (\`"#0B1020"\`, \`"rgba(255,255,255,0.06)"\`, \`"linear-gradient(180deg, …)"\`, \`"24px"\`, \`"-0.02em"\`). You write this one familiar format; we translate it to Figma-native values for you. The catch: CSS can spell things Figma can't realize, so values **outside the documented subset fail loud** (a specific error) rather than rendering wrong pixels.

There is no autocomplete and no type-checking where your code runs (a QuickJS sandbox), so everything you can write is spelled out in this reference. If a verb, prop, or value isn't documented, it isn't supported.`;

export const CHILDREN = `- A frame's children are the **second positional argument**: an array (or a single child).
- Children may be **falsy** — \`null\`, \`false\`, \`undefined\` are skipped, so \`showError && flcm.text(...)\` composes cleanly.
- **Z-order is document order: declare back-to-front.** Earlier children sit behind later ones; there is no \`z\`/\`layer\` prop. A decoration placed with \`left\`/\`top\` that should sit behind content is declared first.`;

export const RICH_TEXT = `\`flcm.text\` takes **either** a plain string **or** an array of **runs** — one text node, several styles.

**Markdown in a plain string** — \`**bold**\`, \`*italic*\`, \`~~strike~~\`, \`[text](url)\` — parses to styled spans:

\`\`\`js
flcm.text("Ship it **today** — see the [runbook](https://ex.co/run) first.");
\`\`\`

Backslash-escape to render one literally: \`"save 20% \\\\*today\\\\*"\`. Only \`\\ * _ ~ [ ] ( ) { }\` are escapable, and this matches figma-mcp's read output, so text you read back round-trips. \`![alt](url)\` fails loud — use \`flcm.image(url)\`.

**Runs array** — a run is a bare string or a \`[text, style]\` tuple. The style is a **delta** over the node-level \`textStyle\` base, so each span carries only what it changes:

\`\`\`js
// a feed caption as ONE node: a colored @handle, plain body, a muted "more"
flcm.text(
  [ ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
    " summited at golden hour. ",
    ["more", { color: "#8E8E93" }] ],
  { textStyle: { fontSize: 14 } },
);
\`\`\`

A run resolves its font exactly as the node does, and its delta may set any field in the table below. \`textAlign\`, \`textAlignVertical\` and \`lineClamp\` are whole-node only. A fixed \`width\` wraps the node into a flowing paragraph, so a styled paragraph is runs + a width.`;

export const PERCENT_SIZING = `\`width\`, \`height\`, \`left\` and \`top\` take a percent string — \`"50%"\` of the parent's size on that axis, resolved against its *realized* size once layout settles (so a percent child of a \`"fill"\` or percent-sized parent is fine).

\`\`\`js
flcm.frame({ width: 300, height: 8, borderRadius: 4, fill: "#E5E7EB" }, [
  flcm.rect({ width: "35%", height: 8, borderRadius: 4, fill: "#6366F1" }),   // 35% of the track
]);
\`\`\`

One case can't resolve and **fails loud**: an in-flow percent-*sized* child of an auto-layout parent that *hugs* that axis — the parent sizes to the child while the child sizes to the parent. Give the parent a fixed or \`"fill"\` size, or lift the child out of the flow with \`left\`/\`top\`. A percent (or \`"fill"\`) on the **root** fails loud too: its parent is the page, which is unbounded.

**Responsive by default.** A percent renders to fixed pixels now, and a **positioned** child — one in a free-form parent, or one lifted out of an auto-layout flow by \`left\`/\`top\` — also gets a Figma constraint, so it still reflows when the parent is resized later. Per axis, derived from how you sized it:

| You wrote | Auto constraint | On resize |
| --- | --- | --- |
| \`width:"fill"\` | stretch | grows/shrinks with the parent |
| \`width:"N%"\` | scale | scales proportionally |
| \`left:"N%"\` | center | holds its relative spot |
| a plain number | near edge | stays put (Figma default) |

**\`pin\`** overrides that choice; **\`anchor\`** picks which point of the node lands on \`left\`/\`top\` (default top-left), which is what saves the half-width subtraction when centring:

\`\`\`js
// a close button that stays top-right as the card widens
flcm.frame({ width: 320, height: 200 }, [
  flcm.rect({ width: 28, height: 28, left: 284, top: 12, pin: { x: "right", y: "top" } }),
]);

// a knob centred on the 40% mark
flcm.ellipse({ width: 16, height: 16, left: "40%", top: "50%", anchor: { x: "center", y: "center" } });
\`\`\`

\`pin\` is ignored on an in-flow auto-layout child, which reflows through \`fill\`/\`hug\` instead. A bad \`pin\` or \`anchor\` value fails loud.`;

export const VECTOR_INTRO = `Render real vector art — icons, logos, glyphs — instead of composing them from rects/ellipses or leaning on emoji (which render inconsistently and read as *content*, not iconography). There is **no built-in icon catalog**: bring your own SVG markup or path data.

Two verbs, two contracts — not interchangeable:

- **\`flcm.svg(markup, props?)\`** — paste a whole \`<svg>…</svg>\` and get it as-is. Colors are baked into the markup, so \`fill\`/\`stroke\` fail loud here; it takes size/position only.
- **\`flcm.path(props)\`** — one vector from a single \`d\` string, taking our appearance props, so it themes like any other primitive. \`d\` is required.

\`\`\`js
// a themeable play triangle — fills with the theme color like a rect
flcm.path({ d: "M8 5 L19 12 L8 19 Z", fill: "#6366F1", width: 24, height: 24 });

// an opaque brand logo — colors live in the markup
flcm.svg('<svg viewBox="0 0 24 24"><path d="M12 2 L22 20 L2 20 Z" fill="#0B1020"/></svg>', { width: 32, height: 32 });
\`\`\`

A \`path\` with no \`fill\` is transparent, like a rect. Unparseable markup or bad \`d\` data fails loud rather than leaving a blank node.

**Sizing differs.** A \`path\` sizes to its \`d\` data's bounding box and needs no \`width\`/\`height\` to appear at natural size; \`width\`/\`height\` scale that box. An \`svg\` scales its \`viewBox\` into the size you give it.

**For uniform translucency use node-level \`opacity\`** — it flattens the vector and fades it as one layer. \`fill-opacity\`/\`stroke-opacity\` inside markup composite per-subpath, so they seam where subpaths overlap.`;

export const PAINT_INTRO = `A paint value (for \`fill\`, \`stroke\`, or a run's \`color\`) is one of:

- a **solid color string** — \`"#FF0000"\`, \`"#FF0000AA"\`, \`"rgba(255,0,0,0.5)"\`;
- a **gradient string** — \`"linear-gradient(…)"\` / \`"radial-gradient(…)"\`;
- \`flcm.gradient(...)\`, which builds the same value without the string; or
- \`flcm.image(src)\` — a raster fill from a url or local path (see **Images**).

\`\`\`js
flcm.frame({ fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" });
flcm.frame({ fill: flcm.gradient({ stops: ["#0B1020", "#131A2E"], angle: 180 }) });
flcm.gradient("linear" | "radial", stops, angle);   // the positional form
\`\`\``;

export const IMAGE_INTRO = `Place a **real raster image** — feed media, an avatar, a thumbnail — instead of faking it with a gradient (which carries no signal it was ever meant to be an image).

\`flcm.image(src, opts?)\` is a **paint value**, like \`flcm.gradient\` — not a node type. An image in Figma is a fill, so any shape carries one: a \`rect\` for a photo, an \`ellipse\` for a circular avatar, a \`frame\` for a hero. \`src\` is an https url or a local file path, like CSS \`url()\`.

\`\`\`js
flcm.ellipse({ width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") });
flcm.rect({ width: 120, height: 40, fill: flcm.image("public/logo.png", { scaleMode: "FIT" }) });
\`\`\`

- **The server loads the bytes** — your code never touches the network or the filesystem. Any public http(s) url works.
- **Local paths are confined to the server's asset root** (\`--asset-root\`, default: the directory the server started in). A path outside it is refused, naming the root.
- An **unfetchable, blocked, out-of-root, oversize, or non-image source fails loud** — never a silent blank fill.`;

export const EFFECTS_INTRO = `Write effects as the CSS you'd already write — a bag of \`{ boxShadow?, textShadow?, filter?, backdropFilter? }\`. \`flcm.effects({...})\` is the second form, and the only way to reach the Figma-native effects CSS has no word for (\`glass\`, \`noise\`, \`texture\`, \`progressiveBlur\`).

\`\`\`js
flcm.frame({ effects: { boxShadow: "0 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(16px)" } });
flcm.frame({ effects: flcm.effects({ shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" }, glass: { refraction: 0.4 } }) });
\`\`\`

Blur values are written in **CSS px** — you always write the CSS number and we map it to Figma's scale for you.

**\`glass\` needs a high-frequency backdrop to read as glass.** \`refraction\` and \`dispersion\` bend what is *behind* the pane, so over a flat fill or a smooth gradient there is nothing to bend and the result looks like a plain frosted tint — that's the physics of the scene, not a broken effect. Put busy content behind it (an image, dense text, an icon grid, a sharp-edged shape) and the refraction becomes visible.`;

export const RENDER_KEYS = `\`render\` is **async** — always \`await\` it. It loads fonts, creates the nodes, stamps each \`key\`, and returns:

\`\`\`js
{
  node:  Handle,               // the top node of the tree
  keyed: { [key]: Handle }     // every node you gave a \`key\`
}
\`\`\`

A **Handle** is a plain object safe to return or log: \`{ id, type, name, width, height, key?, text?, intent?, position?, left?, top? }\`.

\`width\`/\`height\` are **always numbers** — real px measured after layout settles, so \`bar.width + 8\` works. They're the node's own size, unaffected by \`rotation\`.

\`\`\`js
out.keyed.bar.width;      // 320       — what it came out at
out.keyed.bar.intent;     // { width: "fill" }
out.keyed.chip.intent;    // undefined — a plainly fixed node
\`\`\`

**\`intent\` tells you whether that number is yours to keep.** It appears only on an axis the layout owns (\`"fill"\`/\`"hug"\`), which re-measures whenever the parent or content changes — reading \`320\` off a \`"fill"\` bar and hardcoding it is how a responsive design silently becomes fixed.

\`left\`/\`top\` are the offset in the parent, present **only when the parent doesn't place the node** (a child of a plain frame, or one lifted out of an auto-layout flow — which also carries \`position: "absolute"\`). They are the same \`left\`/\`top\` you write.

\`get\`/\`find\` name geometry the same way, with one difference: \`render\` just measured, so it gives the number *and* the rule; \`find\` reports \`width: "fill"\` and withholds the px, so nothing tempts you to pin a size the design didn't fix.

**Keys are opt-in addressing.** Only keyed nodes appear in \`out.keyed\`. They must be unique within a render (a duplicate is a loud error) and are global to it, so namespace by hand (\`"email:input"\`). The key is stored on the node (\`pluginData("flcm/key")\`).

**Return ids or handles, never live Figma nodes** — a live node can't cross the bridge, so returning one is a loud error.`;

// The one fragment that documents a *tool* rather than a DSL verb. That crossing is deliberate: the
// build→see→fix loop spans both layers, and this reference is the agent's whole map — a loop documented
// only on one side is the loop an agent never runs. The wording keeps the layer distinction explicit so
// it can't read as "get_screenshot is part of flcm".
export const VERIFY_READBACK = `You cannot judge what you built from the code you wrote — hairlines, grain, glass, 1px strokes and missing glyphs all *look* fine in source. **Build → screenshot → look → fix.**

\`get_screenshot\` is a separate **MCP tool**, not an \`flcm\` verb (there is no \`flcm.screenshot\`). Each \`figma_execute_code\` call runs in its own scope, so what crosses between calls is a **string you copy** out of the render result.

\`\`\`js
// call 1 — figma_execute_code
const out = await flcm.render(card);
return { id: out.node.id, bar: out.keyed.transportBar.id };
\`\`\`

\`\`\`
// call 2 — get_screenshot
{ "nodeId": "12:345" }             // the id you just returned
{ "key": "transportBar" }          // or a key you authored — resolved on the current page
{ "nodeId": "12:345", "scale": 3 } // 3× resolution, to inspect fine detail
\`\`\`

- **\`nodeId\`** — any handle's \`.id\`, or an id from a read verb.
- **\`key\`** — a key you authored. Matching no node, or more than one, fails loud; a failed lookup never falls back to a page-wide capture.
- **Omit both** to capture the whole current page.
- **\`scale\`** (>0, ≤4; default 1) multiplies export resolution. Detail below ~24px — a 1px stroke, a hairline, grain, small type — isn't reliably judgeable at 1×; shoot it at 2–4×.

An unknown param name is named back to you, not ignored, so a typo costs one retry rather than a wrong conclusion.

### The raw \`figma.*\` escape hatch

The full Figma plugin API is in scope alongside \`flcm\`. **Author with \`flcm\`** — it's the surface that fails loud instead of rendering wrong pixels. **Drop to \`figma.*\`** for what the DSL doesn't cover: viewport, selection, and other *document* rather than *design* operations.

\`\`\`js
const out = await flcm.render(screen);                                  // author with flcm
const live = await figma.getNodeByIdAsync(out.node.id);                 // drop out for document ops
figma.viewport.scrollAndZoomIntoView([live]);
return out.node.id;
\`\`\`

**Pages** are covered — every verb acts on the current page, and \`flcm.page\` is how you see and change which one that is:

\`\`\`js
await flcm.page.current();          // { fileName, page: { id, name }, pages: [ … ] } — where am I?
await flcm.page.new("pricing");     // make it and switch to it; a name already in the file fails loud
await flcm.page.use("pricing");     // switch to one that exists (name or id); never creates
\`\`\`

Switch **before** you render — a render lands on whatever page is current when it runs. Don't reach for \`figma.currentPage = page\`: under \`documentAccess: "dynamic-page"\` that property is read-only and assigning it throws, which is the trap \`flcm.page\` removes.

Raw \`figma.*\` gives up every guarantee this DSL makes (fills are 0–1 assigned as a new array, fonts load before \`characters\`, a node is invisible until appended) — use it for plumbing, and come back to \`flcm\` to author.`;

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
- \`boxShadow\` / \`textShadow\`: \`[inset] <x> <y> [<blur>] [<spread>] <color>\`, comma-separated for multiple. Lengths are \`Npx\` or a bare \`0\`; the color is required (\`currentColor\` can't be resolved here).
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
| \`left\`/\`top\` | a number (px) or \`"N%"\` (percent of the parent axis); \`anchor\` sets which point of the node lands there. Naming either lifts a child out of an auto-layout flow |
| \`textStyle.fontSize\`, \`rotation\`, \`opacity\` | numbers |
| \`textStyle.lineHeight\`, \`textStyle.letterSpacing\` | number(px), \`"Npx"\`, \`"N%"\`, \`"Nem"\` (lineHeight also \`"auto"\`) |`;

export const FAILS_LOUD = `Accepting CSS is a fidelity promise, so the boundaries are strict. Each of these throws a specific error naming the offending value — never a guess, never a silent no-op:

| Situation | Why, and the fix |
| --- | --- |
| A color / gradient / effect outside the [CSS subset](#the-css-subset) | Parse error naming the value. |
| A read-artifact image fill (\`{ type: "IMAGE", imageRef, … }\`) on \`fill\`/\`stroke\` | A ref to bytes we don't have — author with \`flcm.image(url)\`. |
| An \`flcm.image\` source that is unfetchable, blocked (private/loopback), outside the server's asset root, oversize, or not an image | Rejected server-side with the reason, never a blank fill. |
| An \`flcm.text\` value that is neither a string nor a runs array, or text carrying read style-ref tokens (\`{ts1}…{/ts1}\`) | Those are read artifacts. Author styled text as markdown or runs. \`**\` in a plain string is markdown — backslash-escape for a literal. |
| \`![alt](url)\` in a text string, or an unrealizable \`fontStyle\`/\`textDecoration\` (\`"oblique"\`, \`"overline"\`) | Text can't embed an image (\`flcm.image\`); the enum names the supported set. |
| A duplicate \`key\` in one render | Keys are unique per render. |
| A node \`type\` outside FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR | Those are the only createable types. |
| A hand-built node POJO (including a spread-copy of a real one) | The constructors validate at the boundary; a hand-assembled shape could smuggle a combination they'd refuse. Nodes compile at construction and are sealed, so mutating one afterwards throws. |
| \`fill\`/\`stroke\` on \`flcm.svg\` | Colors are baked into the markup — edit it, or use \`flcm.path\` for a themeable vector. |
| Unparseable SVG markup, or bad path \`d\` data | Never a silent blank node. |
| Returning a live Figma node | Return the id string or a handle. |
| A bad \`pin\` or \`anchor\` value, or \`anchor\` on an axis without its \`left\`/\`top\` | Names the value and the allowed set. |
| A percent \`width\`/\`height\` on an in-flow child of a parent that hugs that axis, or a percent/\`"fill"\` on the root | A genuine cycle (and the page is unbounded). Give the parent a fixed or \`"fill"\` size, or lift the child out of the flow with \`left\`/\`top\`. |
| An unknown \`mixBlendMode\` | Names the value and the supported set. |
| \`layout.justifyContent\`/\`alignItems\` Figma can't realize — \`"space-around"\`, \`"space-evenly"\` | Use \`"space-between"\` or \`gap\`/\`padding\`. Never faked with spacer nodes, which read as content. |
| \`textStyle.lineClamp\` on a width-hugging text | Truncation needs a width to wrap against. Set \`width\` to a number, \`"fill"\`, or \`"N%"\`. |
| A layout word the node can't realize — a fixed/\`"hug"\`/percent \`height\` on TEXT, \`"hug"\` with nothing to measure, or container words without \`layout.mode\` | The same rules govern create and edit alike, so a word that wouldn't land names the fix instead. |

Variables and prototype interactions are deliberately **out of v1** — read concepts with no create path. They're rejected loudly so you never half-write something unrealizable. (Components have one: \`flcm.instance\` — see the components section.)

### The one silent exception: unrenderable glyphs

Everything above fails loud. One case can't, because the plugin API exposes no glyph-coverage check: **a character the resolved font can't render draws as nothing** — no glyph, no tofu, no error. This bites emoji and private-use codepoints (SF Symbols) in fonts like Inter. If text renders blank, suspect a missing glyph first and switch to a font that covers it. Treat unusual codepoints with suspicion until you've seen a screenshot.`;

export const EDIT_INTRO = `\`await flcm.edit(target, changes)\` applies a partial delta to one existing node and returns its updated handle. The target is anything the read verbs accept: an flcm/key, a node id, \`flcm.id(id)\`, or a handle from \`render\`/\`find\`. The delta uses the **same words as create** — there is no separate edit dialect — and only the fields you pass change; everything else on the node is untouched.`;

export const EDIT_REMOVAL = `### Removal — the \`"none"\` word

\`"none"\` is the one removal word, surface-wide: \`fill\`/\`stroke\` clear the paint, \`effects\` clears every effect, \`position: "none"\` returns the node to its parent's flow, \`pin\` (or \`pin: { x: "none" }\` per axis) restores the near-edge default, \`layout: { mode: "none" }\` switches auto-layout off. The same spellings are legal at create, where they mean the explicit default. Sizes are never removed, only replaced within the number/\`"fill"\`/\`"hug"\` trio — \`width: "hug"\` is how a fixed width comes off.`;

export const EDIT_RULES = `### Rules

- **A node type takes exactly the words create accepts for it.** \`fill\` on a LINE, \`clip\` on a TEXT, \`borderRadius\` on a VECTOR — each rejects loud, naming the prop, the type, and that type's editable words.
- **Only the fields you pass change — per axis, too.** \`pin: { x: "center" }\` keeps the y pin; \`left: 10\` keeps the live \`top\`; \`width: "hug"\` leaves the height alone.
- **Un-filling really un-fills.** \`width: 80\` or \`"hug"\` on a \`"fill"\` child clears the grow/stretch marks — the new size governs.
- **Container edits ripple by stated rules.** \`layout.alignItems: "stretch"\` walks the live children setting their stretch marks; any other value clears every one (Figma doesn't record which child stretched because of the container, so a child that should keep filling needs its own \`height: "fill"\`). Changing direction — row↔column, or \`"none"\` to either — clears both flow marks on every in-flow child, since the axes they meant just moved.
- **Layout legality is create's rule set, applied to live facts** and rejected before any write: a percent on an in-flow child of a hugging parent, \`"fill"\`/\`"N%"\` under the page, \`"hug"\` with nothing to measure, a fixed/hug/percent \`height\` on TEXT, or container words on a frame that isn't (and after this delta still won't be) a row/column container. Percents resolve immediately against the live parent.
- **Text words read the LIVE node.** \`text\` replaces the whole text and collapses it to its LEADING run's style — prior bold spans and per-range colors do NOT survive, so style the new text in the same edit. A \`textStyle\` naming part of the font triple keeps the live rest (\`fontWeight: "bold"\` on italic Roboto stays bold italic Roboto). A text that already MIXES fonts has no single base: a partial font change, or a styled \`text\` run without its own \`fontFamily\`, rejects loud — anchor \`textStyle.fontFamily\` in the same edit, or give every run its family. \`lineClamp\` needs a bounded width.
- **Edits inside a component INSTANCE apply as overrides.** A property Figma forbids overriding rejects, naming the instance — edit the main component (flcm never auto-detaches).
- **An INSTANCE target also takes its three component words** — \`componentProperties\`, \`overrides\`, and \`componentId\` (the swap). See the components section; on any other node type each fails loud as an unknown word for that type.
- **\`key\` is immutable** — re-keying could mint a duplicate address. Set \`name\` to change the layers panel.
- **No bare \`x\`/\`y\`** — position is \`left\`/\`top\` (naming either lifts a child out of an auto-layout flow; \`position: "absolute"\` lifts it in place, \`position: "none"\` returns it), resize behavior is \`pin\`.
- **An empty delta is rejected**, since it would still mint an undo step.
- **Each edit is one undo step.** The whole delta validates before the first write; a Figma refusal mid-apply rolls the node back, and the error carries the target's identity, Figma's reason, and how many earlier mutating calls still stand.
- Delta values are **absolute**, never relative (\`+10\`), so re-running an edit converges instead of compounding.`;

export const EDIT_MANY = `### Many at once — \`flcm.editMany\`

\`await flcm.editMany([{ target, changes }, …], { within? })\` applies a whole set of deltas as **one** call, returning a handle per entry in order. Each \`changes\` is exactly an \`flcm.edit\` delta.

Reach for it whenever you're nudging more than one node — a loop over \`flcm.edit\` is not the same thing:

- **The set is atomic.** Every target resolves and every delta validates before the first write; a loop would already have mutated entries 1–3 when entry 4's typo surfaced.
- **One rejection names every bad entry**, indexed, so you fix the batch in one pass.
- **The whole batch is one undo step.**
- **Order doesn't matter** — entries settle ancestors-first, so turning a parent into a row and setting its child to \`width: "fill"\` works either way round.
- **Two entries for the same node reject** rather than last-wins; put both fields in one entry.

Props only: tree shape stays with \`append\`/\`move\`/\`remove\`/\`clone\`.`;

export const STRUCTURE_INTRO = `Tree shape is its own set of verbs, and **position is the verb** — no index argument, no options bag. \`append\`/\`prepend\` take the parent; \`insertBefore\`/\`insertAfter\` take a **sibling** and work out the parent from it.

\`thing\` is one of two, meaning what they mean in the DOM:

- a **constructor spec** — built inside the destination. Returns \`{ node, keyed, to }\`: what \`render\` gives you, plus the container it landed in.
- a **target naming a live node** — **moved** there, as \`appendChild\` moves an attached DOM node. Returns \`{ node, from, to }\`.

Three more complete the set: \`flcm.move(target, parent)\` is the plain reparent (subject named first, node lands last), \`flcm.remove(target)\` deletes a node and its subtree, \`flcm.clone(target, parent?)\` duplicates one.

**\`clone\` is the copy path for subtrees a rebuild can't reproduce** — anything containing an INSTANCE, which is most real content. It duplicates the LIVE node, and the copy comes back **key-less** (a raw \`node.clone()\` would copy the \`flcm/key\` too, giving two nodes one address). It is faithful down to coordinates, so in a free-form parent it lands on top of the original — edit its \`left\`/\`top\` to separate them.

Every return carries the subject plus each container whose geometry could have changed — flat handles with fresh geometry, never nested trees. \`to\` is where things ended up, \`from\` is what something left; either is absent when that container is the page, and \`from\` is absent when you reordered inside one parent.`;

export const STRUCTURE_RULES = `### Rules

- **Sizing that depends on the parent works on insert.** The node is attached *before* it is sized, so \`width: "fill"\` on an appended spec fills the destination.
- **Layout legality is re-asked against the DESTINATION**, with the new parent's facts: \`"fill"\`/\`"N%"\` into a page parent, a TEXT \`height: "fill"\` landing out of a row/column flow, a percent child of a hugging parent, or any parent-relative word under a GRID parent each reject loud before anything moves. Legal where a node sat is not automatically legal where it lands.
- **A move re-aims the moved node's fill.** \`"fill"\` is a mark on the parent's primary or counter axis, and those axes move with the node, so it is cleared and re-applied against the new parent. Fixed sizes are untouched.
- **A stretch container does not stretch what you insert.** Figma stores no container-level stretch — a stretched child is indistinguishable from one that asked for counter-axis \`"fill"\` — so re-assert it with \`flcm.edit(parent, { layout: { alignItems: "stretch" } })\`, which re-synthesizes the marks over every child.
- **An instance's CHILD LIST is closed.** Placing into an instance, or moving/removing one of its children, rejects loud and names it — edit the main component instead. The instance itself is an ordinary node: moving, removing and cloning it are fine.
- **A node can't be placed inside itself or its own subtree**; the refusal names both nodes.
- **Each call is one undo step**, with \`edit\`'s contract: validate before the first write, roll the whole call back on a Figma refusal.

### Cut, copy, paste

No separate clipboard API — the verbs compose:

| You want | Use |
| --- | --- |
| cut & paste | \`flcm.move(target, parent)\` |
| paste a faithful copy | \`flcm.clone(target, parent?)\` — any subtree, instances included |
| paste with modifications | \`flcm.append(parent, flcm.fromRead(spec))\`, or \`clone\` then \`edit\` |
| delete | \`flcm.remove(target)\` |

\`flcm.get\` returns \`{ node, components }\`. \`node\` is the read spec; \`components\` appears only when the subtree holds a component or an instance of one, and names each one ONCE — its \`children\` and its property definitions live there, keyed by component id. An INSTANCE therefore carries no \`children\` of its own: it carries \`componentId\` plus \`overrides\`, a map from component-relative sublayer path to just the fields that differ from the component. An omitted field means "same as the component"; \`null\` means the instance does not have that field at all (a paint removed, an opacity put back to 1); \`visible: false\` means the designer hid that layer. Reconstruct any sublayer's live id as \`I<instanceId>;<path>\`. An entry marked \`childrenUnverified\` came from a published library at its current version, which the file may not have adopted — treat a \`visible: false\` under it as possibly a layer the library added rather than one the designer hid; \`childrenFrom\` instead means the children were donated by that instance, edits and all.

A \`get\` result is not authoring input on its own: a bare read spec passed to \`append\` is rejected rather than quietly treated as a move, because the spec carries a live \`id\` exactly as a handle does — only you can say copy or move. \`flcm.fromRead(spec)\` says copy: it re-authors the subtree through the constructors, so you can edit the spec first (\`{ ...spec, width: 320 }\`), and the copy comes back key-less. A single node's spec also spreads straight into its constructor or an edit — \`flcm.rect({ ...spec, width: 320 })\` — since the constructors read the read shape's spellings; \`fromRead\` is for a subtree, whose \`children\` are specs rather than built nodes.

\`fromRead\` rebuilds; \`clone\` duplicates. Rebuilding reaches only what flcm can author, so a stacked paint, a grid container or a flattened \`IMAGE-SVG\` fails loud naming the field — \`clone\` is the answer for those. An INSTANCE rebuilds through \`flcm.instance\`: a fresh stamp of the same component, with the read's property values and overrides re-applied.`;

export const COMPONENTS_CREATE = `\`await flcm.component(specOrTarget, options?)\` makes a COMPONENT — the thing instances come from — and returns \`{ node, keyed }\` the way \`render\` does, where \`node\` is the COMPONENT's own handle.

Two forms, told apart exactly as \`append\` tells them apart (a constructor spec, or a target naming a live node):

\`\`\`js
// Build and promote in one call — the spec renders on the current page exactly as flcm.render would.
const { node, keyed } = await flcm.component(
  flcm.frame({ name: "Button", layout: { mode: "row", gap: 8, padding: 12 }, fill: "#111", borderRadius: 8 }, [
    flcm.text("Label", { key: "label", fill: "#fff", componentPropertyReferences: { text: "Label" } }),
  ]),
  { name: "Button", propertyDefinitions: { Label: { type: "text" } } },
);

// Or promote a node that already exists, where it stands — same parent, same index.
await flcm.component(flcm.id("12:34"), { name: "Card", description: "The list card." });
\`\`\`

- **The spec form** renders first (the same font loading, image fetching and root placement as \`render\`), then promotes the root. Every \`key\` in the tree survives the promotion — including the root's, which lands on the COMPONENT — so \`keyed\` addresses the component's own children.
- **The target form** promotes in place. It refuses by name: a COMPONENT or COMPONENT_SET (it already is one — edit it), an INSTANCE (Figma would *wrap* the instance rather than promote it — detach it first), a node inside an instance, a SLOT, and a page.
- \`name\` defaults to the spec's — or the promoted node's — own name. \`description\` is what Figma shows beside the component in the assets panel.
- Nothing is written until every gate passes, and the whole call is one undo step.`;

export const COMPONENTS_PROPERTIES = `A component's properties are declared in the call that makes it — \`propertyDefinitions\`, the read's own word — and the nodes inside say which property drives which of their fields through \`componentPropertyReferences\`, the read's own word for a binding. The two halves are checked against each other before anything is written: a binding naming a property the call doesn't declare fails loud listing the ones it does.

\`\`\`js
await flcm.component(
  flcm.frame({ name: "Row", layout: { mode: "row", gap: 8 } }, [
    flcm.instance(icon, { componentPropertyReferences: { componentId: "Icon" } }),
    flcm.text("Label", { componentPropertyReferences: { text: "Label", visible: "Show Label" } }),
    flcm.frame({ width: 240, height: 80, componentPropertyReferences: { slot: "Content" } }),
  ]),
  {
    name: "Row",
    propertyDefinitions: {
      Icon: { type: "instance_swap" },
      Label: { type: "text" },
      "Show Label": { type: "boolean" },
      Content: { type: "slot" },
    },
  },
);
\`\`\`

- **Each type has one field, on the node type that owns it.** \`boolean\` → \`visible\` (any node); \`text\` → \`text\` (\`flcm.text\` only); \`instance_swap\` → \`componentId\` (\`flcm.instance\` only); \`slot\` → \`slot\` (\`flcm.frame\` only). A field on the wrong constructor fails at construction, before any verb runs.
- **Omit \`defaultValue\` and it is derived from the node that binds the property** — its \`visible\` (an unnamed \`visible\` is \`true\`), its text, its component. Deriving needs exactly one binder: a property nothing binds must state a \`defaultValue\`, and one two nodes bind has no single value to read.
- **A slot IS a frame you author.** Bind the frame that holds the placeholder content and the definition keeps that frame — its size, its layout, its children — while every instance shows it as a SLOT. A declared slot no frame binds is refused rather than dropping Figma's unpositioned 100×100 box into your component, and two frames on one slot are refused because a slot is one hole. **Putting content into an instance's slot is not authorable yet**: an instance's child list is closed to plugins, and \`overrides\` restyles a slot but cannot fill one. Until then, what every instance shows is the placeholder content you put in the bound frame.
- **\`variant\` is not a type here.** Axes are made by combining components into a set (\`flcm.variants\`), never declared on one.
- **A binding only means something inside \`flcm.component\`.** The same tree handed to \`render\`, \`append\` or \`edit\` is refused naming the word: there is no component in that call to declare the property it points at.`;

export const COMPONENTS_VARIANTS = `\`await flcm.variants(entries, options)\` folds standalone components into a COMPONENT_SET and returns the set's handle. Each entry says which member of the set its component **is**, in the set's axes — the axes an instance then picks with \`componentProperties\`.

\`\`\`js
const small = await flcm.component(flcm.frame({ width: 96, height: 32, fill: "#111", borderRadius: 6 }), { name: "Button" });
const large = await flcm.component(flcm.frame({ width: 128, height: 44, fill: "#111", borderRadius: 8 }), { name: "Button" });
const set = await flcm.variants(
  [
    { component: small.node, variant: { Size: "Small" } },
    { component: large.node, variant: { Size: "Large" } },
  ],
  { name: "Button" },
);
await flcm.render(flcm.instance(set, { componentProperties: { Size: "Large" } }));
\`\`\`

- **Every entry names the same axes**, order-free; the first entry's key order becomes the set's axis order. Axis names and values are non-empty and may not contain \`=\` or \`,\` (Figma's variant-name grammar), and no two entries may name the same combination.
- Each component is **renamed** to that grammar (\`Size=Large, State=Default\`) as it joins — the set carries the \`name\` you pass.
- **The set lands where the first component sat** — its parent, its index — so a set built from components inside a frame stays there.
- Each entry's component must be a standalone **local** COMPONENT. A FRAME or an INSTANCE fails loud pointing at \`flcm.component\`; a library component fails loud (this file only holds a reference to it); and a component **already in a set** fails loud naming that set — there is no add-to-an-existing-set form.`;

export const COMPONENTS_INTRO = `\`flcm.instance(component, props?)\` is a constructor like \`flcm.frame\`: it builds an inert INSTANCE spec you \`render\` on its own, nest in a frame's children, or place with \`append\`/\`insertBefore\`. The component is a target — a read's \`componentId\`, an flcm/key, \`flcm.id(id)\`, or a handle from \`find\` — naming a COMPONENT, or a COMPONENT_SET (then the variant \`componentProperties\` pick, the set's default otherwise). Library components already used in the file resolve by the same id \`get\` reports.

**Read words are write words.** What \`flcm.get\` reports on an instance is what \`flcm.instance\` takes, so a read spec authors as-is: \`flcm.instance({ ...spec, name: "Copy" })\` (the props form — \`componentId\` is read straight off the spec). Three groups of words:

- **A frame's props** — \`fill\`, \`width\`, \`layout\`, \`opacity\`, \`name\`… Each one you name becomes a **root-level override**; each one you omit keeps tracking the component. There are no creation defaults here: a plain \`flcm.instance(comp)\` is byte-for-byte the component, where a plain \`flcm.frame()\` gets a transparent fill and hug sizing.
- **\`componentProperties\`** — values by property name, as \`get\` reports them: a variant axis (\`Size: "Large"\`), a boolean, a text, or a component target for an instance-swap property. Bare names resolve to Figma's suffixed ones when unambiguous. A variant selection is checked as a whole combination against the variants the set actually has.
- **\`overrides\`** — how sublayers differ from the component, keyed by component-relative path exactly as \`get\` keys them, each value a delta in the edit vocabulary for that sublayer's type (\`{ "11:9": { text: "Save" }, "11:12": { fill: "#F00", visible: false } }\`). A read's \`null\` (the instance lacks a field) is accepted where flcm has a removal word (\`fill\`/\`stroke\`/\`effects\` → "none", \`opacity\` → 1, \`borderRadius\` → 0) and refused otherwise.

After render, a sublayer's live id is \`I<instanceId>;<path>\`, and \`flcm.edit\` on it is the same override — \`find({ within: handle })\` locates them.`;

export const COMPONENTS_EDIT = `### Changing an instance

There is no separate variant or swap verb: **an instance changes through \`flcm.edit\`, in the same words \`get\` reports on it.**

\`\`\`js
await flcm.edit(inst, { componentProperties: { Size: "Large", Label: "Save" } }); // variant + a text property
await flcm.edit(inst, { overrides: { "11:9": { fill: "#F00" } }, width: 240 });   // a sublayer, and a root word
await flcm.edit(inst, { componentId: other.id });                                 // swap the component
\`\`\`

- **A frame's words** (\`fill\`, \`width\`, \`layout\`, \`opacity\`, \`name\`…) apply to the instance's root as root-level overrides, exactly as on a frame — including the layout gates, which read the instance's live mode.
- **\`componentProperties\`** takes the same values as at create, resolved against the component this instance is on now. A variant axis you don't name keeps its current value, so \`{ State: "Hover" }\` on a \`Size=Large\` instance selects \`Size=Large, State=Hover\` — and a combination the set lacks fails loud listing the ones it has. The instance keeps its id; its sublayer ids become the new variant's.
- **\`overrides\`** are edits of the live sublayers \`I<instanceId>;<path>\`, so a text delta resolves against the font that sublayer really has. (\`flcm.edit("I12:3;4:5", …)\` on the sublayer directly is the same write.)
- **\`componentId\`** swaps the component — a COMPONENT, or a COMPONENT_SET (its default variant unless \`componentProperties\` in the same delta pick one). Figma carries across the overrides it can match; the rest fall back to the new component's own values.

**One delta, one order:** swap → properties → the root's own words → overrides. So a single call can swap a component, pick a variant of it, and override a sublayer of the *result* — the paths are resolved against the incoming component, and the sublayers re-acquired after the swap lands. Everything resolves before the first write; a bad path or property name leaves the instance untouched.`;

export const COMPONENTS_DETACH = `### Breaking the link — \`flcm.detach\`

\`await flcm.detach(target)\` turns an instance into ordinary layers: a FRAME with a **new id**, holding new-id copies of the subtree, returned as that frame's handle. It is one-way, and a **nested** instance fails loud naming the enclosing one: Figma's own detach on a nested instance also detaches *every* enclosing instance up the chain, so flcm makes you ask for that widening explicitly rather than perform it silently. Reach for it only when the design genuinely leaves the component behind; overriding is what keeps the design system's link alive.`;

export const COMPONENTS_RULES = `### Rules

- **Everything resolves against the live component before the first write.** An unknown property name, a wrong value type, a variant combination the set lacks, or an override path the component doesn't have each fails loud naming the component's own — its real property names, its real variants — with nothing created.
- **A property is a property, an override is an override.** \`componentProperties\` drive what the component bound to them (a label's text, a layer's visibility, a nested swap); \`overrides\` reach any sublayer field the edit vocabulary has. Setting a bound text through \`overrides\` works but leaves the property unset — prefer the property when one exists.
- **A slot property has no value** — its content is authored, not set; a slot in \`componentProperties\` is refused.
- **Paths are per variant.** Each variant has its own sublayer ids; an override keyed from a read of one variant does not apply to another, and says so.
- **An instance's child list stays closed** (see Tree shape): its content is the component's. Edit sublayers by id, or the main component.
- **An override delta reaches a sublayer's own fields, not a nested instance's component.** \`componentProperties\`/\`overrides\`/\`componentId\` inside an \`overrides\` entry are refused — edit that nested instance by its live id (\`I<instanceId>;<path>\`) once the outer call has landed.
- **The three component words are INSTANCE-only.** On a FRAME, a TEXT, or anything else they fail loud as words that node type doesn't take.`;
