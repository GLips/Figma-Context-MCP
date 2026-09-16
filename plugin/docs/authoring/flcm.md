> **Generated — do not edit.** Regenerate with `pnpm docs:gen`.
> Source: `plugin/src/preamble/schema.ts` (verbs/props) + `src/mcp/tools/flcm-docs/{narrative,examples}`.

# Authoring with `flcm`

## The mental model

Nodes are plain JavaScript data. Each new node names its type: FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR, or INSTANCE. children is an ordinary array of node specs.

```js
const template = { type: "FRAME", layout: { mode: "column", gap: 16 }, children: [
  { type: "TEXT", text: "Hello" }
] };
const first = await flcm.render(template);
const second = await flcm.render(template);
```

Every placement verb compiles the tree, creates or moves each node, and returns a deep copy of the input with ids filled in. It never changes the input. The two calls above create two independent trees.

An id identifies a live node, at every depth. A spec with an id moves that node and edits its named props; one without an id creates a new node. A minimal move is `await flcm.append(parent, { id })`. Children omitted from a live node's spec stay in the document. Use remove for deletion.

`const { node } = await flcm.get(target); await flcm.append(parent, node)` moves the node you read. To create a data copy, remove the ids from every node you want copied, including slot content in overrides. Removing only the root id creates a new root and moves its id-bearing children. Annotations are authored and copied. `clone` is the faithful live copy, including state the authoring vocabulary cannot express.

Read-only fields with no authored equivalent fail by name. A root read back from get carries its real pixel size under designedWidth/designedHeight, and the verb uses those dimensions. Compressed style references, dash patterns and locked proportions are refused. Grid templates, gaps, placement, cell alignment and sibling stacking use the read vocabulary. VECTOR reads retain d or vectorPaths and can be authored directly. IMAGE-SVG is a wire projection; fetch a fresh runtime read to author its geometry. Errors identify the verb and a path such as spec.children[3].children[1].

### Session across calls

Agent code receives `session` alongside `flcm`. It is the same object throughout one plugin run, shared by approved callers. WebSocket reconnects and page switches keep it. Closing the plugin or switching files ends the run and clears it. Nothing is saved to clientStorage or the server.

Each call has a fresh scope. Top-level declarations and that call's flcm instance do not survive. Save specs, constants, SVG markup and looked-up ids in session. Ids point to live nodes; all other values are snapshots. Re-read with flcm.get when canvas changes matter.

```js
// Call 1
const root = await flcm.render({ type: "FRAME" });
session.root = root.id;
const screen = { type: "FRAME", children: [
  { type: "TEXT", text: "First" }, { type: "TEXT", text: "Second" }
] };
session.screen = await flcm.append(root, screen);
return session.screen;
```

```js
// Call 2
session.screen.children.unshift(session.screen.children.pop());
session.screen = await flcm.append(session.root, session.screen);
return session.screen.children.map(n => n.id);
```

Assignments copy plain objects and arrays from outside session, so mutate the stored value rather than the original. Session holds plain data only; functions, live Figma nodes and class instances are refused by name. Delete a property to drop its data.

After a successful call, session.last holds a detached snapshot of its full return value before wire projection, only when the return is plain data; otherwise last becomes undefined. Returning session itself is supported. A call with no return sets it to undefined. Failed calls do not automatically replace last; valid session writes before the error remain, just as earlier canvas writes can remain. Stored copies are agent-owned snapshots and return whole; survey their fields or compute a summary to keep output small.

### Warnings on returned nodes

Warnings are records shaped as { id, message, prop?, authored?, realized? }. A plain warning has a message; a divergence also names the property, the value asked for and the value that landed. Returned specs, handles, get/find reads and measure results carry a warnings array when that node has warnings in this run. For example, a path authored with width: 24 can carry { id: "12:34", prop: "width", authored: 24, realized: 6, message: "..." } beside its echoed width. Inspect warnings before trusting authored dimensions.

The same records produce the reply's [warn] summary lines for nodes you did not return or log. Logging r.children[0] shows that child's warnings and suppresses their duplicate summary. Returning nothing keeps every warning in the summary. A later warning still appears even if you logged the node earlier. Overflow and writes that finish after your code returns belong only to the run summary. Your own console.log and console.warn still work.

Warnings are read metadata. Placement specs and edit deltas strip warnings on input; pasting a returned spec does not author diagnostics. They describe this run, not persistent document state.

### Full reads and wire markers

Inside a call, get returns the complete subtree, including hidden nodes, VECTOR geometry and inherited instance children. find predicates see that same full shape. Hidden nodes carry visible: false in full reads and slim handles. The children array keeps live sibling order. The readOnlySource record preserves decoded producer facts before CSS conversion: exact measurements, disabled paints/effects, paint stacks, resolved text runs, style identities, constraints, blend modes, clipping and component metadata. The ordinary fields remain the authoring vocabulary. Writing readOnlySource does not change the file; clone preserves live state the authoring vocabulary cannot express.

At the return and console boundary, unchanged read objects are projected wherever they occur. Computed objects, extracted fields and edited read objects pass through whole. Projection retains the REST cut rules, including IMAGE-SVG collapse, and adds markers such as:

```json
{"id":"12:34","elided":{"children":4200}}
```

A node's elided map names omitted content fields and their sizes in JSON characters. A size is null when a REST depth limit omitted the child list upstream, so its size is unknown. Fetch with flcm.get in a fresh call, then return the field or compute a summary. For example, `return (await flcm.get("12:34")).node.children.map(n => ({ id: n.id, type: n.type, name: n.name }));` inspects a collapsed range, and `return (await flcm.get("12:35")).node.d;` retrieves a path. Never rerun editing code to expand output.

A marker-only object such as { elided: { children: 4200 } } retyped into a spec's children array preserves the live children it represents. It is never a node to create or edit. elided and readOnlySource are read metadata. An INSTANCE child tree whose ids all belong to that instance is an inherited echo, including after copying or JSON round-tripping. Its fields are observational; edit sublayer paths through overrides, and place slot content through overrides[path].children. Foreign or id-less inherited children are refused as restructuring. When the root id is removed to create a new instance, echo ids must share one source instance. SLOT contents can have ordinary live ids; their edits still belong in overrides.

REST does not request geometry=paths, so its decoded readOnlySource cannot supply VECTOR path data. Use a live plugin read for paths. Variables, prototype interactions, vector networks, video paints, image filters, mask/boolean-operation settings and plugin data remain outside the adapter vocabulary; use raw figma access for them. Reading a node type does not imply that a verb can create it; clone preserves unsupported authoring state. The predicate admission limit remains 5,000 candidates; narrow within or the query for larger files. Unavailable library definitions can still fall back to an instance donor, identified by childrenFrom.

### Rules that hold everywhere

- Return ids and handles, never live Figma nodes.
- Every metric (`width`, `height`, `gap`, `padding`, `borderRadius`, `strokeWidth`, `left`/`top`) takes a number or `"Npx"`; `width`/`height`/`left`/`top` also take `"N%"`, and `width`/`height` take `"fill"`/`"hug"`. Colors, gradients and shadows are CSS strings.
- Out-of-subset CSS fails loud.

## The verbs

`flcm` exposes exactly these. Nothing else is on the `flcm` object.

| Verb | Builds | Arguments |
| --- | --- | --- |
| `await flcm.render(spec)` | the spec copied with ids on every node | Place on the current page. An id moves and edits that live node; no id creates. Children follow the same rule. With an id and children, it adds several children to that live node in one call. |
| `await flcm.append(parent, spec)` | the spec copied with ids on every node | Place as the last child. Unmentioned live children remain. |
| `await flcm.prepend(parent, spec)` | the spec copied with ids on every node | Place as the first child. |
| `await flcm.insertBefore(sibling, spec)` | the spec copied with ids on every node | Place immediately before the sibling. |
| `await flcm.insertAfter(sibling, spec)` | the spec copied with ids on every node | Place immediately after the sibling. |
| `await flcm.replace(target, spec)` | the spec copied with ids on every node | Place in the target position, then remove the target. New roots inherit omitted placement and size; explicit props win. |
| `await flcm.remove(target)` | { removedId, from? } | Delete the node and subtree. from is the former parent handle, absent for pages. |
| `await flcm.clone(target, props?, parent?)` | { node, to? } | Faithful live copy, with optional root edits and destination. Keys are cleared. Default destination is the original parent. |
| `await flcm.component(specOrTarget, options?)` | the spec copied with ids and root type COMPONENT | Promote a FRAME to a COMPONENT. A live root stays in place; a new root lands on the current page. The returned root id is the component id. options declares name, description and propertyDefinitions. |
| `await flcm.variants(entries, options)` | a COMPONENT_SET handle | Each entry is { component: target, variant: { axis: value } }. options names the set. |
| `await flcm.detach(target)` | a FRAME handle | Detach an instance. Root and descendant ids change. |
| `await flcm.edit(target, changes)` | an updated handle | Apply only the named props. Structure changes use placement verbs. |
| `await flcm.editMany(entries)` | updated handles in entry order | One atomic batch. Each entry is { id, ...changes } — a live node id plus the same props edit takes. |
| `await flcm.get(target)` | { node, components? } | Expanded read data. Pass node directly to a placement verb to move and edit it. components contains shared definitions. |
| `await flcm.find(query?, predicate?)` | slim handles[] | Query fields: type, name, key, within, hasAnnotations. Optional predicate sees expanded read data. |
| `await flcm.findOne(query?, predicate?)` | one slim handle | Like find; throws unless exactly one matches. |
| `await flcm.selection()` | slim handles[] | The current selection. |
| `await flcm.measure(target)` | { x, y, width, height } | Measured pixels relative to the immediate parent. |
| `flcm.gradient(sugar)` | a paint value | { type: linear or radial, stops, angle?, at? }. Also accepts (type, stops, angle?). |
| `flcm.image(url, options?)` | a paint value | Raster fill. Options: scaleMode, placeholder. Bytes are fetched through the host at the mutation verb. |
| `flcm.effects(sugar)` | effect values[] | CSS and Figma effect values for an effects prop. |
| `flcm.id(nodeId)` | { __flcmId: nodeId } | Force raw-id resolution in a target argument. |
| `await flcm.page.current()` | { fileName, page, pages } | Current page and available pages. |
| `await flcm.page.use(nameOrId)` | { fileName, page, pages } | Switch to an existing page. |
| `await flcm.page.new(name)` | { fileName, page, pages } | Create a uniquely named page and switch to it. |

Nodes are data with type FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR or INSTANCE. gradient, image and effects produce reusable values for props.

### Children and composition

Use `children: [{ type: "TEXT", text: "Hi" }]` on a FRAME. Compose with array spread and filter conditional entries before calling a verb. Every entry must be a plain node object. Instances expose editable content through slot paths in overrides. The verb places the subtree root at its named position; inside each node, mentioned children go to the end in spec order, and unmentioned children keep their relative order. `children: []` on a live node is a no-op.

## Props by node

New nodes require type; INSTANCE also requires componentId, and VECTOR requires exactly one of svg or d. An id refers to a live node; type can be omitted for a move. children is an array of plain specs. Other omitted props keep live values or use creation defaults. The verb returns the spec copied with ids.

### Native spellings accepted

Aliases normalize silently on every verb; equivalent duplicates agree, conflicting values fail. Grid aliases also work inside `layout`. Native anchors are 0-based and combine with spans into 1-based CSS placement.

- `clipsContent` → `clip`
- `fontSize` → `textStyle.fontSize`
- `gridColumnAnchorIndex` → `layout.gridColumn`
- `gridColumnSpan` → `layout.gridColumn`
- `gridRowAnchorIndex` → `layout.gridRow`
- `gridRowSpan` → `layout.gridRow`
- `gridChildHorizontalAlign` → `layout.justifySelf`
- `gridChildVerticalAlign` → `layout.alignSelf`
- `gridColumnsSizing` → `layout.gridTemplateColumns`
- `gridColumnSizes` → `layout.gridTemplateColumns`
- `gridRowsSizing` → `layout.gridTemplateRows`
- `gridRowSizes` → `layout.gridTemplateRows`

### Shared by every node

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | string | Layer name. |
| `key` | string | Persistent metadata for find/findOne. Unique within one authored tree; id alone decides live identity. |
| `opacity` | number (0–1) | Whole-node opacity, 0–1. |
| `mixBlendMode` | "normal" \| "multiply" \| "screen" \| "overlay" \| "soft-light" \| … (CSS mix-blend-mode) | A CSS mix-blend-mode name. An unknown one fails loud. |
| `visible` | boolean | Layer visibility. get and find include hidden nodes and their annotations. |
| `locked` | boolean | Locks the layer against pointer edits in Figma's UI. flcm.edit still writes to it. |

### Annotations

| Prop | Type | Notes |
| --- | --- | --- |
| `annotations` | { text?: string; category?: string; properties?: string[] }[] | Native annotations. Omitted leaves annotations untouched; a supplied array replaces the whole collection; [] clears every one. |

Figma's native annotations — the note a designer pins to a layer from the right panel — are how a human points you at a nested layer, and how you leave intent on what you build. A frame, shape, text, instance or slot can carry them; a GROUP or SECTION cannot, so annotate a frame, not a group. Hidden layers and their annotations are included in `find` and `get`.

**The rule:** an instruction to change the design is done when the change is made, so remove it once you've verified the result; a note about how the design works stays. Finding an annotation doesn't authorise acting on it — the user's request does. The category `Agent` marks the exchange between the human and you, in both directions; most human notes carry no category, and that's fine.

`text` is Figma-flavoured markdown. `category` is the category's name — created in the file on first use, so spell an existing one exactly; a verb that fails removes the category it created. `properties` is Figma's list of pinned design properties (`["width", "fills"]`); it rides along on read and write so a note you preserve keeps its pins. Leave intent as you build: `{ type: "FRAME", annotations: [{ text: "Tapping opens the filter sheet", category: "Agent" }], children: [...] }`. The array **replaces** the node's whole collection: omit it to leave annotations alone, `[]` clears every one, a supplied array becomes the collection.

Start from `flcm.selection()`: check the selected root's own `annotations`, then `find({ hasAnnotations: true, within: root })` for its descendants — `within` searches descendants only. `hasAnnotations` tests the live collection, and the slim handles come back carrying their `annotations`. To remove one, re-read the node **immediately before writing** and find your entry in that fresh collection by `text` — annotations have no id, so an index from the earlier read may not be the same note:

```js
const [hit] = await flcm.find({ hasAnnotations: true, within: root });
const task = hit.annotations[0].text;
// … make the change the note asks for, verify the result, then:
const fresh = (await flcm.get(hit)).node.annotations ?? [];
const done = fresh.find((a) => a.text === task);
if (done) {
  await flcm.edit(hit, { annotations: fresh.filter((a) => a !== done) });
} // not there any more: leave the node alone and say so in chat
```

Data copies and clone preserve annotations. Remove unwanted notes explicitly.

### Size & position (FRAME, TEXT, RECTANGLE, ELLIPSE, VECTOR, INSTANCE)

A LINE sizes along its length alone, its `width`: a number, or `"fill"` under a row or column parent — the divider case, where the flow supplies the length. There is no `height`, no `"hug"` and no percent.

| Prop | Type | Notes |
| --- | --- | --- |
| `layout` | { gridColumn?, gridRow?, justifySelf?, alignSelf?, zIndex? } | Placement under an auto-layout parent. Grid accepts cell alignment; flow accepts only the alignSelf "stretch" alias for counter-axis fill. |
| `minWidth` | number \| "none" | minWidth in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `maxWidth` | number \| "none" | maxWidth in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `minHeight` | number \| "none" | minHeight in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `maxHeight` | number \| "none" | maxHeight in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `width` | number \| "Npx" \| "N%" \| "fill" \| "hug" | A fixed size (a number or "Npx"), "N%" of the parent axis (rejected for in-flow grid children), "fill" (stretch to the parent — rejected on the root), or "hug" (shrink to content — only a row/column/grid container or text can hug). |
| `height` | number \| "fill" \| "hug" \| "N%" | Same rules as width. On TEXT the height follows the content ("hug", the default): set `width` to re-wrap it, use "fill" inside an auto-layout parent and "hug" to undo that; a fixed or percent height is rejected. |
| `left` | number \| "Npx" \| "N%" | Offset from the parent's left edge — a number, "Npx", or "N%" of the parent width. Naming `left` or `top` lifts the node out of an auto-layout parent's flow (badges, overlays); under a free-form parent it is simply where the node sits. On a render root it is where on the PAGE the tree lands — without it every root stacks at the origin. Under edit, an axis you don't name keeps its live value. |
| `top` | number \| "Npx" \| "N%" | Offset from the parent's top edge. Same rules as `left`. |
| `position` | "absolute" \| "none" | "absolute" lifts the node out of auto-layout flow where it stands (no coordinate needed — `left`/`top` already imply it). Under edit, "none" returns the node to the flow; naming `left`/`top`/`anchor` beside "none" fails loud. |
| `anchor` | { x?: left/center/right, y?: top/center/bottom } | Which point of the node lands on `left`/`top` (default its top-left corner), so anchor:{ x:"center" } with left:"50%" centres it. Each anchor axis needs its coordinate in the same call. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how the node responds when its parent resizes, replacing the automatic choice. Honored for a child of a free-form parent and for any out-of-flow (`left`/`top`) child; on an in-flow auto-layout child it is stored but inert (fill/hug governs there) until the node leaves the flow. Under edit, "none" restores the default near-edge pin. Never lifts a node out of flow by itself. |

#### Percent sizing

`width`, `height`, `left` and `top` take a percent string — `"50%"` of the parent's size on that axis, resolved against its *realized* size once layout settles (so a percent child of a `"fill"` or percent-sized parent is fine).

```js
const track = { type: "FRAME", width: 300, height: 8, borderRadius: 4, fill: "#E5E7EB", children: [
  { type: "RECTANGLE", width: "35%", height: 8, borderRadius: 4, fill: "#6366F1" }, // 35% of the track
] };
```

In-flow GRID children reject percent sizes: the relevant base is the cell, whose settled geometry is not available through the authoring surface. Use fixed pixels or `fill`; absolute grid children resolve against the whole parent frame.

Another case **fails loud**: an in-flow percent-*sized* child of an auto-layout parent that *hugs* that axis — the parent sizes to the child while the child sizes to the parent. Give the parent a fixed or `"fill"` size, or lift the child out of the flow with `left`/`top`. A percent (or `"fill"`) on the **root** fails loud too: its parent is the page, which is unbounded.

**Responsive by default.** A percent renders to fixed pixels now, and a **positioned** child — one in a free-form parent, or one lifted out of an auto-layout flow by `left`/`top` — also gets a Figma constraint, so it still reflows when the parent is resized later. Per axis, derived from how you sized it:

| You wrote | Auto constraint | On resize |
| --- | --- | --- |
| `width:"fill"` | stretch | grows/shrinks with the parent |
| `width:"N%"` | scale | scales proportionally |
| `left:"N%"` | center | holds its relative spot |
| a plain number | near edge | stays put (Figma default) |

**`pin`** overrides that choice; **`anchor`** picks which point of the node lands on `left`/`top` (default top-left), which is what saves the half-width subtraction when centring:

```js
// a close button that stays top-right as the card widens
const card = { type: "FRAME", width: 320, height: 200, children: [
  { type: "RECTANGLE", width: 28, height: 28, left: 284, top: 12, pin: { x: "right", y: "top" } },
] };

// a knob centred on the 40% mark
const knob = { type: "ELLIPSE", width: 16, height: 16, left: "40%", top: "50%", anchor: { x: "center", y: "center" } };
```

`pin` is ignored on an in-flow auto-layout child, which reflows through `fill`/`hug` instead. A bad `pin` or `anchor` value fails loud.

**Cross-axis `"fill"` under a parent that hugs that axis is legal** — only a *percent* fails loud there. It isn't the same cycle: the hug still measures the children's own sizes, and the filling child then matches the result. So a `width:"fill"` child of a hugging column comes out as wide as its widest sibling, and one that has no sibling to measure just keeps the size it already had. Give the parent a fixed or `"fill"` width when you want the child to stretch to something.

**`wrap: true` and a `"fill"`-width child pull against each other.** Nothing refuses the pair, but wrap breaks the row when the children run out of width while `"fill"` claims whatever width is left on the line — so the filling child closes the line it is on and everything after it wraps. Size wrapped children in pixels or let them hug; keep `"fill"` for a row that doesn't wrap.

Sizing bounds use `minWidth`, `maxWidth`, `minHeight`, and `maxHeight` in positive pixels. Bounds govern auto-layout containers and their direct children. Reads retain these bounds, including instance-only bounds. Omitted bounds remain unchanged; `"none"` clears one. A valid resize constrained by a bound succeeds and adds a warnings record to the node, with the property, authored size and realized size. Contradictory bounds reject before writes.

After sizing settles, overflow stays in the run summary because it describes a parent/child pair. Each affected container names its worst overflowing child and parent by id and name, the axis, and the pixels past the edge. Additional offenders appear as "and N more". A clipped parent hides the excess; an unclipped parent lets it paint outside. This includes existing overflow and nested layouts. The write still succeeds.

For example: 4986:24352 "Scrim" overflows 4986:24351 "Header" by 100px on x; the parent does not clip, so the excess paints outside it.

New text with omitted width fills a column whose available width is independently bounded, and omitted height grows with wrapped content. A hugging column or horizontal row keeps content-driven text width. Explicit sizes and omitted edit fields retain their existing meaning.

Budget fixed widths together with padding and gaps; use `"fill"` for the remaining space. Fixed heights can overflow when text wraps or children grow. Use `"hug"` where the container should grow with content. Existing `pin` constraints control children of free-form containers and absolute children; in-flow auto-layout children use fill/hug. Inspect screenshots for visual quality beyond geometric overflow.

### FRAME — container props

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | paint \| paint[] | Background paint: a color/gradient string, flcm.gradient(...) or flcm.image(url). An array is a paint stack, first entry on top — see Paint & gradients. "none" removes it. |
| `stroke` | paint \| paint[] | Border paint, or a stack of them. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `strokeAlign` | "inside" \| "outside" \| "center" | Which side of the edge. Default "inside". |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only. |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |
| `layout` | { mode?, gridTemplateColumns?, gridTemplateRows?, gap?, wrap?, padding?, justifyContent?, alignItems?, gridColumn?, gridRow?, justifySelf?, alignSelf?, zIndex? } | Own container settings plus placement under the parent. Creating a grid requires gridTemplateColumns; rows are implicit hug tracks unless named. |
| `clip` | boolean | Clip children to the frame's bounds. Default false, like CSS overflow: visible. |

#### Auto-layout config (the `layout` object)

| Prop | Type | Notes |
| --- | --- | --- |
| `gridTemplateColumns` | string | Grid columns, in read form: Npx, Nfr, auto or fit-content(100%) tracks; repeat(N, tracks) and minmax(0, Nfr) expand to native tracks. Reads return expanded tracks. Required when creating a grid — Figma flows row-wise, so the columns are the axis nothing can infer. Fractional axes need explicit fixed or fill sizing. Other axes default to hug. |
| `gridTemplateRows` | string | Grid rows, with the same track syntax as gridTemplateColumns. Optional: omitted, rows are implicit — hug tracks, one per row the children need at this column count, growing as children are added. Naming rows makes them explicit, on an edit too: the named tracks are what the grid keeps, and it stops growing rows for new children. |
| `mode` | "row" \| "column" \| "grid" \| "none" | Auto-layout mode. Default "none" = free-form. Creating a grid requires gridTemplateColumns (rows are implicit); edits preserve omitted templates. |
| `gap` | number \| string | A number, "Npx", or "row-gap column-gap" in px. Unequal gaps require grid or wrapping. |
| `wrap` | boolean | Wrap children onto new rows. Requires horizontal auto-layout. False disables wrapping; omitted edits preserve it. |
| `padding` | number \| "12px 16px" \| { x?, y? } \| { top?, right?, bottom?, left? } | A number, the CSS box shorthand ("12px 16px"), { x, y } (x→left+right, y→top+bottom), or per-edge. Edge values take a number or "Npx". |
| `justifyContent` | "flex-start" \| "flex-end" \| "center" \| "space-between" | CSS justify-content, main axis. Figma has no space-around/space-evenly — those fail loud. |
| `alignItems` | "flex-start" \| "flex-end" \| "center" \| "stretch" \| "baseline" | CSS align-items, cross axis. "baseline" requires a horizontal row. "stretch" stretches every auto-sized child (a fixed cross-axis size wins); one child alone stretches via width/height "fill". |

#### Placement under a parent (in the same `layout` object)

| Prop | Type | Notes |
| --- | --- | --- |
| `gridColumn` | string | Grid child column: "N", "span N", or "N / span N". Anchors are 1-based. Omitted placement uses Figma auto-placement. A grid child sizes in px, "fill" (the cell) or "hug"; "N%" is refused because the reference would be the cell, not the frame. |
| `gridRow` | string | Grid child row: "N", "span N", or "N / span N". Anchors are 1-based. Rows a grid did not name grow to hold the placement. |
| `justifySelf` | "start" \| "center" \| "end" \| "auto" | Grid child horizontal cell alignment. "auto" restores Figma alignment. |
| `alignSelf` | "center" \| "stretch" \| "start" \| "end" \| "auto" | Grid vertical cell alignment: start/end/center/auto. Flow children accept only "stretch", an alias for counter-axis fill. Figma renders no per-child MIN/CENTER/MAX alignment in flow. Set layout.alignItems on the parent for every child, or wrap the child in a fill-sized frame with its own alignItems. |
| `zIndex` | number | Grid child sibling index, a non-negative integer. Explicit indices reserve sibling slots; unnamed siblings retain relative order in remaining slots. Duplicate or out-of-range indices fail. |

### TEXT — text props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | string \| run[] | The content — a plain string (markdown: **bold**, *italic*, ~~strike~~, [text](url)) or an array of styled runs. Set it on a TEXT spec; under edit it replaces the whole content. |
| `textStyle` | { fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, lineClamp? } | The text style base. Runs layer over it. |
| `fill` | paint \| paint[] | The text's paint, like every other node's. "none" removes it. |
| `boldWeight` | number (100–900) \| name | What `**bold**` in `text` resolves to. Default 700 — pass back the `boldWeight` a `get` reports and the copy emphasizes like the original. Same spellings as fontWeight. Under edit it only means something beside `text`. |

`text` is a string or array of styled runs. `fill` is its paint. `boldWeight` says what `**` in `text` resolves to. A fixed `width` makes it wrap (grows in height); otherwise it grows sideways.

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
| `lineClamp` | number (≥1) \| "none" | Truncate to at most N lines with an ellipsis. Needs a bounded `width` so the text wraps — on a hugging text it fails loud. `"none"` removes a clamp. |

### TEXT — rich text (runs)

`TEXT` takes **either** a plain string **or** an array of **runs** — one text node, several styles.

**Markdown in a plain string** — `**bold**`, `*italic*`, `~~strike~~`, `[text](url)` — parses to styled spans:

```js
const message = { type: "TEXT", text: "Ship it **today** — see the [runbook](https://ex.co/run) first." };
```

Backslash-escape to render one literally: `"save 20% \\*today\\*"`. Only `\ * _ ~ [ ] ( ) { }` are escapable, and this matches figma-mcp's read output, so text you read back round-trips. `![alt](url)` fails loud — use `flcm.image(url)`.

**Runs array** — a run is a bare string or a `[text, style]` tuple. The style is a **delta** over the node-level `textStyle` base, so each span carries only what it changes:

```js
// a feed caption as ONE node: a colored @handle, plain body, a muted "more"
const caption = { type: "TEXT", text: [
  ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
  " summited at golden hour. ",
  ["more", { color: "#8E8E93" }],
], textStyle: { fontSize: 14 } };
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
| `color` | paint \| paint[] | Per-span text color. |
| `hyperlink` | string (url) \| { type: "URL", url } | A URL over THIS span — inline `[text](url)` is usually simpler. Links to a NODE are read-only and fail loud. |

### RECTANGLE — shape props

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | paint \| paint[] | Background paint: a color/gradient string, flcm.gradient(...) or flcm.image(url). An array is a paint stack, first entry on top — see Paint & gradients. "none" removes it. |
| `stroke` | paint \| paint[] | Border paint, or a stack of them. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `strokeAlign` | "inside" \| "outside" \| "center" | Which side of the edge. Default "inside". |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only. |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |

### ELLIPSE — shape props

(An ellipse has no `borderRadius` — its edge is already round.)

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | paint \| paint[] | Background paint: a color/gradient string, flcm.gradient(...) or flcm.image(url). An array is a paint stack, first entry on top — see Paint & gradients. "none" removes it. |
| `stroke` | paint \| paint[] | Border paint, or a stack of them. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `strokeAlign` | "inside" \| "outside" \| "center" | Which side of the edge. Default "inside". |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |

### LINE — line props

| Prop | Type | Notes |
| --- | --- | --- |
| `stroke` | paint \| paint[] | The line's paint. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Thickness. Defaults to 1. |
| `width` | number \| "Npx" | The line's length: a number, or "fill" to span a row/column parent (the divider case). No "hug" and no percent — a line has no content to measure and no cell to measure against. |
| `rotation` | number (deg) | Degrees — 90° makes a horizontal line vertical. |
| `layout` | { gridColumn?, gridRow?, justifySelf?, alignSelf?, zIndex? } | Placement under an auto-layout parent. Grid accepts cell alignment; flow accepts only the alignSelf "stretch" alias for counter-axis fill. |
| `left` | number \| "Npx" \| "N%" | Offset from the parent's left edge — a number, "Npx", or "N%" of the parent width. Naming `left` or `top` lifts the node out of an auto-layout parent's flow (badges, overlays); under a free-form parent it is simply where the node sits. On a render root it is where on the PAGE the tree lands — without it every root stacks at the origin. Under edit, an axis you don't name keeps its live value. |
| `top` | number \| "Npx" \| "N%" | Offset from the parent's top edge. Same rules as `left`. |
| `position` | "absolute" \| "none" | "absolute" lifts the node out of auto-layout flow where it stands (no coordinate needed — `left`/`top` already imply it). Under edit, "none" returns the node to the flow; naming `left`/`top`/`anchor` beside "none" fails loud. |
| `anchor` | { x?: left/center/right, y?: top/center/bottom } | Which point of the node lands on `left`/`top` (default its top-left corner), so anchor:{ x:"center" } with left:"50%" centres it. Each anchor axis needs its coordinate in the same call. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how the node responds when its parent resizes, replacing the automatic choice. Honored for a child of a free-form parent and for any out-of-flow (`left`/`top`) child; on an in-flow auto-layout child it is stored but inert (fill/hug governs there) until the node leaves the flow. Under edit, "none" restores the default near-edge pin. Never lifts a node out of flow by itself. |

### VECTOR — path props (`d` / `vectorPaths`)

Bare geometry: the node's box is the path's bounding box, so there is no `width`/`height` here — `scale` is the size word.

| Prop | Type | Notes |
| --- | --- | --- |
| `vectorPaths` | Array<{ data: string; windingRule: "NONZERO" \| "EVENODD" \| "NONE" }> | Native path records for multiple paths or even-odd winding. Use exactly one of d, vectorPaths, or svg. |
| `d` | string | SVG path data, e.g. "M12 2 L22 20 L2 20 Z". Every standard command works (relative/shorthand are normalized); only malformed data fails. The node's box is the path's bounding box — `width`/`height` are ignored here, use `scale`. Use exactly one of d, vectorPaths, or svg. |
| `scale` | number | Multiplies the path's natural bounding box — `scale: 2` draws the same art twice as big. A single positive number, so the art can never stretch out of proportion. The path form's only size word. |
| `fill` | paint \| paint[] | Background paint: a color/gradient string, flcm.gradient(...) or flcm.image(url). An array is a paint stack, first entry on top — see Paint & gradients. "none" removes it. |
| `stroke` | paint \| paint[] | Border paint, or a stack of them. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `strokeAlign` | "inside" \| "outside" \| "center" | Which side of the edge. Default "inside". |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |

### VECTOR — svg props (`svg`)

A canvas of art, so it takes the shared and size/position props too. These two reach the vectors INSIDE the import.

| Prop | Type | Notes |
| --- | --- | --- |
| `fill` | paint \| paint[] | Repaints every vector inside the imported markup, overriding the colors written into it — how an icon takes your theme. "none" clears their fills. |
| `stroke` | paint \| paint[] | Repaints every vector's stroke inside the imported markup. "none" clears them. |

### INSTANCE — component words

(An instance also takes every `FRAME` prop above; each one named is a root-level override. `componentId` names the component in the props form, and swaps it under edit — see the components section.)

| Prop | Type | Notes |
| --- | --- | --- |
| `componentId` | component target | Required on a new INSTANCE: its COMPONENT or COMPONENT_SET target. On a live instance, swaps to that component. See Changing an instance. |
| `exposed` | boolean | Expose this nested instance's existing controls in the enclosing instance panel. Writable only inside a component definition; false clears it. |
| `componentProperties` | { [name]: string \| boolean \| component target } | Values by bare name (no `#id` suffix), as `get` reports them: a variant axis, a boolean, a text, or a component target for an instance_swap. A slot has no value here — its content is `children` under `overrides`. |
| `overrides` | { [path]: delta } | Sublayer deltas keyed by component-relative path as `get` keys them (`"11:9"`, or `"11:9;11:14"` inside a nested instance), each in that sublayer's edit vocabulary; at a SLOT's path the delta also takes `children`. |

## Vector art (svg & path)

Use `type: "VECTOR"` with exactly one geometry prop. The two forms answer different questions — `d` is a shape, `svg` is a drawing on a canvas:

```js
// d: bare geometry. The node's box IS the path's bounding box.
await flcm.render({ type: "VECTOR", d: "M0 0 L24 24", stroke: "#111", strokeWidth: 2 });
await flcm.render({ type: "VECTOR", d: "M15 18 L9 12 L15 6", stroke: "#111", scale: 2 }); // same art, twice as big

// svg: art on the canvas its viewBox declares — and fill/stroke recolor every vector inside it.
await flcm.render({
  type: "VECTOR",
  svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/></svg>',
  fill: "#6366F1", // recolors the circle, whatever the markup said
  width: 24,
  height: 24,
});
```

`d` is a themeable SVG path, and `vectorPaths` the same form spelled with multiple native paths and their NONZERO, EVENODD or NONE winding rules. Use exactly one of d, vectorPaths or svg. There is no icon catalog. Supply the artwork.

A path has no canvas, so it has no `width`/`height`: its box is the geometry you gave it, and `scale` (one positive number) is the only word that changes that box — art authored with `d` can never come out stretched. Passing `width`/`height` beside `d` at creation is ignored with warnings on the returned node, one per property with authored and realized dimensions; the rest of the node is created as written. When the intent is "this icon lives on a 24 grid", that grid is a viewBox, so use `svg`.

`svg` imports markup through Figma's own SVG import: one vector per shape, inside a frame. Size words apply to that frame, and its art scales with it. `fill` and `stroke` beside `svg` repaint every vector inside, overriding the colors written into the markup — so one icon's markup serves every theme ("none" clears them). Stroke weight is left alone; it is part of the drawing's proportions.

An id-bearing VECTOR accepts d or vectorPaths as a geometry edit and preserves its live identity, and `edit(id, { width, height })` on a vector resizes its geometry — at that point the current box is something you can see. svg imports can change node types and child identities, so live svg replacement is refused by name. Move imported artwork with { id }, or omit its id to import a new copy; a copy comes back at the path's natural size, so use `flcm.clone` to preserve a box that was resized live.

## Paint & gradients

A paint value (for `fill`, `stroke`, or a run's `color`) is one of:

- a **solid color string** — `"#FF0000"`, `"#FF0000AA"`, `"rgba(255,0,0,0.5)"`;
- a **gradient string** — `"linear-gradient(…)"` / `"radial-gradient(…)"`;
- `flcm.gradient(...)`, which builds the same value without the string; or
- `flcm.image(src)` — a raster fill from a url or local path (see **Images**).

```js
const background = { type: "FRAME", fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" };
const sameBackground = { type: "FRAME", fill: flcm.gradient({ stops: ["#0B1020", "#131A2E"], angle: 180 }) };
flcm.gradient("linear" | "radial", stops, angle);   // the positional form
```

**A stack is an array, first entry on top** — CSS order, and exactly what `get` returns, so a read pastes back unchanged. `fill`, `stroke` and a run's `color` all take one; a single paint stays a bare value. The composite this is for is a photograph under a legibility scrim:

```js
const hero = {
  type: "RECTANGLE", width: 390, height: 260,
  fill: [
    flcm.gradient({ stops: ["rgba(0,0,0,0)", "rgba(0,0,0,0.65)"], angle: 180 }), // the scrim, on top
    flcm.image("https://example.com/photo.jpg"),                                 // the photo, beneath
  ],
};
```

An empty array is "no paint", the same as `"none"`. To change just the photo inside a stack — on an instance, say — write the whole stack back with that one entry replaced; `overrides[path].fill` takes the array like any other paint slot.

### flcm.gradient fields

| Prop | Type | Notes |
| --- | --- | --- |
| `type` | "linear" \| "radial" | Gradient type. Default "linear". |
| `stops` | array of color strings or { color, pos } | Color stops. Each is a color string ("#0B1020") or { color, pos } where pos is a percentage. With no pos, stops spread evenly. Required, non-empty. |
| `angle` | number (deg) | Linear only. Degrees; 180 = top→bottom (default). |
| `at` | { x?, y? } percent | Radial only — the center, in percent. Default { x: 50, y: 50 }. |

## Images

Place a **real raster image** — feed media, an avatar, a thumbnail — instead of faking it with a gradient (which carries no signal it was ever meant to be an image).

`flcm.image(src, opts?)` is a **paint value**, like `flcm.gradient`. An image in Figma is a fill, so any shape carries one: a RECTANGLE for a photo, an ELLIPSE for a circular avatar, a FRAME for a hero. `src` is an https url or a local file path, like CSS `url()`.

```js
const avatar = { type: "ELLIPSE", width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") };
const logo = { type: "RECTANGLE", width: 120, height: 40, fill: flcm.image("public/logo.png", { scaleMode: "FIT" }) };
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

Write effects as the CSS you'd already write — a bag of `{ boxShadow?, textShadow?, filter?, backdropFilter? }`. `flcm.effects({...})` is the second form, and the only way to reach the Figma-native effects CSS has no word for (`glass`, `noise`, `texture`, `progressiveBlur`).

```js
const frosted = { type: "FRAME", effects: { boxShadow: "0 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(16px)" } };
const glass = { type: "FRAME", effects: flcm.effects({ shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" }, glass: { refraction: 0.4 } }) };
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

`await flcm.render(spec)` places the spec on the current page. Set left/top on the root for canvas position. Its return is the input tree copied with ids, including every child and each node in instance slot content. Use those ids directly with get, edit, append and the other target-taking verbs.

`key` is optional persistent metadata used by find and findOne. It does not decide identity. Duplicate keys within one authored tree are refused. Returned dimensions remain the authored values; use measure for realized pixels and get for current read data.

## edit() / editMany() — changing existing nodes

`await flcm.edit(target, changes)` applies a partial delta to one existing node and returns its updated handle. The target is anything the read verbs accept: an flcm/key, a node id, `flcm.id(id)`, or a handle from `render`/`find`. The delta uses the **same words as create** — there is no separate edit dialect — and only the fields you pass change; everything else on the node is untouched.

### Editable fields

| Prop | Type | Notes |
| --- | --- | --- |
| `annotations` | { text?: string; category?: string; properties?: string[] }[] | Native annotations. Omitted leaves annotations untouched; a supplied array replaces the whole collection; [] clears every one. |
| `name` | string | Layer name. |
| `opacity` | number (0–1) | Whole-node opacity, 0–1. |
| `mixBlendMode` | "normal" \| "multiply" \| "screen" \| "overlay" \| "soft-light" \| … (CSS mix-blend-mode) | A CSS mix-blend-mode name. An unknown one fails loud. |
| `visible` | boolean | Layer visibility. get and find include hidden nodes and their annotations. |
| `locked` | boolean | Locks the layer against pointer edits in Figma's UI. flcm.edit still writes to it. |
| `fill` | paint \| paint[] | Background paint: a color/gradient string, flcm.gradient(...) or flcm.image(url). An array is a paint stack, first entry on top — see Paint & gradients. "none" removes it. |
| `stroke` | paint \| paint[] | Border paint, or a stack of them. "none" removes it. |
| `strokeWidth` | number \| "Npx" | Border thickness. |
| `strokeAlign` | "inside" \| "outside" \| "center" | Which side of the edge. Default "inside". |
| `borderRadius` | number \| "Npx" | Corner radius. Frames and rectangles only. |
| `effects` | effects value | Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects. |
| `rotation` | number (deg) | Rotation in degrees. |
| `clip` | boolean | Clip children to the frame's bounds. Default false, like CSS overflow: visible. |
| `minWidth` | number \| "none" | minWidth in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `maxWidth` | number \| "none" | maxWidth in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `minHeight` | number \| "none" | minHeight in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `maxHeight` | number \| "none" | maxHeight in positive pixels, effective on auto-layout containers and their direct children. Omitted preserves the bound; "none" clears it. Sizes constrained by bounds succeed with a warnings record containing prop, authored and realized values. |
| `width` | number \| "Npx" \| "N%" \| "fill" \| "hug" | A fixed size (a number or "Npx"), "N%" of the parent axis (rejected for in-flow grid children), "fill" (stretch to the parent — rejected on the root), or "hug" (shrink to content — only a row/column/grid container or text can hug). |
| `height` | number \| "fill" \| "hug" \| "N%" | Same rules as width. On TEXT the height follows the content ("hug", the default): set `width` to re-wrap it, use "fill" inside an auto-layout parent and "hug" to undo that; a fixed or percent height is rejected. |
| `layout` | { mode?, gridTemplateColumns?, gridTemplateRows?, gap?, wrap?, padding?, justifyContent?, alignItems?, gridColumn?, gridRow?, justifySelf?, alignSelf?, zIndex? } | Own container settings plus placement under the parent. Creating a grid requires gridTemplateColumns; rows are implicit hug tracks unless named. |
| `left` | number \| "Npx" \| "N%" | Offset from the parent's left edge — a number, "Npx", or "N%" of the parent width. Naming `left` or `top` lifts the node out of an auto-layout parent's flow (badges, overlays); under a free-form parent it is simply where the node sits. On a render root it is where on the PAGE the tree lands — without it every root stacks at the origin. Under edit, an axis you don't name keeps its live value. |
| `top` | number \| "Npx" \| "N%" | Offset from the parent's top edge. Same rules as `left`. |
| `position` | "absolute" \| "none" | "absolute" lifts the node out of auto-layout flow where it stands (no coordinate needed — `left`/`top` already imply it). Under edit, "none" returns the node to the flow; naming `left`/`top`/`anchor` beside "none" fails loud. |
| `anchor` | { x?: left/center/right, y?: top/center/bottom } | Which point of the node lands on `left`/`top` (default its top-left corner), so anchor:{ x:"center" } with left:"50%" centres it. Each anchor axis needs its coordinate in the same call. |
| `pin` | { x?, y? } \| "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none | Constraint override — how the node responds when its parent resizes, replacing the automatic choice. Honored for a child of a free-form parent and for any out-of-flow (`left`/`top`) child; on an in-flow auto-layout child it is stored but inert (fill/hug governs there) until the node leaves the flow. Under edit, "none" restores the default near-edge pin. Never lifts a node out of flow by itself. |
| `text` | string \| run[] | The content — a plain string (markdown: **bold**, *italic*, ~~strike~~, [text](url)) or an array of styled runs. Set it on a TEXT spec; under edit it replaces the whole content. |
| `textStyle` | { fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, lineClamp? } | The text style base. Runs layer over it. |
| `boldWeight` | number (100–900) \| name | What `**bold**` in `text` resolves to. Default 700 — pass back the `boldWeight` a `get` reports and the copy emphasizes like the original. Same spellings as fontWeight. Under edit it only means something beside `text`. |
| `exposed` | boolean | Expose this nested instance's existing controls in the enclosing instance panel. Writable only inside a component definition; false clears it. |
| `componentProperties` | { [name]: string \| boolean \| component target } | Values by bare name (no `#id` suffix), as `get` reports them: a variant axis, a boolean, a text, or a component target for an instance_swap. A slot has no value here — its content is `children` under `overrides`. |
| `overrides` | { [path]: delta } | Sublayer deltas keyed by component-relative path as `get` keys them (`"11:9"`, or `"11:9;11:14"` inside a nested instance), each in that sublayer's edit vocabulary; at a SLOT's path the delta also takes `children`. |
| `componentId` | component target | Required on a new INSTANCE: its COMPONENT or COMPONENT_SET target. On a live instance, swaps to that component. See Changing an instance. |
| `componentPropertyReferences` | { visible?, text?, componentId?, slot? } — property names, or null to unbind | On a live sublayer of a COMPONENT: which of its properties drives `visible` (any node), `text` (TEXT), `componentId` (INSTANCE) or `slot` (FRAME); `null` unbinds the field. See Binding a layer in the components section. |
| `description` | string | Shown beside the component in Figma's assets panel. |
| `propertyDefinitions` | { [name]: { type?, defaultValue?, name? } \| null } | COMPONENT / COMPONENT_SET, under edit: add, re-default, rename or delete a property. See Changing a component. |

### Words by node type

- **FRAME** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `borderRadius`, `effects`, `rotation`, `clip`, `componentPropertyReferences`
- **TEXT** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `text`, `textStyle`, `fill`, `boldWeight`, `componentPropertyReferences`
- **RECTANGLE** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `borderRadius`, `effects`, `rotation`, `componentPropertyReferences`
- **ELLIPSE** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `effects`, `rotation`, `componentPropertyReferences`
- **LINE** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `stroke`, `strokeWidth`, `width`, `rotation`, `layout`, `left`, `top`, `position`, `anchor`, `pin`, `componentPropertyReferences`
- **VECTOR (path- or svg-born)** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `effects`, `rotation`, `componentPropertyReferences`
- **INSTANCE** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `borderRadius`, `effects`, `rotation`, `clip`, `exposed`, `componentProperties`, `overrides`, `componentId`, `componentPropertyReferences`
- **COMPONENT** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `borderRadius`, `effects`, `rotation`, `clip`, `description`, `propertyDefinitions`
- **COMPONENT_SET** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `borderRadius`, `effects`, `rotation`, `clip`, `description`, `propertyDefinitions`
- **POLYGON** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `annotations`
- **STAR** — `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `annotations`
- **SLOT** — `annotations`, `name`, `opacity`, `mixBlendMode`, `visible`, `locked`, `layout`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `width`, `height`, `left`, `top`, `position`, `anchor`, `pin`, `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `borderRadius`, `effects`, `rotation`, `clip`

On a node type with no vocabulary of its own (GROUP, SECTION, POLYGON, …) only the shared words apply: `name`, `opacity`, `mixBlendMode`, `visible`, `locked`.

### Removal — the `"none"` word

`"none"` is the one removal word, surface-wide: `fill`/`stroke` clear the paint, `effects` clears every effect, `position: "none"` returns the node to its parent's flow, `pin` (or `pin: { x: "none" }` per axis) restores the near-edge default, `layout: { mode: "none" }` switches auto-layout off. The same spellings are legal at create, where they mean the explicit default. Sizes are never removed, only replaced within the number/`"fill"`/`"hug"` trio — `width: "hug"` is how a fixed width comes off.

### Rules

- **A node type takes exactly the words create accepts for it.** `fill` on a LINE, `clip` on a TEXT, `borderRadius` on a VECTOR — each rejects loud, naming the prop, the type, and that type's editable words.
- **Only the fields you pass change — per axis, too.** `pin: { x: "center" }` keeps the y pin; `left: 10` keeps the live `top`; `width: "hug"` leaves the height alone.
- **Un-filling really un-fills.** `width: 80` or `"hug"` on a `"fill"` child clears the grow/stretch marks — the new size governs.
- **Container edits ripple by stated rules.** `layout.alignItems: "stretch"` walks the live children setting their stretch marks; any other value clears every one (Figma doesn't record which child stretched because of the container, so a child that should keep filling needs its own `height: "fill"`). Changing direction — row↔column, or `"none"` to either — clears both flow marks on every in-flow child, since the axes they meant just moved.
- **Layout legality is create's rule set, applied to live facts** and rejected before any write: a percent on an in-flow child of a hugging parent, `"fill"`/`"N%"` under the page, `"hug"` with nothing to measure, a fixed/hug/percent `height` on TEXT, or container words on a frame that isn't (and after this delta still won't be) a row/column container. Percents resolve immediately against the live parent.
- **Text words read the LIVE node.** `text` replaces the whole text and collapses it to its LEADING run's style — prior bold spans and per-range colors do NOT survive, so style the new text in the same edit. A `textStyle` naming part of the font triple keeps the live rest (`fontWeight: "bold"` on italic Roboto stays bold italic Roboto). A text that already MIXES fonts has no single base: a partial font change, or a styled `text` run without its own `fontFamily`, rejects loud — anchor `textStyle.fontFamily` in the same edit, or give every run its family. `lineClamp` needs a bounded width.
- **Edits inside a component INSTANCE apply as overrides.** A property Figma forbids overriding rejects, naming the instance — edit the main component (flcm never auto-detaches).
- **An INSTANCE target also takes its three component words** — `componentProperties`, `overrides`, and `componentId` (the swap). See the components section; on any other node type each fails loud as an unknown word for that type.
- **A COMPONENT or COMPONENT_SET target takes a frame's words plus `description` and `propertyDefinitions`** — editing the main is how every instance of it changes. A layer inside one also takes `componentPropertyReferences`, which binds it to a property. See the components section.
- **`key` is immutable** — re-keying could mint a duplicate address. Set `name` to change the layers panel.
- **No bare `x`/`y`** — position is `left`/`top` (naming either lifts a child out of an auto-layout flow; `position: "absolute"` lifts it in place, `position: "none"` returns it), resize behavior is `pin`.
- **An empty delta is rejected**, since it would still mint an undo step.
- **Each edit is one undo step.** The whole delta validates before the first write; a Figma refusal mid-apply rolls the node back, and the error carries the target's identity, Figma's reason, and how many earlier mutating calls still stand.
- Delta values are **absolute**, never relative (`+10`), so re-running an edit converges instead of compounding.

### Many at once — `flcm.editMany`

`await flcm.editMany([{ id, ...changes }, …])` applies a whole set of deltas as **one** call, returning a handle per entry in order. Each entry is the plain-data node shape used everywhere else — a live node `id` plus exactly an `flcm.edit` delta. A key or a handle is not an id, so locate the nodes first and pass what you got back:

```js
const cards = await flcm.find({ type: "FRAME", name: "Card" });
await flcm.editMany(cards.map((card) => ({ id: card.id, fill: "#F6F7F9", borderRadius: 12 })));
```

Reach for it whenever you're nudging more than one node — a loop over `flcm.edit` is not the same thing:

- **The set is atomic.** Every id resolves and every delta validates before the first write; a loop would already have mutated entries 1–3 when entry 4's typo surfaced.
- **One rejection names every bad entry**, indexed, so you fix the batch in one pass; entries that failed the same way report together as one counted line.
- **The whole batch is one undo step.**
- **Order doesn't matter** — entries settle ancestors-first, so turning a parent into a row and setting its child to `width: "fill"` works either way round.
- **Two entries for the same node reject** rather than last-wins; put both fields in one entry.

Props only: tree shape stays with `append`/`move`/`remove`/`clone`.

## Tree shape — placing, moving, removing

All placement verbs take a plain spec. append and prepend take a parent; insertBefore and insertAfter take a sibling. render uses the current page. Each returns a deep copy of the spec with every node id filled in.

```js
const panel = await flcm.render({ type: "FRAME", width: 320, height: 200 });
const label = await flcm.append(panel, { type: "TEXT", text: "Hello" });
await flcm.prepend(panel, { id: label.id, text: "Moved and edited" });
```

No id creates. An id moves and edits that live node. This applies recursively, including new children inside moved nodes and live children inside new nodes.

Placement is one undo step. Malformed input and unresolved resources fail before writing; a Figma write failure rolls the call back. A node cannot move into itself or a descendant. Figma instance sublayers cannot be moved; slot content remains open.

Unmentioned children are retained. remove explicitly deletes a node and its subtree. replace places a spec at a target's position and removes the original after placement succeeds. A new replacement inherits omitted placement and size; explicit props win. Replacing a node with its own id edits it without deleting it.

clone duplicates the live subtree faithfully and clears its keys. It returns { node, to? }; the default destination is the source parent. Optional root props apply before returning the copy.

get returns { node, components? }. Use its node as a spec. readOnlySource preserves decoded state beyond the authoring vocabulary; clone preserves live state a spec cannot author.

## Components — making and using them

`await flcm.component(specOrTarget, options?)` promotes a FRAME to a COMPONENT. A new spec is placed on the current page; a live root stays where it is and receives the named edits and children before promotion. The return is the spec copied with ids, with type COMPONENT and the new component id at the root. Figma preserves child identity during promotion. Save the returned component in session; the replaced FRAME root id no longer resolves.

Options are name, description and propertyDefinitions. Child componentPropertyReferences bind authored fields to those definitions.

### flcm.component options

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | string | Defaults to the authored node's or promoted node's own name. |
| `description` | string | Shown beside the component in Figma's assets panel. |
| `propertyDefinitions` | { [name]: { type, defaultValue? } } | The properties it exposes, by name — non-empty, unique in the call. See Properties. |

### Properties

A primary nested instance inside a component definition accepts `exposed: true` to show its existing controls in the enclosing instance panel; `false` clears exposure. This works in component construction and edits to the definition's nested instance.

`propertyDefinitions` declares what the component exposes; each node inside names the property that drives one of its fields with `componentPropertyReferences` (`null` is the edit-side unbind word, not a create word). Both are checked against each other before any write.

```js
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
```

- **One field per type, on the node that owns it:** `boolean` → `visible` (any node), `text` → `text` (`TEXT`), `instance_swap` → `componentId` (`INSTANCE`), `slot` → `slot` (`FRAME`). A field on the wrong node type fails at the verb; an undeclared name fails loud listing the declared ones, a mismatched type fails loud.
- **Omit `defaultValue` to derive it from the binding node**: its `visible` (unnamed is `true`), its text, its component. That needs exactly one binder: a property nothing binds must state one; two binders leave no single value.
- **A slot IS a frame you author.** The bound frame stays in the definition, placeholder children and all, and every instance shows it as a SLOT holding that content until it fills it (below). A slot no frame binds is refused (rather than Figma's unpositioned 100×100 box); two frames on one slot are refused: a slot is one hole.
- **`variant` is not a type.** Axes come from folding components into a set (`flcm.variants`).
- **A binding means something only with a component behind it**: this call, or an insert into / an edit of a layer inside a live component (below). Under `render`, or an insert or edit anywhere else, it is refused naming the word.

#### One `propertyDefinitions` entry

| Prop | Type | Notes |
| --- | --- | --- |
| `type` | "boolean" \| "text" \| "instance_swap" \| "slot" | Required; each type drives one field (see Properties). |
| `defaultValue` | boolean \| string \| component target | What a fresh instance starts at. A `slot` refuses one: its content is authored, not set. |
| `name` | string | Edit only: renames the property. At create the key IS the name, so this fails loud. |

### Variants — `flcm.variants`

`await flcm.variants(entries, { name, description? })` folds standalone components into a COMPONENT_SET and returns its handle. Each entry says which member of the set its component **is**; an instance picks a member by those axes in `componentProperties`.

```js
const small = await flcm.component({ type: "FRAME", width: 96, height: 32 }, { name: "Button" });
const large = await flcm.component({ type: "FRAME", width: 128, height: 44 }, { name: "Button" });
const set = await flcm.variants(
  [
    { component: small, variant: { Size: "Small" } },
    { component: large, variant: { Size: "Large" } },
  ],
  { name: "Button" },
);
```

- Every entry names the same axes, order-free; the first entry's key order is the set's. Names and values are non-empty with no `=` or `,` (Figma's variant-name grammar); no two entries may name the same combination.
- Each component is renamed to that grammar (`Size=Large, State=Default`) as it joins. `name` is required, or Figma names the set after the first member's axes. The set lands where the first component sat: its parent, its index.
- An entry must be a standalone local COMPONENT: a FRAME or INSTANCE fails loud pointing at `flcm.component`, a library component fails loud, and a component already in a set fails loud naming it (there is no add-to-a-set form).

### Changing a component — `flcm.edit`

**A main component is edited with `flcm.edit` and the structural verbs, as a frame is**, and every instance follows: its root takes a frame's whole vocabulary (so does a COMPONENT_SET, whose layout arranges its variants), and its sublayers are ordinary nodes to edit by id, `append` to, or `remove`. Two words exist only here, `description` and `propertyDefinitions`, the latter keyed by each property's current name (bare, or with its `#suffix`):

```js
await flcm.edit(comp, {
  propertyDefinitions: {
    Size: { type: "text", defaultValue: "M" },   // a new name  → ADDS
    Label: { defaultValue: "Save" },             // a known one → re-defaults
    Icon: { name: "Leading" },                   //             → renames
    Legacy: null,                                //             → deletes
  },
});
```

- **Adding requires `defaultValue`**: an edit binds nothing in the same call, so nothing can derive it. Bind a layer next (below).
- **A new `slot` can't be declared here**: insert a bound frame instead (below).
- **Re-defaulting** reaches every instance still on the old default; one that stated its own value keeps it. **Renaming** re-suffixes the property and re-points every bound layer. **Deleting** frees the layers it drove.
- **A type can't change** (Figma has no such call): delete and re-declare.
- **A variant axis is not a definition.** A set's axes ARE its members' names, so rename the member components; a `propertyDefinitions` edit aimed at a variant is refused pointing at the set.

### Binding a layer — `componentPropertyReferences` under edit

The compiler's word on a live sublayer of a component; `null` unbinds a field, which keeps its value.

```js
await flcm.edit(comp, { propertyDefinitions: { Heading: { type: "text", defaultValue: "Untitled" } } });
await flcm.edit(titleId, { componentPropertyReferences: { text: "Heading" } });   // the property drives it now
await flcm.edit(titleId, { componentPropertyReferences: { visible: null } });     // unbind
```

- The node must be inside a COMPONENT or a set's variant: inside an INSTANCE it is refused naming the instance, and outside any component there is no property to point at.
- Field legality is the compiler's, read off the live node's type. Bare names resolve to Figma's suffixed ones when unambiguous.
- **Unbinding the only frame of a slot property is refused**: delete the property (`{ Name: null }`), which frees the frame. In a SET the count is per VARIANT; a sibling variant's frame is no spare.
- An `editMany` batch can't mix a definition edit with an entry that depends on it (binding to a name it renames, or setting that property on an INSTANCE): refused naming both, so use two calls.

### Inserting a bound layer

`append`/`prepend`/`insertBefore`/`insertAfter` into a component or its sublayers accept a plain node spec carrying `componentPropertyReferences`.

```js
await flcm.append(comp, { type: "TEXT", text: "Sub", componentPropertyReferences: { text: "Label" } });
await flcm.append(comp, { type: "FRAME", width: 240, height: 80, componentPropertyReferences: { slot: "Content" } });
```

Every name must already be declared, except a `slot` naming a property that doesn't exist, which **declares it**; naming one that already has its frame is refused. Into a set's VARIANT, a new `slot` declares the property on the SET and this variant realizes it; the others insert their own bound frame. An insert into the COMPONENT_SET itself is refused: its children are its variants.

### Using one — `INSTANCE`

Create an instance with `{ type: "INSTANCE", componentId: componentTarget }`. A COMPONENT_SET target selects its variant using componentProperties, or uses its default. A library component already used in the file can be addressed by its read componentId.

componentProperties maps property names to values. overrides maps component-relative sublayer paths to edit deltas. An omitted prop follows its component. Root appearance and layout props are overrides too.

Slot content is plain specs in `overrides[path].children`. Each id moves and edits, each missing id creates, and unmentioned content remains. Use remove on content nodes for deletion. Bindings in slot content need a declaring component and are refused otherwise.

### Changing an instance

No separate variant or swap verb: **an instance changes through `flcm.edit`, in the words `get` reports on it.**

```js
await flcm.edit(inst, { componentProperties: { Size: "Large", Label: "Save" } }); // variant + a text property
await flcm.edit(inst, { overrides: { "11:9": { fill: "#F00" } }, width: 240 });   // a sublayer, and a root word
await flcm.edit(inst, { componentId: other.id });                                 // swap the component
```

- **A frame's words** are root-level overrides, including the layout gates, which read the live mode.
- **`componentProperties`** resolve against the component the instance is on now. An unnamed axis keeps its value: `{ State: "Hover" }` on `Size=Large` selects `Size=Large, State=Hover`. The instance keeps its id; its sublayer ids become the new variant's.
- **`overrides`** edit the live sublayers `I<instanceId>;<path>` (`find({ within: inst })` locates them; `flcm.edit` on one is the same write), so a text delta resolves against the font that sublayer really has.
- **`componentId`** swaps to a COMPONENT, or a COMPONENT_SET (its default variant unless `componentProperties` in the same delta pick one). Figma carries across the overrides it can match; the rest fall back to the new component's values.

An instance root inherits its layout direction from its component. An edit may restate the matching `layout.mode`; a different direction is rejected before any writes. With a swap or variant change, the direction must match the incoming component. Edit the component or choose a matching variant to change direction.

Numeric `width` and `height` edits on inherited rectangles are rejected before any writes, including overrides used to create or retarget an instance. Change the component or choose a suitable variant. Use `width: "fill"` or `height: "fill"` when the auto-layout parent should size the rectangle. The instance root can still be resized.

**One delta, one order:** swap → properties → root words → overrides; override paths resolve against the incoming component.

### Breaking the link — `flcm.detach`

`await flcm.detach(target)` turns an instance into a FRAME with a **new id** holding new-id copies of the subtree, and returns its handle. One-way. A **nested** instance fails loud naming the enclosing one: Figma's detach would take every enclosing instance with it, so flcm makes you say so. Prefer overriding.

### Refused before the first write

On an instance, each of these resolves against the live component before the first write, so nothing is created or changed and the refusal names the component's real property names, variants and paths:

- an unknown property name, a wrong-typed value, or a variant combination the set lacks (selections are checked whole; the refusal lists those it has);
- a slot property in `componentProperties` (its content goes under `overrides`; the refusal names the path);
- an override path the resolved variant lacks (paths are per variant — a read of a sibling's doesn't apply), `children` at a non-slot path (listing the paths that are slots), a `null` where flcm has no removal word, or `componentProperties`/`overrides`/`componentId` inside an override entry.

## Seeing what you built (get_screenshot)

You cannot judge what you built from the code you wrote — hairlines, grain, glass, 1px strokes and missing glyphs all *look* fine in source. **Build → screenshot → look → fix.**

`get_screenshot` is a separate **MCP tool**, not an `flcm` verb (there is no `flcm.screenshot`). Keep the render result in `session` for later code calls; pass its id string to the screenshot tool.

```js
// call 1 — figma_execute_code
const out = await flcm.render(card);
return out;
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
const live = await figma.getNodeByIdAsync(out.node.id);                 // drop out for document ops
figma.viewport.scrollAndZoomIntoView([live]);
return out.node.id;
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
- `boxShadow` / `textShadow`: `[inset] <x> <y> [<blur>] [<spread>] <color>`, comma-separated for multiple. Lengths are `Npx` or a bare `0`; the color is required (`currentColor` can't be resolved here).
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
| `left`/`top` | a number (px) or `"N%"` (percent of the parent axis); `anchor` sets which point of the node lands there. Naming either lifts a child out of an auto-layout flow |
| `textStyle.fontSize`, `rotation`, `opacity` | numbers |
| `textStyle.lineHeight`, `textStyle.letterSpacing` | number(px), `"Npx"`, `"N%"`, `"Nem"` (lineHeight also `"auto"`) |

## What fails loud

Accepting CSS is a fidelity promise, so the boundaries are strict. Each of these throws a specific error naming the offending value — never a guess, never a silent no-op:

| Situation | Why, and the fix |
| --- | --- |
| A color / gradient / effect outside the [CSS subset](#the-css-subset) | Parse error naming the value. |
| An `flcm.image` source that is unfetchable, blocked (private/loopback), outside the server's asset root, oversize, or not an image | Rejected server-side with the reason, never a blank fill. |
| An `TEXT` value that is neither a string nor a runs array, or text carrying read style-ref tokens (`{ts1}…{/ts1}`) | Those are read artifacts. Author styled text as markdown or runs. `**` in a plain string is markdown — backslash-escape for a literal. |
| `![alt](url)` in a text string, or an unrealizable `fontStyle`/`textDecoration` (`"oblique"`, `"overline"`) | Text can't embed an image (`flcm.image`); the enum names the supported set. |
| A duplicate `key` in one render | Keys are unique per render. |
| A node `type` outside FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR | Those are the only createable types. |
| A `scale` on a path that isn't a positive number | `scale` exists so art can't stretch; zero or a negative would collapse or mirror it. (`width`/`height` beside `d` are not a refusal — they're ignored with a warning.) |
| Unparseable SVG markup, or bad path `d` data | Never a silent blank node. |
| Returning a live Figma node | Return the id string or a handle. |
| A bad `pin` or `anchor` value, or `anchor` on an axis without its `left`/`top` | Names the value and the allowed set. |
| A percent `width`/`height` on an in-flow child of a parent that hugs that axis, or a percent/`"fill"` on the root | A genuine cycle (and the page is unbounded). Give the parent a fixed or `"fill"` size, or lift the child out of the flow with `left`/`top`. |
| An unknown `mixBlendMode` | Names the value and the supported set. |
| `layout.justifyContent`/`alignItems` Figma can't realize — `"space-around"`, `"space-evenly"` | Use `"space-between"` or `gap`/`padding`. Never faked with spacer nodes, which read as content. |
| `textStyle.lineClamp` on a width-hugging text | Truncation needs a width to wrap against. Set `width` to a number, `"fill"`, or `"N%"`. |
| A layout word the node can't realize — a fixed/`"hug"`/percent `height` on TEXT, `"hug"` with nothing to measure, or container words without `layout.mode` | The same rules govern create and edit alike, so a word that wouldn't land names the fix instead. |

An `imageRef` identifies an existing image in this file and can be reused, for example `{ type: "RECTANGLE", fill: { type: "IMAGE", imageRef } }`.

Variables and prototype interactions are deliberately **out of v1** — read concepts with no create path. They're rejected loudly so you never half-write something unrealizable. (Components have one: `INSTANCE` — see the components section.)

### The one silent exception: unrenderable glyphs

Everything above fails loud. One case can't, because the plugin API exposes no glyph-coverage check: **a character the resolved font can't render draws as nothing** — no glyph, no tofu, no error. This bites emoji and private-use codepoints (SF Symbols) in fonts like Inter. If text renders blank, suspect a missing glyph first and switch to a font that covers it. Treat unusual codepoints with suspicion until you've seen a screenshot.

## Worked examples

### The login screen

A gradient background, an out-of-flow radial-glow decoration declared first (so it sits behind), a frosted card whose shadow and blur are plain CSS strings, fixed and "fill" sizing, rgba/hex solids, numeric font weights, and child identities returned in the authored tree.

```js
const fields = [
    { key: "email", label: "Email", placeholder: "you@example.com" },
    { key: "password", label: "Password", placeholder: "••••••••" },
].map(({ key, label, placeholder }) => ({
    type: "FRAME",
    key,
    layout: { mode: "column", gap: 6 },
    width: "fill",
    children: [
        {
            type: "TEXT",
            text: label,
            textStyle: { fontSize: 13, fontWeight: 500 },
            fill: "rgba(255,255,255,0.7)",
        },
        {
            type: "FRAME",
            layout: { mode: "row", alignItems: "center", padding: { x: 16 } },
            width: "fill",
            height: 48,
            borderRadius: 12,
            fill: "rgba(255,255,255,0.06)",
            stroke: "rgba(255,255,255,0.12)",
            strokeWidth: 1,
            children: [
                {
                    type: "TEXT",
                    text: placeholder,
                    textStyle: { fontSize: 15 },
                    fill: "rgba(255,255,255,0.4)",
                },
            ],
        },
    ],
}));
const screen = {
    type: "FRAME",
    key: "login",
    name: "Login",
    layout: { mode: "column", gap: 28, padding: 32 },
    width: 390,
    height: 844,
    fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)",
    children: [
        // Declared first → sits behind everything. `left`/`top` lift it out of the column flow.
        {
            type: "ELLIPSE",
            name: "Glow",
            left: -80,
            top: -60,
            width: 180,
            height: 180,
            fill: "radial-gradient(circle, #2A3A66 0%, #0B102000 70%)",
            opacity: 0.6,
        },
        {
            type: "TEXT",
            text: "Welcome back",
            key: "title",
            fill: "#FFFFFF",
            textStyle: { fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: "32px" },
        },
        {
            type: "FRAME",
            key: "card",
            name: "Card",
            layout: { mode: "column", gap: 16, padding: 28 },
            width: "fill",
            borderRadius: 20,
            fill: "rgba(255,255,255,0.04)",
            stroke: "rgba(255,255,255,0.08)",
            strokeWidth: 1,
            effects: { boxShadow: "0 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(8px)" },
            children: [
                ...fields,
                {
                    type: "FRAME",
                    key: "submit",
                    name: "Submit",
                    layout: { mode: "row", justifyContent: "center", alignItems: "center" },
                    width: "fill",
                    height: 48,
                    borderRadius: 12,
                    fill: "#6366F1",
                    children: [
                        {
                            type: "TEXT",
                            text: "Sign in",
                            textStyle: { fontSize: 15, fontWeight: 600 },
                            fill: "#FFFFFF",
                        },
                    ],
                },
            ],
        },
    ],
};
const out = await flcm.render(screen);
return {
    node: out.id, // the login frame's id
    card: out.children[2].id,
    title: out.children[1].text, // "Welcome back"
};
```

### A feed caption (rich text)

One `TEXT` node carrying three styled runs — a colored `@handle`, plain body copy, and a muted `more` — over shared base props, wrapped to a fixed width. Replaces four hand-split text nodes.

```js
// One text node, three styles: a colored @handle, plain body copy, a muted "more". The base props
// (size 15, a line height) apply to every run; each run overrides only what it changes.
const caption = {
    type: "TEXT",
    text: [
        ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
        " summited at golden hour — the whole valley lit up. ",
        ["more", { color: "#8E8E93" }],
    ],
    key: "caption",
    fill: "#111827",
    width: 340,
    textStyle: { fontSize: 15, lineHeight: "20px" },
};
const out = await flcm.render(caption);
return {
    caption: out.id,
    text: out.text,
};
```

### Grid tracks and cell placement

Columns are explicit and fractional, so the frame takes a fixed width; rows are omitted, so they are implicit hug tracks — as many as the children need, growing as more arrive. Children auto-place unless anchors or spans are supplied.

```js
const grid = await flcm.render({
    type: "FRAME",
    name: "Grid cards",
    width: 400,
    layout: {
        mode: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "12px 16px",
        padding: 16,
    },
    children: [
        // A double-wide banner, then tiles: the row count follows from the placement.
        {
            type: "RECTANGLE",
            width: "fill",
            height: 72,
            fill: "#6366F1",
            layout: { gridColumn: "span 2" },
        },
        { type: "RECTANGLE", width: "fill", height: 56, fill: "#14B8A6" },
        {
            type: "RECTANGLE",
            width: 40,
            height: 40,
            fill: "#F59E0B",
            layout: { justifySelf: "center", alignSelf: "end" },
        },
    ],
});
return (await flcm.get(grid)).node;
```

### Vector art (svg & path)

Both vector forms side by side, and how each is sized: a `d` triangle, which is bare geometry sized by `scale`, and an `svg` mark, which is art on a canvas sized by `width`/`height` and recolored through `fill`. No icon catalog — you bring the path data or markup.

```js
// A round "play" button showing both vector forms and how each is sized.
const player = {
    type: "FRAME",
    width: 96,
    height: 96,
    borderRadius: 48,
    fill: "#111827",
    children: [
        // `d` is bare geometry: this path is 32x36 because those are its own coordinates, and `scale`
        // is what makes it bigger. No width/height — they'd be a canvas the path doesn't have.
        {
            type: "VECTOR",
            key: "play",
            d: "M0 0 L32 18 L0 36 Z",
            fill: "#6366F1",
            scale: 1.5,
            left: 34,
            top: 24,
        },
        // `svg` is a canvas: the viewBox sets the coordinate space, width/height size it, and `fill`
        // repaints every vector inside — so the same markup serves every theme.
        {
            type: "VECTOR",
            svg: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#22C55E"/></svg>',
            fill: "#F9FAFB",
            width: 16,
            height: 16,
            left: 8,
            top: 8,
        },
    ],
};
const out = await flcm.render(player);
return { node: out.id, play: out.children[0].id };
```

### Images (real raster fills)

A feed post with a real photo as a frame fill and a circular avatar as an `ellipse` filled with an image. `flcm.image(url)` is a paint value, so any shape carries one; the server fetches the bytes. The photo takes a paint *stack* — a legibility scrim over the image, first entry on top — so the title sitting on it stays readable.

```js
// A feed post: a real photo as a frame fill, and a circular avatar as an ellipse filled with an image.
// flcm.image is a paint value — any shape carries one. The server fetches the bytes; your code doesn't.
const post = {
    type: "FRAME",
    layout: { mode: "column", gap: 8 },
    width: 390,
    children: [
        {
            // The photo carries TWO paints — a stack, first entry on top, the order a read returns. The
            // scrim darkens the bottom of the photo so the title over it stays legible at any exposure.
            type: "FRAME",
            width: 390,
            height: 260,
            fill: [
                flcm.gradient({ stops: ["rgba(0,0,0,0)", "rgba(0,0,0,0.65)"], angle: 180 }),
                flcm.image("https://example.com/photo.jpg"),
            ],
            children: [
                {
                    type: "TEXT",
                    text: "Ridgeline at golden hour",
                    textStyle: { fontSize: 20, fontWeight: "semibold" },
                    fill: "#FFFFFF",
                    left: 16,
                    top: 216,
                },
            ],
        },
        {
            type: "FRAME",
            layout: { mode: "row", gap: 8, padding: 12, alignItems: "center" },
            children: [
                {
                    type: "ELLIPSE",
                    width: 40,
                    height: 40,
                    fill: flcm.image("https://example.com/avatar.jpg", { scaleMode: "FILL" }),
                },
                { type: "TEXT", text: "@ridgeline", textStyle: { fontWeight: "semibold", fontSize: 14 } },
            ],
        },
    ],
};
const out = await flcm.render(post);
return out.id;
```

### Copying what's already on the canvas (get → plain data)

The read↔write seam: `flcm.get` reads a live subtree as the canonical shape, you edit that shape like any object. Keep ids to move, or drop them recursively to create a copy. A structural verb places a COPY. `flcm.clone` stays the faithful duplicate for subtrees a rebuild can't reproduce.

```js
const { node } = await flcm.get("caption");
// Keeping ids moves the nodes you read and edits their named props.
const moved = await flcm.append("sidebar", { ...node, width: 480 });
// This caption is one TEXT node. For a subtree, also drop ids on children and slot content you want copied.
const template = { ...node };
delete template.id;
const copy = await flcm.append("sidebar", { ...template, name: "Caption copy" });
// clone preserves live state that the data vocabulary cannot express.
const faithful = await flcm.clone(moved, "sidebar");
return { moved, copy, faithful };
```

### Authoring a component (flcm.component → flcm.variants)

A Button, authored then promoted to a COMPONENT in one call — a boolean, a text and a slot property, each bound to the node it drives, defaults derived from those nodes — then two sizes folded into a variant set.

```js
// Author a Button, then fold two sizes of it into a variant set. Each node a property drives says
// so with `componentPropertyReferences`.
const buildButton = (height) => ({
    type: "FRAME",
    name: "Button",
    height,
    layout: { mode: "row", gap: 8, padding: 12, alignItems: "center" },
    fill: "#111827",
    borderRadius: 8,
    children: [
        // A boolean property drives this dot's `visible`. Unnamed, `visible` derives to true, so
        // the definition states the false.
        {
            type: "ELLIPSE",
            width: 8,
            height: 8,
            fill: "#22C55E",
            componentPropertyReferences: { visible: "Show Dot" },
        },
        // A text property drives this content; its default derives from here ("Save").
        {
            type: "TEXT",
            text: "Save",
            key: "label",
            fill: "#FFFFFF",
            componentPropertyReferences: { text: "Label" },
        },
        // A slot property: this frame is the hole every instance fills.
        { type: "FRAME", width: 24, height: 24, componentPropertyReferences: { slot: "Trailing" } },
    ],
});
const definitions = {
    Label: { type: "text" },
    "Show Dot": { type: "boolean", defaultValue: false },
    Trailing: { type: "slot" },
};
const small = await flcm.component(buildButton(32), {
    name: "Button",
    description: "The primary action.",
    propertyDefinitions: definitions,
});
const large = await flcm.component(buildButton(44), {
    name: "Button",
    propertyDefinitions: definitions,
});
// Each entry says which member of the set its component IS; the axes are what an instance picks.
const set = await flcm.variants([
    { component: small, variant: { Size: "Small" } },
    { component: large, variant: { Size: "Large" } },
], { name: "Button" });
// The set carries its members' shared properties, so Label is set beside the axis.
await flcm.render({
    type: "INSTANCE",
    componentId: set,
    componentProperties: { Size: "Large", Label: "Publish" },
});
// Each returned child carries its live identity.
return { set: set.id, label: small.children[1].id };
```

### Instantiating a component (INSTANCE)

Buttons stamped from a set found by name: a variant picked by its axes, a bound label set through `componentProperties`, a sublayer overridden by path, and a read instance re-authored as-is.

```js
// A toolbar from the file's Button set. Read it first: the `components` sidecar lists its property
// names and sublayer paths, e.g. { Size: { type: "variant", variantOptions: [...] }, Label: { type: "text" } }.
const button = await flcm.findOne({ type: "COMPONENT_SET", name: "Button" });
const { components } = await flcm.get(button);
const toolbar = {
    type: "FRAME",
    key: "toolbar",
    layout: { mode: "row", gap: 8, padding: 12 },
    children: [
        // The variant is picked by its axes, as a whole combination.
        {
            type: "INSTANCE",
            componentId: button,
            key: "save",
            componentProperties: { Size: "Large", State: "Default", Label: "Save" },
        },
        // Plus a root-level override (width) and a sublayer override by component-relative path.
        {
            type: "INSTANCE",
            componentId: button,
            key: "cancel",
            width: 120,
            componentProperties: { Size: "Large", Label: "Cancel" },
            overrides: { "11:9": { fill: "#B91C1C" } },
        },
    ],
};
const out = await flcm.render(toolbar);
const { node: save } = await flcm.get(out.children[0]);
const copy = { ...save };
delete copy.id;
await flcm.append("toolbar", { ...copy, name: "Save (copy)" });
return { toolbar: out.id, definitions: Object.keys(components ?? {}) };
```
