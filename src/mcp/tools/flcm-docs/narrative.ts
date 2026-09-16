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

export const MENTAL_MODEL = `Nodes are plain JavaScript data. Each new node names its type: FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR, or INSTANCE. children is an ordinary array of node specs.

\`\`\`js
const template = { type: "FRAME", layout: { mode: "column", gap: 16 }, children: [
  { type: "TEXT", text: "Hello" }
] };
const first = await flcm.render(template);
const second = await flcm.render(template);
\`\`\`

Every placement verb compiles the tree, creates or moves each node, and returns a deep copy of the input with ids filled in. It never changes the input. The two calls above create two independent trees.

An id identifies a live node, at every depth. A spec with an id moves that node and edits its named props; one without an id creates a new node. A minimal move is \`await flcm.append(parent, { id })\`. Children omitted from a live node's spec stay in the document. Use remove for deletion.

\`const { node } = await flcm.get(target); await flcm.append(parent, node)\` moves the node you read. To create a data copy, remove the ids from every node you want copied, including slot content in overrides. Removing only the root id creates a new root and moves its id-bearing children. Annotations are authored and copied. \`clone\` is the faithful live copy, including state the authoring vocabulary cannot express.

Read-only fields with no authored equivalent fail by name. A root read back from get carries its real pixel size under designedWidth/designedHeight, and the verb uses those dimensions. Compressed style references, dash patterns and locked proportions are refused. Grid templates, gaps, placement, cell alignment and sibling stacking use the read vocabulary. VECTOR reads retain d or vectorPaths and can be authored directly. IMAGE-SVG is a wire projection; fetch a fresh runtime read to author its geometry. Errors identify the verb and a path such as spec.children[3].children[1].

### Session across calls

Agent code receives \`session\` alongside \`flcm\`. It is the same object throughout one plugin run, shared by approved callers. WebSocket reconnects and page switches keep it. Closing the plugin or switching files ends the run and clears it. Nothing is saved to clientStorage or the server.

Each call has a fresh scope. Top-level declarations and that call's flcm instance do not survive. Save specs, constants, SVG markup and looked-up ids in session. Ids point to live nodes; all other values are snapshots. Re-read with flcm.get when canvas changes matter.

\`\`\`js
// Call 1
const root = await flcm.render({ type: "FRAME" });
session.root = root.id;
const screen = { type: "FRAME", children: [
  { type: "TEXT", text: "First" }, { type: "TEXT", text: "Second" }
] };
session.screen = await flcm.append(root, screen);
return session.screen;
\`\`\`

\`\`\`js
// Call 2
session.screen.children.unshift(session.screen.children.pop());
session.screen = await flcm.append(session.root, session.screen);
return session.screen.children.map(n => n.id);
\`\`\`

Assignments copy plain objects and arrays from outside session, so mutate the stored value rather than the original. Session holds plain data only; functions, live Figma nodes and class instances are refused by name. Delete a property to drop its data.

After a successful call, session.last holds a detached snapshot of its full return value before wire projection, only when the return is plain data; otherwise last becomes undefined. Returning session itself is supported. A call with no return sets it to undefined. Failed calls do not automatically replace last; valid session writes before the error remain, just as earlier canvas writes can remain. Stored copies are agent-owned snapshots and return whole; survey their fields or compute a summary to keep output small.

### Full reads and wire markers

Inside a call, get returns the complete subtree, including hidden nodes, VECTOR geometry and inherited instance children. find predicates see that same full shape. Hidden nodes carry visible: false in full reads and slim handles. The children array keeps live sibling order. The readOnlySource record preserves decoded producer facts before CSS conversion: exact measurements, disabled paints/effects, paint stacks, resolved text runs, style identities, constraints, blend modes, clipping and component metadata. The ordinary fields remain the authoring vocabulary. Writing readOnlySource does not change the file; clone preserves live state the authoring vocabulary cannot express.

At the return and console boundary, unchanged read objects are projected wherever they occur. Computed objects, extracted fields and edited read objects pass through whole. Projection retains the REST cut rules, including IMAGE-SVG collapse, and adds markers such as:

\`\`\`json
{"id":"12:34","elided":{"children":4200}}
\`\`\`

A node's elided map names omitted content fields and their sizes in JSON characters. A size is null when a REST depth limit omitted the child list upstream, so its size is unknown. Fetch with flcm.get in a fresh call, then return the field or compute a summary. For example, \`return (await flcm.get("12:34")).node.children.map(n => ({ id: n.id, type: n.type, name: n.name }));\` inspects a collapsed range, and \`return (await flcm.get("12:35")).node.d;\` retrieves a path. Never rerun editing code to expand output.

A marker-only object such as { elided: { children: 4200 } } retyped into a spec's children array preserves the live children it represents. It is never a node to create or edit. elided and readOnlySource are read metadata. An INSTANCE child tree whose ids all belong to that instance is an inherited echo, including after copying or JSON round-tripping. Its fields are observational; edit sublayer paths through overrides, and place slot content through overrides[path].children. Foreign or id-less inherited children are refused as restructuring. When the root id is removed to create a new instance, echo ids must share one source instance. SLOT contents can have ordinary live ids; their edits still belong in overrides.

REST does not request geometry=paths, so its decoded readOnlySource cannot supply VECTOR path data. Use a live plugin read for paths. Variables, prototype interactions, vector networks, video paints, image filters, mask/boolean-operation settings and plugin data remain outside the adapter vocabulary; use raw figma access for them. Reading a node type does not imply that a verb can create it; clone preserves unsupported authoring state. The predicate admission limit remains 5,000 candidates; narrow within or the query for larger files. Unavailable library definitions can still fall back to an instance donor, identified by childrenFrom.`;

export const CHILDREN = `Use \`children: [{ type: "TEXT", text: "Hi" }]\` on a FRAME. Compose with array spread and filter conditional entries before calling a verb. Every entry must be a plain node object. Instances expose editable content through slot paths in overrides. The verb places the subtree root at its named position; inside each node, mentioned children go to the end in spec order, and unmentioned children keep their relative order. \`children: []\` on a live node is a no-op.`;

export const RICH_TEXT = `\`TEXT\` takes **either** a plain string **or** an array of **runs** — one text node, several styles.

**Markdown in a plain string** — \`**bold**\`, \`*italic*\`, \`~~strike~~\`, \`[text](url)\` — parses to styled spans:

\`\`\`js
const message = { type: "TEXT", text: "Ship it **today** — see the [runbook](https://ex.co/run) first." };
\`\`\`

Backslash-escape to render one literally: \`"save 20% \\\\*today\\\\*"\`. Only \`\\ * _ ~ [ ] ( ) { }\` are escapable, and this matches figma-mcp's read output, so text you read back round-trips. \`![alt](url)\` fails loud — use \`flcm.image(url)\`.

**Runs array** — a run is a bare string or a \`[text, style]\` tuple. The style is a **delta** over the node-level \`textStyle\` base, so each span carries only what it changes:

\`\`\`js
// a feed caption as ONE node: a colored @handle, plain body, a muted "more"
const caption = { type: "TEXT", text: [
  ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
  " summited at golden hour. ",
  ["more", { color: "#8E8E93" }],
], textStyle: { fontSize: 14 } };
\`\`\`

A run resolves its font exactly as the node does, and its delta may set any field in the table below. \`textAlign\`, \`textAlignVertical\` and \`lineClamp\` are whole-node only. A fixed \`width\` wraps the node into a flowing paragraph, so a styled paragraph is runs + a width.`;

export const PERCENT_SIZING = `\`width\`, \`height\`, \`left\` and \`top\` take a percent string — \`"50%"\` of the parent's size on that axis, resolved against its *realized* size once layout settles (so a percent child of a \`"fill"\` or percent-sized parent is fine).

\`\`\`js
const track = { type: "FRAME", width: 300, height: 8, borderRadius: 4, fill: "#E5E7EB", children: [
  { type: "RECTANGLE", width: "35%", height: 8, borderRadius: 4, fill: "#6366F1" }, // 35% of the track
] };
\`\`\`

In-flow GRID children reject percent sizes: the relevant base is the cell, whose settled geometry is not available through the authoring surface. Use fixed pixels or \`fill\`; absolute grid children resolve against the whole parent frame.

Another case **fails loud**: an in-flow percent-*sized* child of an auto-layout parent that *hugs* that axis — the parent sizes to the child while the child sizes to the parent. Give the parent a fixed or \`"fill"\` size, or lift the child out of the flow with \`left\`/\`top\`. A percent (or \`"fill"\`) on the **root** fails loud too: its parent is the page, which is unbounded.

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
const card = { type: "FRAME", width: 320, height: 200, children: [
  { type: "RECTANGLE", width: 28, height: 28, left: 284, top: 12, pin: { x: "right", y: "top" } },
] };

// a knob centred on the 40% mark
const knob = { type: "ELLIPSE", width: 16, height: 16, left: "40%", top: "50%", anchor: { x: "center", y: "center" } };
\`\`\`

\`pin\` is ignored on an in-flow auto-layout child, which reflows through \`fill\`/\`hug\` instead. A bad \`pin\` or \`anchor\` value fails loud.

**Cross-axis \`"fill"\` under a parent that hugs that axis is legal** — only a *percent* fails loud there. It isn't the same cycle: the hug still measures the children's own sizes, and the filling child then matches the result. So a \`width:"fill"\` child of a hugging column comes out as wide as its widest sibling, and one that has no sibling to measure just keeps the size it already had. Give the parent a fixed or \`"fill"\` width when you want the child to stretch to something.

**\`wrap: true\` and a \`"fill"\`-width child pull against each other.** Nothing refuses the pair, but wrap breaks the row when the children run out of width while \`"fill"\` claims whatever width is left on the line — so the filling child closes the line it is on and everything after it wraps. Size wrapped children in pixels or let them hug; keep \`"fill"\` for a row that doesn't wrap.

Sizing bounds use \`minWidth\`, \`maxWidth\`, \`minHeight\`, and \`maxHeight\` in positive pixels. Bounds govern auto-layout containers and their direct children. Reads retain these bounds, including instance-only bounds. Omitted bounds remain unchanged; \`"none"\` clears one. A valid resize constrained by a bound succeeds and reports its requested size, bound and resulting size in the execution console. Contradictory bounds reject before writes.

After resizing, the console reports affected containers with overflowing children in one compact warning, grouped by clipped and unclipped IDs. This includes existing overflow and nested layouts after the batch settles. The write still succeeds.

New text with omitted width fills a column whose available width is independently bounded, and omitted height grows with wrapped content. A hugging column or horizontal row keeps content-driven text width. Explicit sizes and omitted edit fields retain their existing meaning.

Budget fixed widths together with padding and gaps; use \`"fill"\` for the remaining space. Fixed heights can overflow when text wraps or children grow. Use \`"hug"\` where the container should grow with content. Existing \`pin\` constraints control children of free-form containers and absolute children; in-flow auto-layout children use fill/hug. Inspect screenshots for visual quality beyond geometric overflow.`;

export const VECTOR_INTRO = `Use \`type: "VECTOR"\` with exactly one geometry prop:

\`\`\`js
await flcm.render({ type: "VECTOR", d: "M0 0 L24 24", stroke: "#111", strokeWidth: 2 });
await flcm.render({ type: "VECTOR", svg: '<svg width="24" height="24"><circle cx="12" cy="12" r="10" fill="red"/></svg>' });
\`\`\`

\`d\` is a themeable SVG path. \`vectorPaths\` preserves multiple native paths and their NONZERO, EVENODD or NONE winding rules. Use exactly one of d, vectorPaths or svg. \`svg\` imports markup whose colors are baked in; it accepts shared and size props. There is no icon catalog. Supply the artwork. An id-bearing VECTOR accepts d or vectorPaths as a geometry edit and preserves its live identity. svg imports can change node types and child identities, so live svg replacement is refused by name. Move imported artwork with { id }, or omit its id to import a new copy.`;

export const PAINT_INTRO = `A paint value (for \`fill\`, \`stroke\`, or a run's \`color\`) is one of:

- a **solid color string** — \`"#FF0000"\`, \`"#FF0000AA"\`, \`"rgba(255,0,0,0.5)"\`;
- a **gradient string** — \`"linear-gradient(…)"\` / \`"radial-gradient(…)"\`;
- \`flcm.gradient(...)\`, which builds the same value without the string; or
- \`flcm.image(src)\` — a raster fill from a url or local path (see **Images**).

\`\`\`js
const background = { type: "FRAME", fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" };
const sameBackground = { type: "FRAME", fill: flcm.gradient({ stops: ["#0B1020", "#131A2E"], angle: 180 }) };
flcm.gradient("linear" | "radial", stops, angle);   // the positional form
\`\`\``;

export const IMAGE_INTRO = `Place a **real raster image** — feed media, an avatar, a thumbnail — instead of faking it with a gradient (which carries no signal it was ever meant to be an image).

\`flcm.image(src, opts?)\` is a **paint value**, like \`flcm.gradient\`. An image in Figma is a fill, so any shape carries one: a RECTANGLE for a photo, an ELLIPSE for a circular avatar, a FRAME for a hero. \`src\` is an https url or a local file path, like CSS \`url()\`.

\`\`\`js
const avatar = { type: "ELLIPSE", width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") };
const logo = { type: "RECTANGLE", width: 120, height: 40, fill: flcm.image("public/logo.png", { scaleMode: "FIT" }) };
\`\`\`

- **The server loads the bytes** — your code never touches the network or the filesystem. Any public http(s) url works.
- **Local paths are confined to the server's asset root** (\`--asset-root\`, default: the directory the server started in). A path outside it is refused, naming the root.
- An **unfetchable, blocked, out-of-root, oversize, or non-image source fails loud** — never a silent blank fill.`;

export const EFFECTS_INTRO = `Write effects as the CSS you'd already write — a bag of \`{ boxShadow?, textShadow?, filter?, backdropFilter? }\`. \`flcm.effects({...})\` is the second form, and the only way to reach the Figma-native effects CSS has no word for (\`glass\`, \`noise\`, \`texture\`, \`progressiveBlur\`).

\`\`\`js
const frosted = { type: "FRAME", effects: { boxShadow: "0 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(16px)" } };
const glass = { type: "FRAME", effects: flcm.effects({ shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" }, glass: { refraction: 0.4 } }) };
\`\`\`

Blur values are written in **CSS px** — you always write the CSS number and we map it to Figma's scale for you.

**\`glass\` needs a high-frequency backdrop to read as glass.** \`refraction\` and \`dispersion\` bend what is *behind* the pane, so over a flat fill or a smooth gradient there is nothing to bend and the result looks like a plain frosted tint — that's the physics of the scene, not a broken effect. Put busy content behind it (an image, dense text, an icon grid, a sharp-edged shape) and the refraction becomes visible.`;

export const RENDER_KEYS = `\`await flcm.render(spec)\` places the spec on the current page. Set left/top on the root for canvas position. Its return is the input tree copied with ids, including every child and each node in instance slot content. Use those ids directly with get, edit, append and the other target-taking verbs.

\`key\` is optional persistent metadata used by find and findOne. It does not decide identity. Duplicate keys within one authored tree are refused. Returned dimensions remain the authored values; use measure for realized pixels and get for current read data.`;

export const VERIFY_READBACK = `You cannot judge what you built from the code you wrote — hairlines, grain, glass, 1px strokes and missing glyphs all *look* fine in source. **Build → screenshot → look → fix.**

\`get_screenshot\` is a separate **MCP tool**, not an \`flcm\` verb (there is no \`flcm.screenshot\`). Keep the render result in \`session\` for later code calls; pass its id string to the screenshot tool.

\`\`\`js
// call 1 — figma_execute_code
const out = await flcm.render(card);
return out;
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
| An \`flcm.image\` source that is unfetchable, blocked (private/loopback), outside the server's asset root, oversize, or not an image | Rejected server-side with the reason, never a blank fill. |
| An \`TEXT\` value that is neither a string nor a runs array, or text carrying read style-ref tokens (\`{ts1}…{/ts1}\`) | Those are read artifacts. Author styled text as markdown or runs. \`**\` in a plain string is markdown — backslash-escape for a literal. |
| \`![alt](url)\` in a text string, or an unrealizable \`fontStyle\`/\`textDecoration\` (\`"oblique"\`, \`"overline"\`) | Text can't embed an image (\`flcm.image\`); the enum names the supported set. |
| A duplicate \`key\` in one render | Keys are unique per render. |
| A node \`type\` outside FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR | Those are the only createable types. |
| \`fill\`/\`stroke\` on \`VECTOR\` | Colors are baked into the markup — edit it, or use \`VECTOR\` for a themeable vector. |
| Unparseable SVG markup, or bad path \`d\` data | Never a silent blank node. |
| Returning a live Figma node | Return the id string or a handle. |
| A bad \`pin\` or \`anchor\` value, or \`anchor\` on an axis without its \`left\`/\`top\` | Names the value and the allowed set. |
| A percent \`width\`/\`height\` on an in-flow child of a parent that hugs that axis, or a percent/\`"fill"\` on the root | A genuine cycle (and the page is unbounded). Give the parent a fixed or \`"fill"\` size, or lift the child out of the flow with \`left\`/\`top\`. |
| An unknown \`mixBlendMode\` | Names the value and the supported set. |
| \`layout.justifyContent\`/\`alignItems\` Figma can't realize — \`"space-around"\`, \`"space-evenly"\` | Use \`"space-between"\` or \`gap\`/\`padding\`. Never faked with spacer nodes, which read as content. |
| \`textStyle.lineClamp\` on a width-hugging text | Truncation needs a width to wrap against. Set \`width\` to a number, \`"fill"\`, or \`"N%"\`. |
| A layout word the node can't realize — a fixed/\`"hug"\`/percent \`height\` on TEXT, \`"hug"\` with nothing to measure, or container words without \`layout.mode\` | The same rules govern create and edit alike, so a word that wouldn't land names the fix instead. |

An \`imageRef\` identifies an existing image in this file and can be reused, for example \`{ type: "RECTANGLE", fill: { type: "IMAGE", imageRef } }\`.

Variables and prototype interactions are deliberately **out of v1** — read concepts with no create path. They're rejected loudly so you never half-write something unrealizable. (Components have one: \`INSTANCE\` — see the components section.)

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
- **A COMPONENT or COMPONENT_SET target takes a frame's words plus \`description\` and \`propertyDefinitions\`** — editing the main is how every instance of it changes. A layer inside one also takes \`componentPropertyReferences\`, which binds it to a property. See the components section.
- **\`key\` is immutable** — re-keying could mint a duplicate address. Set \`name\` to change the layers panel.
- **No bare \`x\`/\`y\`** — position is \`left\`/\`top\` (naming either lifts a child out of an auto-layout flow; \`position: "absolute"\` lifts it in place, \`position: "none"\` returns it), resize behavior is \`pin\`.
- **An empty delta is rejected**, since it would still mint an undo step.
- **Each edit is one undo step.** The whole delta validates before the first write; a Figma refusal mid-apply rolls the node back, and the error carries the target's identity, Figma's reason, and how many earlier mutating calls still stand.
- Delta values are **absolute**, never relative (\`+10\`), so re-running an edit converges instead of compounding.`;

export const EDIT_MANY = `### Many at once — \`flcm.editMany\`

\`await flcm.editMany([{ id, ...changes }, …])\` applies a whole set of deltas as **one** call, returning a handle per entry in order. Each entry is the plain-data node shape used everywhere else — a live node \`id\` plus exactly an \`flcm.edit\` delta. A key or a handle is not an id, so locate the nodes first and pass what you got back:

\`\`\`js
const cards = await flcm.find({ type: "FRAME", name: "Card" });
await flcm.editMany(cards.map((card) => ({ id: card.id, fill: "#F6F7F9", borderRadius: 12 })));
\`\`\`

Reach for it whenever you're nudging more than one node — a loop over \`flcm.edit\` is not the same thing:

- **The set is atomic.** Every id resolves and every delta validates before the first write; a loop would already have mutated entries 1–3 when entry 4's typo surfaced.
- **One rejection names every bad entry**, indexed, so you fix the batch in one pass; entries that failed the same way report together as one counted line.
- **The whole batch is one undo step.**
- **Order doesn't matter** — entries settle ancestors-first, so turning a parent into a row and setting its child to \`width: "fill"\` works either way round.
- **Two entries for the same node reject** rather than last-wins; put both fields in one entry.

Props only: tree shape stays with \`append\`/\`move\`/\`remove\`/\`clone\`.`;

export const STRUCTURE_INTRO = `All placement verbs take a plain spec. append and prepend take a parent; insertBefore and insertAfter take a sibling. render uses the current page. Each returns a deep copy of the spec with every node id filled in.

\`\`\`js
const panel = await flcm.render({ type: "FRAME", width: 320, height: 200 });
const label = await flcm.append(panel, { type: "TEXT", text: "Hello" });
await flcm.prepend(panel, { id: label.id, text: "Moved and edited" });
\`\`\`

No id creates. An id moves and edits that live node. This applies recursively, including new children inside moved nodes and live children inside new nodes.`;

export const STRUCTURE_RULES = `Placement is one undo step. Malformed input and unresolved resources fail before writing; a Figma write failure rolls the call back. A node cannot move into itself or a descendant. Figma instance sublayers cannot be moved; slot content remains open.

Unmentioned children are retained. remove explicitly deletes a node and its subtree. replace places a spec at a target's position and removes the original after placement succeeds. A new replacement inherits omitted placement and size; explicit props win. Replacing a node with its own id edits it without deleting it.

clone duplicates the live subtree faithfully and clears its keys. It returns { node, to? }; the default destination is the source parent. Optional root props apply before returning the copy.

get returns { node, components? }. Use its node as a spec. readOnlySource preserves decoded state beyond the authoring vocabulary; clone preserves live state a spec cannot author.`;

export const COMPONENTS_CREATE = `\`await flcm.component(specOrTarget, options?)\` promotes a FRAME to a COMPONENT. A new spec is placed on the current page; a live root stays where it is and receives the named edits and children before promotion. The return is the spec copied with ids, with type COMPONENT and the new component id at the root. Figma preserves child identity during promotion. Save the returned component in session; the replaced FRAME root id no longer resolves.

Options are name, description and propertyDefinitions. Child componentPropertyReferences bind authored fields to those definitions.`;

export const COMPONENTS_PROPERTIES = `A primary nested instance inside a component definition accepts \`exposed: true\` to show its existing controls in the enclosing instance panel; \`false\` clears exposure. This works in component construction and edits to the definition's nested instance.

\`propertyDefinitions\` declares what the component exposes; each node inside names the property that drives one of its fields with \`componentPropertyReferences\` (\`null\` is the edit-side unbind word, not a create word). Both are checked against each other before any write.

\`\`\`js
await flcm.component(
  { type: "FRAME", name: "Row", children: [
    { type: "INSTANCE", componentId: icon, componentPropertyReferences: { componentId: "Icon" } },
    { type: "TEXT", text: "Label", componentPropertyReferences: { text: "Label", visible: "Show Label" } },
    { type: "FRAME", width: 240, height: 80, componentPropertyReferences: { slot: "Content" } },
  ] },
  {
    propertyDefinitions: {
      Icon: { type: "instance_swap" },
      Label: { type: "text" },
      "Show Label": { type: "boolean" },
      Content: { type: "slot" },
    },
  },
);
\`\`\`

- **One field per type, on the node that owns it:** \`boolean\` → \`visible\` (any node), \`text\` → \`text\` (\`TEXT\`), \`instance_swap\` → \`componentId\` (\`INSTANCE\`), \`slot\` → \`slot\` (\`FRAME\`). A field on the wrong node type fails at the verb; an undeclared name fails loud listing the declared ones, a mismatched type fails loud.
- **Omit \`defaultValue\` to derive it from the binding node**: its \`visible\` (unnamed is \`true\`), its text, its component. That needs exactly one binder: a property nothing binds must state one; two binders leave no single value.
- **A slot IS a frame you author.** The bound frame stays in the definition, placeholder children and all, and every instance shows it as a SLOT holding that content until it fills it (below). A slot no frame binds is refused (rather than Figma's unpositioned 100×100 box); two frames on one slot are refused: a slot is one hole.
- **\`variant\` is not a type.** Axes come from folding components into a set (\`flcm.variants\`).
- **A binding means something only with a component behind it**: this call, or an insert into / an edit of a layer inside a live component (below). Under \`render\`, or an insert or edit anywhere else, it is refused naming the word.`;

export const COMPONENTS_VARIANTS = `\`await flcm.variants(entries, { name, description? })\` folds standalone components into a COMPONENT_SET and returns its handle. Each entry says which member of the set its component **is**; an instance picks a member by those axes in \`componentProperties\`.

\`\`\`js
const small = await flcm.component({ type: "FRAME", width: 96, height: 32 }, { name: "Button" });
const large = await flcm.component({ type: "FRAME", width: 128, height: 44 }, { name: "Button" });
const set = await flcm.variants(
  [
    { component: small, variant: { Size: "Small" } },
    { component: large, variant: { Size: "Large" } },
  ],
  { name: "Button" },
);
\`\`\`

- Every entry names the same axes, order-free; the first entry's key order is the set's. Names and values are non-empty with no \`=\` or \`,\` (Figma's variant-name grammar); no two entries may name the same combination.
- Each component is renamed to that grammar (\`Size=Large, State=Default\`) as it joins. \`name\` is required, or Figma names the set after the first member's axes. The set lands where the first component sat: its parent, its index.
- An entry must be a standalone local COMPONENT: a FRAME or INSTANCE fails loud pointing at \`flcm.component\`, a library component fails loud, and a component already in a set fails loud naming it (there is no add-to-a-set form).`;

export const COMPONENTS_EDIT_MAIN = `**A main component is edited with \`flcm.edit\` and the structural verbs, as a frame is**, and every instance follows: its root takes a frame's whole vocabulary (so does a COMPONENT_SET, whose layout arranges its variants), and its sublayers are ordinary nodes to edit by id, \`append\` to, or \`remove\`. Two words exist only here, \`description\` and \`propertyDefinitions\`, the latter keyed by each property's current name (bare, or with its \`#suffix\`):

\`\`\`js
await flcm.edit(comp, {
  propertyDefinitions: {
    Size: { type: "text", defaultValue: "M" },   // a new name  → ADDS
    Label: { defaultValue: "Save" },             // a known one → re-defaults
    Icon: { name: "Leading" },                   //             → renames
    Legacy: null,                                //             → deletes
  },
});
\`\`\`

- **Adding requires \`defaultValue\`**: an edit binds nothing in the same call, so nothing can derive it. Bind a layer next (below).
- **A new \`slot\` can't be declared here**: insert a bound frame instead (below).
- **Re-defaulting** reaches every instance still on the old default; one that stated its own value keeps it. **Renaming** re-suffixes the property and re-points every bound layer. **Deleting** frees the layers it drove.
- **A type can't change** (Figma has no such call): delete and re-declare.
- **A variant axis is not a definition.** A set's axes ARE its members' names, so rename the member components; a \`propertyDefinitions\` edit aimed at a variant is refused pointing at the set.

### Binding a layer — \`componentPropertyReferences\` under edit

The compiler's word on a live sublayer of a component; \`null\` unbinds a field, which keeps its value.

\`\`\`js
await flcm.edit(comp, { propertyDefinitions: { Heading: { type: "text", defaultValue: "Untitled" } } });
await flcm.edit(titleId, { componentPropertyReferences: { text: "Heading" } });   // the property drives it now
await flcm.edit(titleId, { componentPropertyReferences: { visible: null } });     // unbind
\`\`\`

- The node must be inside a COMPONENT or a set's variant: inside an INSTANCE it is refused naming the instance, and outside any component there is no property to point at.
- Field legality is the compiler's, read off the live node's type. Bare names resolve to Figma's suffixed ones when unambiguous.
- **Unbinding the only frame of a slot property is refused**: delete the property (\`{ Name: null }\`), which frees the frame. In a SET the count is per VARIANT; a sibling variant's frame is no spare.
- An \`editMany\` batch can't mix a definition edit with an entry that depends on it (binding to a name it renames, or setting that property on an INSTANCE): refused naming both, so use two calls.

### Inserting a bound layer

\`append\`/\`prepend\`/\`insertBefore\`/\`insertAfter\` into a component or its sublayers accept a plain node spec carrying \`componentPropertyReferences\`.

\`\`\`js
await flcm.append(comp, { type: "TEXT", text: "Sub", componentPropertyReferences: { text: "Label" } });
await flcm.append(comp, { type: "FRAME", width: 240, height: 80, componentPropertyReferences: { slot: "Content" } });
\`\`\`

Every name must already be declared, except a \`slot\` naming a property that doesn't exist, which **declares it**; naming one that already has its frame is refused. Into a set's VARIANT, a new \`slot\` declares the property on the SET and this variant realizes it; the others insert their own bound frame. An insert into the COMPONENT_SET itself is refused: its children are its variants.`;

export const COMPONENTS_INTRO = `Create an instance with \`{ type: "INSTANCE", componentId: componentTarget }\`. A COMPONENT_SET target selects its variant using componentProperties, or uses its default. A library component already used in the file can be addressed by its read componentId.

componentProperties maps property names to values. overrides maps component-relative sublayer paths to edit deltas. An omitted prop follows its component. Root appearance and layout props are overrides too.

Slot content is plain specs in \`overrides[path].children\`. Each id moves and edits, each missing id creates, and unmentioned content remains. Use remove on content nodes for deletion. Bindings in slot content need a declaring component and are refused otherwise.`;

export const COMPONENTS_EDIT = `### Changing an instance

No separate variant or swap verb: **an instance changes through \`flcm.edit\`, in the words \`get\` reports on it.**

\`\`\`js
await flcm.edit(inst, { componentProperties: { Size: "Large", Label: "Save" } }); // variant + a text property
await flcm.edit(inst, { overrides: { "11:9": { fill: "#F00" } }, width: 240 });   // a sublayer, and a root word
await flcm.edit(inst, { componentId: other.id });                                 // swap the component
\`\`\`

- **A frame's words** are root-level overrides, including the layout gates, which read the live mode.
- **\`componentProperties\`** resolve against the component the instance is on now. An unnamed axis keeps its value: \`{ State: "Hover" }\` on \`Size=Large\` selects \`Size=Large, State=Hover\`. The instance keeps its id; its sublayer ids become the new variant's.
- **\`overrides\`** edit the live sublayers \`I<instanceId>;<path>\` (\`find({ within: inst })\` locates them; \`flcm.edit\` on one is the same write), so a text delta resolves against the font that sublayer really has.
- **\`componentId\`** swaps to a COMPONENT, or a COMPONENT_SET (its default variant unless \`componentProperties\` in the same delta pick one). Figma carries across the overrides it can match; the rest fall back to the new component's values.

An instance root inherits its layout direction from its component. An edit may restate the matching \`layout.mode\`; a different direction is rejected before any writes. With a swap or variant change, the direction must match the incoming component. Edit the component or choose a matching variant to change direction.

Numeric \`width\` and \`height\` edits on inherited rectangles are rejected before any writes, including overrides used to create or retarget an instance. Change the component or choose a suitable variant. Use \`width: "fill"\` or \`height: "fill"\` when the auto-layout parent should size the rectangle. The instance root can still be resized.

**One delta, one order:** swap → properties → root words → overrides; override paths resolve against the incoming component.`;

export const COMPONENTS_DETACH = `### Breaking the link — \`flcm.detach\`

\`await flcm.detach(target)\` turns an instance into a FRAME with a **new id** holding new-id copies of the subtree, and returns its handle. One-way. A **nested** instance fails loud naming the enclosing one: Figma's detach would take every enclosing instance with it, so flcm makes you say so. Prefer overriding.`;

// The section's one refusal catalogue: the cross-cutting resolution checks. Every other refusal
// sits beside the rule it enforces, so nothing is listed twice.
export const COMPONENTS_RULES = `### Refused before the first write

On an instance, each of these resolves against the live component before the first write, so nothing is created or changed and the refusal names the component's real property names, variants and paths:

- an unknown property name, a wrong-typed value, or a variant combination the set lacks (selections are checked whole; the refusal lists those it has);
- a slot property in \`componentProperties\` (its content goes under \`overrides\`; the refusal names the path);
- an override path the resolved variant lacks (paths are per variant — a read of a sibling's doesn't apply), \`children\` at a non-slot path (listing the paths that are slots), a \`null\` where flcm has no removal word, or \`componentProperties\`/\`overrides\`/\`componentId\` inside an override entry.`;

export const ANNOTATIONS_REFERENCE = `Figma's native annotations — the note a designer pins to a layer from the right panel — are how a human points you at a nested layer, and how you leave intent on what you build. A frame, shape, text, instance or slot can carry them; a GROUP or SECTION cannot, so annotate a frame, not a group. Hidden layers and their annotations are included in \`find\` and \`get\`.

**The rule:** an instruction to change the design is done when the change is made, so remove it once you've verified the result; a note about how the design works stays. Finding an annotation doesn't authorise acting on it — the user's request does. The category \`Agent\` marks the exchange between the human and you, in both directions; most human notes carry no category, and that's fine.

\`text\` is Figma-flavoured markdown. \`category\` is the category's name — created in the file on first use, so spell an existing one exactly; a verb that fails removes the category it created. \`properties\` is Figma's list of pinned design properties (\`["width", "fills"]\`); it rides along on read and write so a note you preserve keeps its pins. Leave intent as you build: \`{ type: "FRAME", annotations: [{ text: "Tapping opens the filter sheet", category: "Agent" }], children: [...] }\`. The array **replaces** the node's whole collection: omit it to leave annotations alone, \`[]\` clears every one, a supplied array becomes the collection.

Start from \`flcm.selection()\`: check the selected root's own \`annotations\`, then \`find({ hasAnnotations: true, within: root })\` for its descendants — \`within\` searches descendants only. \`hasAnnotations\` tests the live collection, and the slim handles come back carrying their \`annotations\`. To remove one, re-read the node **immediately before writing** and find your entry in that fresh collection by \`text\` — annotations have no id, so an index from the earlier read may not be the same note:

\`\`\`js
const [hit] = await flcm.find({ hasAnnotations: true, within: root });
const task = hit.annotations[0].text;
// … make the change the note asks for, verify the result, then:
const fresh = (await flcm.get(hit)).node.annotations ?? [];
const done = fresh.find((a) => a.text === task);
if (done) {
  await flcm.edit(hit, { annotations: fresh.filter((a) => a !== done) });
} // not there any more: leave the node alone and say so in chat
\`\`\`

Data copies and clone preserve annotations. Remove unwanted notes explicitly.`;
