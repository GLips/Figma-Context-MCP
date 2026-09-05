// An in-memory Figma mock faithful to the AXES the std-lib actually touches — so the harness can run
// the REAL preamble fragments (plugin/src/preamble/) in pure Node, no plugin and no WS port.
//
// It models: node creation, auto-parenting, auto-layout sizing (hug/fixed/fill with the cross-axis
// rule), fills/strokes/opacity, fontName/loadFontAsync/figma.mixed, getNodeByIdAsync, pluginData,
// createComponentFromNode -> createInstance with COMPOSITE-ID sublayers (I<inst>;<mainChild>), and
// findAll/findAllWithCriteria. It deliberately does NOT model real font metrics or rendering — text
// size is a crude char-count estimate — so pixel-exact layout still needs a live check (see README).

let __id = 0;
const nextId = (p) => (p || "") + ++__id + ":" + __id;

const registry = new Map(); // id -> node, for getNodeByIdAsync / composite-id resolution
const MIXED = Symbol("figma.mixed");
const __measuring = new Set(); // (node,dim) keys in-flight, to break the fill<->hug sizing recursion

const clonePaints = (p) => (Array.isArray(p) ? JSON.parse(JSON.stringify(p)) : p);

// The visual/layout props carried across clone (instance) and promote (createComponentFromNode).
const COPY_FIELDS = ["name", "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode",
  "counterAxisSizingMode", "layoutGrow", "layoutAlign", "layoutPositioning", "constraints", "strokeWeight",
  "cornerRadius", "opacity", "visible", "rotation", "characters", "fontSize", "textAutoResize",
  // x/y ride along because a live clone() preserves position: without them the mock can't show
  // that flcm.clone with no parent lands the copy exactly ON TOP of the original in a free-form
  // parent — real behavior that would otherwise be invisible here.
  "x", "y", "_fixedW", "_fixedH"];

// The node types that hold children (Figma's ChildrenMixin). See the constructor: only these get
// appendChild/insertChild, because a leaf node genuinely has neither.
const CONTAINER_TYPES = ["PAGE", "FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"];

// Every per-range styling bucket the setRange* recorders write — the set a `characters` write clears.
const RANGE_BUCKETS = ["_rangeFonts", "_rangeSizes", "_rangeFills", "_rangeLineHeights",
  "_rangeLetterSpacings", "_rangeDecorations", "_rangeHyperlinks", "_rangeCases",
  "_rangeParagraphSpacings", "_rangeParagraphIndents", "_rangeListSpacings"];

class Node {
  constructor(type) {
    this.id = nextId();
    this.type = type;
    this.name = type === "FRAME" ? "Frame" : type === "TEXT" ? "Text" : type;
    this.removed = false;
    this.parent = null;
    this.children = [];
    // auto-layout
    this.layoutMode = "NONE";
    this.itemSpacing = 0;
    this.paddingTop = this.paddingRight = this.paddingBottom = this.paddingLeft = 0;
    this.primaryAxisAlignItems = "MIN";
    this.counterAxisAlignItems = "MIN";
    this.primaryAxisSizingMode = "AUTO";
    this.counterAxisSizingMode = "AUTO";
    this.layoutGrow = 0;
    this.layoutAlign = "INHERIT";
    // appearance
    this.fills = [];
    this.strokes = [];
    this.strokeWeight = 1;
    this.cornerRadius = 0;
    this.opacity = 1;
    // Every live SceneNode (bar SLICE) carries a blendMode; the appliers' `"blendMode" in node`
    // guards key off its presence, so the mock must declare it like the live API does.
    this.blendMode = "NORMAL";
    this.visible = true;
    this.effects = [];
    this.rotation = 0;
    this.clipsContent = false;
    // position: x/y honored directly; layoutPositioning='ABSOLUTE' lifts a child out of an auto-layout
    // parent's flow (so x/y apply, it can overlap, and it's excluded from the parent's hug measurement).
    this.x = 0;
    this.y = 0;
    this.layoutPositioning = "AUTO";
    // Per-child pinning rules for how this node reflows when a FREE-FORM parent resizes. Figma's default is
    // MIN/MIN (pinned to the top-left); the bridge overwrites it for a free-form parent's child.
    this.constraints = { horizontal: "MIN", vertical: "MIN" };
    // text
    this.characters = "";
    this.fontName = { family: "Inter", style: "Regular" };
    this.fontSize = 12;
    this.textDecoration = "NONE";
    this.textAutoResize = "WIDTH_AND_HEIGHT";
    this.textAlignHorizontal = "LEFT";
    this.textAlignVertical = "TOP";
    this.textCase = "ORIGINAL";
    this.paragraphSpacing = 0;
    this.paragraphIndent = 0;
    this.listSpacing = 0;
    // geometry (explicit, from resize). Shapes get an intrinsic default size like the live API.
    this._fixedW = null;
    this._fixedH = null;
    if (type === "RECTANGLE" || type === "ELLIPSE" || type === "POLYGON" || type === "STAR") { this._fixedW = 100; this._fixedH = 100; }
    if (type === "LINE") { this._fixedW = 100; this._fixedH = 0; }
    if (type === "VECTOR") { this._fixedW = 24; this._fixedH = 24; this.vectorPaths = []; }
    // Only a ChildrenMixin node carries appendChild/insertChild — a live RectangleNode has
    // neither, and the structural verbs' container gate keys on exactly that, so a mock that
    // handed them to every node would let "append into a rect" pass here and fail in Figma.
    // Bound per instance (not on the prototype) because that presence IS the modelled fact.
    if (CONTAINER_TYPES.indexOf(type) !== -1) {
      this.appendChild = (child) => this._appendChild(child);
      this.insertChild = (index, child) => this._insertChild(index, child);
    }
    this._plugin = {};
    // prototyping reactions — the mock can't run present mode, but it STORES them so a scenario can
    // assert the right trigger/action/destination were wired (setReactionsAsync replaces, like live).
    this._reactions = [];
    registry.set(this.id, this);
  }

  get reactions() { return this._reactions; }
  async setReactionsAsync(reactions) { this._reactions = JSON.parse(JSON.stringify(reactions || [])); }

  get _isAuto() { return this.layoutMode === "HORIZONTAL" || this.layoutMode === "VERTICAL"; }

  _appendChild(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.push(child);
  }
  _insertChild(index, child) {
    // [directional — on the live checklist]: neither the typings nor the published docs define the
    // same-parent case, so this models the behavior Figma's UI shows rather than a cited contract.
    // When `child` is already in THIS parent, `index` is
    // interpreted against the PRE-removal array — Figma compensates for the node's own slot, so
    // insertChild(3, B@1) on [A,B,C,D] yields [A,C,B,D] (lands at 2), and insertChild(2, B@1) is a
    // no-op. A naive remove-then-splice-at-index (what this used to do) overshoots reorders by one and
    // does NOT reflect the real API. Cross-parent / new children get no adjustment.
    const had = child.parent === this ? this.children.indexOf(child) : -1;
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    const idx = had !== -1 && had < index ? index - 1 : index;
    this.children.splice(idx, 0, child);
  }
  // Duplicate this node and its subtree, parented under the current page — [verified,
  // plugin-typings 1.133: "Duplicates the node. By default, the duplicate will be parented under
  // figma.currentPage"], which is why flcm.clone always places the copy explicitly afterwards.
  // pluginData IS copied here: whether live clone() carries it is [directional] (the typings
  // don't say), and modelling the carrying case is what makes the flcm/key strip testable — if
  // live turns out not to copy, the strip is simply a no-op and the same test holds.
  clone() {
    const copy = cloneSubtree(this);
    figma.currentPage.appendChild(copy);
    return copy;
  }
  resize(w, h) { this._fixedW = w; this._fixedH = h; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
    this.removed = true;
  }

  setPluginData(k, v) { this._plugin[k] = String(v); }
  getPluginData(k) { return this._plugin[k] || ""; }

  // Rich-text per-range setters. The live API applies a style to characters [start, end); the mock just
  // records each range so a scenario can assert the runs landed (font/size/fills over the right slice).
  // A range whose font isn't first loaded throws live — the preamble preloads every run font, so we don't
  // model that rejection here; resolveFontStrict is what guards the unloaded case in the std-lib.
  _range(bucket, start, end, value) { (this[bucket] || (this[bucket] = [])).push({ start, end, value }); }

  // A `characters` write collapses the node to its LEADING run's style — VERIFIED live
  // 2026-08-08, twice: a full replacement re-uniforms (one distinct style across every char, not
  // figma.mixed), and the disambiguating bold-FIRST-span repro came back whole-node Bold — the
  // first run's style wins, not the base. Only the FONT collapse is live-verified: the other
  // range buckets are cleared without promoting their char-0 values (unverified — extend the
  // collapse if a scenario ever keys on post-write size/fill). Range styling exists after a
  // write only if the same edit re-applies runs, which is the bridge's order
  // (buildText/applyTextProps: characters, then setRange*).
  get characters() { return this._characters; }
  set characters(v) {
    if (this.type === "TEXT" && (this._rangeFonts || []).length && (this._characters || "").length) {
      let lead = this._fontName;
      for (const r of this._rangeFonts) if (r.start <= 0 && 0 < r.end) lead = r.value; // last range covering char 0 wins, like getRangeAllFontNames
      this._fontName = lead;
    }
    this._characters = v;
    for (const b of RANGE_BUCKETS) this[b] = [];
  }
  setRangeFontName(start, end, value) { this._range("_rangeFonts", start, end, value); }
  setRangeFontSize(start, end, value) { this._range("_rangeSizes", start, end, value); }
  setRangeFills(start, end, value) { this._range("_rangeFills", start, end, value); }
  setRangeLineHeight(start, end, value) { this._range("_rangeLineHeights", start, end, value); }
  setRangeLetterSpacing(start, end, value) { this._range("_rangeLetterSpacings", start, end, value); }
  setRangeTextDecoration(start, end, value) { this._range("_rangeDecorations", start, end, value); }
  setRangeHyperlink(start, end, value) { this._range("_rangeHyperlinks", start, end, value); }
  setRangeTextCase(start, end, value) { this._range("_rangeCases", start, end, value); }
  setRangeParagraphSpacing(start, end, value) { this._range("_rangeParagraphSpacings", start, end, value); }
  setRangeParagraphIndent(start, end, value) { this._range("_rangeParagraphIndents", start, end, value); }
  setRangeListSpacing(start, end, value) { this._range("_rangeListSpacings", start, end, value); }

  // Live Figma reports figma.mixed when the characters don't all share one font — recorded
  // setRangeFontName ranges that diverge from the base make this node mixed the same way. Writing
  // fontName is a whole-node font reset live (every range takes the new font), so the setter wipes
  // the per-range variation — and so does a `characters` write (see the characters setter above).
  get fontName() {
    if (this.type === "TEXT" && (this._rangeFonts || []).length && this.characters.length) {
      const fonts = this.getRangeAllFontNames(0, this.characters.length);
      if (fonts.length > 1) return MIXED;
      if (fonts.length === 1) return fonts[0];
    }
    return this._fontName;
  }
  set fontName(v) { this._fontName = v; this._rangeFonts = []; }

  // Every distinct font over [start, end) — resolved from the recorded ranges the same way
  // getStyledTextSegments does (last range covering the char wins, base fontName otherwise).
  // Edit's TEXT preload walks this when fontName is figma.mixed.
  getRangeAllFontNames(start, end) {
    const names = [];
    const seen = new Set();
    for (let i = start; i < end; i++) {
      let f = this._fontName;
      for (const r of this._rangeFonts || []) if (r.start <= i && i < r.end) f = r.value;
      const key = f.family + "|" + f.style;
      if (!seen.has(key)) { seen.add(key); names.push(f); }
    }
    return names;
  }

  // --- read-path surface (what sceneNodeToSnapshot consumes) ---

  get absoluteBoundingBox() {
    let x = this.x, y = this.y;
    for (let p = this.parent; p && p.type !== "PAGE"; p = p.parent) { x += p.x; y += p.y; }
    return { x, y, width: this.width, height: this.height };
  }

  // The live API's derived sizing words, reconstructed from the mock's sizing model: FILL when the
  // parent's auto-layout stretches this child on the axis, else the node's own FIXED/HUG.
  get layoutSizingHorizontal() { return this._layoutSizing("w"); }
  get layoutSizingVertical() { return this._layoutSizing("h"); }
  _layoutSizing(dim) {
    if (this.parent && this.parent._isAuto && this.layoutPositioning !== "ABSOLUTE") {
      const primary = (dim === "w") === (this.parent.layoutMode === "HORIZONTAL");
      if (primary ? this.layoutGrow === 1 : this.layoutAlign === "STRETCH") return "FILL";
    }
    if (this._isAuto) {
      const primary = (dim === "w") === (this.layoutMode === "HORIZONTAL");
      const mode = primary ? this.primaryAxisSizingMode : this.counterAxisSizingMode;
      return mode === "FIXED" ? "FIXED" : "HUG";
    }
    if (this.type === "TEXT") {
      if (this.textAutoResize === "WIDTH_AND_HEIGHT") return "HUG";
      if (this.textAutoResize === "HEIGHT") return dim === "w" ? "FIXED" : "HUG";
      return "FIXED";
    }
    return "FIXED";
  }

  async getMainComponentAsync() { return this.mainComponent || null; }

  // Resolved styled segments, live-shaped: per-character effective style (base node value, overridden
  // by the LAST recorded setRange* covering the character — matching apply order), merged into runs of
  // equal style. Only the axes the mock models are emitted; sparse segments are within the adapter's
  // contract (it reads present keys only).
  getStyledTextSegments() {
    const chars = this.characters;
    const at = (bucket, i, base) => {
      let v = base;
      for (const r of this[bucket] || []) if (r.start <= i && i < r.end) v = r.value;
      return v;
    };
    const styleAt = (i) => {
      const fontName = at("_rangeFonts", i, this._fontName);
      const seg = {
        fontName,
        fontWeight: weightOfStyle(fontName.style),
        fontStyle: /\bItalic\b/.test(fontName.style) ? "ITALIC" : "REGULAR",
        fontSize: at("_rangeSizes", i, this.fontSize),
        textDecoration: at("_rangeDecorations", i, this.textDecoration),
        textCase: at("_rangeCases", i, this.textCase),
        paragraphSpacing: at("_rangeParagraphSpacings", i, this.paragraphSpacing),
        paragraphIndent: at("_rangeParagraphIndents", i, this.paragraphIndent),
        listSpacing: at("_rangeListSpacings", i, this.listSpacing),
        fills: at("_rangeFills", i, this.fills),
      };
      const lineHeight = at("_rangeLineHeights", i, this.lineHeight);
      if (lineHeight !== undefined) seg.lineHeight = lineHeight;
      const letterSpacing = at("_rangeLetterSpacings", i, this.letterSpacing);
      if (letterSpacing !== undefined) seg.letterSpacing = letterSpacing;
      const hyperlink = at("_rangeHyperlinks", i, null);
      if (hyperlink) seg.hyperlink = hyperlink;
      return seg;
    };
    const runs = [];
    for (let i = 0; i < chars.length; i++) {
      const style = styleAt(i);
      const prev = runs[runs.length - 1];
      if (prev && JSON.stringify(prev.style) === JSON.stringify(style)) prev.characters += chars[i];
      else runs.push({ characters: chars[i], style });
    }
    return runs.map(({ characters, style }) => ({ characters, ...style }));
  }

  findAll(pred) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (!pred || pred(c)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  findOne(pred) {
    let hit = null;
    const walk = (n) => n.children.forEach((c) => { if (hit) return; if (pred(c)) { hit = c; return; } walk(c); });
    walk(this);
    return hit;
  }
  findAllWithCriteria(opts) {
    const types = (opts && opts.types) || [];
    return this.findAll((n) => types.indexOf(n.type) !== -1);
  }

  // --- sizing: width/height as getters so reads during a run reflect current state ---
  get width() { return this._sizeOf("w"); }
  get height() { return this._sizeOf("h"); }

  // The sizing resolver is mutually recursive (child fills against parent, parent hugs from children),
  // and a w:'fill' text inside a w:'fill' row can drive it in a cycle. Guard re-entry per (node,dim):
  // the second time we ask for a value already being computed on the stack, break with 0.01 instead of
  // overflowing. (Live Figma renders these fine; this is purely the mock's measurement model.)
  _sizeOf(dim) {
    const key = this.id + "|" + dim;
    if (__measuring.has(key)) return 0.01;
    __measuring.add(key);
    try { return this._measure(dim); } finally { __measuring.delete(key); }
  }

  _measure(dim) {
    // 1. fill against an auto-layout parent (only against a RESOLVED, non-hug parent dimension)
    if (this.parent && this.parent._isAuto) {
      const f = this.parent._fillSizeFor(this, dim);
      if (f != null) return Math.max(f, 0.01);
    }
    // 2. own auto-layout: fixed axis -> resized value; auto axis -> hug content
    if (this._isAuto) {
      const isRow = this.layoutMode === "HORIZONTAL";
      const isPrimary = (dim === "w") === isRow;
      const mode = isPrimary ? this.primaryAxisSizingMode : this.counterAxisSizingMode;
      if (mode === "FIXED") return (dim === "w" ? this._fixedW : this._fixedH) ?? this._hug(dim);
      return this._hug(dim);
    }
    // 3. leaf
    if (this.type === "TEXT") return dim === "w" ? this._textW() : this._textH();
    return (dim === "w" ? this._fixedW : this._fixedH) ?? 0.01;
  }

  _padW() { return (this.paddingLeft || 0) + (this.paddingRight || 0); }
  _padH() { return (this.paddingTop || 0) + (this.paddingBottom || 0); }

  _hug(dim) {
    const isRow = this.layoutMode === "HORIZONTAL";
    const dimIsPrimary = (dim === "w") === isRow;
    const pad = dim === "w" ? this._padW() : this._padH();
    // Absolutely-positioned children are out of the flow — they don't contribute to the parent's hug.
    const flow = this.children.filter((k) => k.layoutPositioning !== "ABSOLUTE");
    if (dimIsPrimary) {
      let sum = 0;
      for (const k of flow) sum += k._sizeOf(dim);
      sum += Math.max(0, flow.length - 1) * (this.itemSpacing || 0);
      return sum + pad;
    }
    let mx = 0;
    for (const k of flow) mx = Math.max(mx, k._sizeOf(dim));
    return mx + pad;
  }

  _fillSizeFor(child, dim) {
    const isRow = this.layoutMode === "HORIZONTAL";
    const dimIsParentPrimary = (dim === "w") === isRow;
    const parentMode = dimIsParentPrimary ? this.primaryAxisSizingMode : this.counterAxisSizingMode;
    // Only fill against a parent dimension that is itself resolved (FIXED, or filling its own parent);
    // filling against a hugging axis would be circular, so fall through to the child's own size.
    const resolved = parentMode === "FIXED" || (this.parent && this.parent._isAuto && this.parent._fillSizeFor(this, dim) != null);
    if (!resolved) return null;
    const wantsFill = dimIsParentPrimary ? child.layoutGrow === 1 : child.layoutAlign === "STRETCH";
    if (!wantsFill) return null;
    return this._sizeOf(dim) - (dim === "w" ? this._padW() : this._padH());
  }

  _textW() {
    if (this.textAutoResize === "HEIGHT" && this._fixedW != null) return this._fixedW; // wrapping, fixed width
    return Math.max(1, this.characters.length) * this.fontSize * 0.55; // crude estimate (NOT real metrics)
  }
  _textH() {
    if (this.textAutoResize === "HEIGHT" && this._fixedW != null) {
      const perLine = Math.max(1, Math.floor(this._fixedW / (this.fontSize * 0.55)));
      return Math.ceil(this.characters.length / perLine) * this.fontSize * 1.3;
    }
    return this.fontSize * 1.3;
  }

  // --- component / instance ---
  createInstance() {
    if (this.type !== "COMPONENT") throw new Error("createInstance: not a COMPONENT");
    const instId = nextId("i");
    const root = cloneInto(this, instId, true);
    root.type = "INSTANCE";
    root.mainComponent = this;
    figma.currentPage.appendChild(root);
    return root;
  }
  get overrides() { return this._overrides || []; }
}

// A free-standing duplicate of a subtree (Node.clone): fresh ids, its own copies of the mutable
// bags, and its own pluginData — nothing aliases the original. Distinct from cloneInto below,
// which mints INSTANCE sublayers under the composite-id scheme.
function cloneSubtree(src) {
  const n = new Node(src.type);
  for (const k of COPY_FIELDS) n[k] = src[k];
  n.fills = clonePaints(src.fills);
  n.strokes = clonePaints(src.strokes);
  n.effects = clonePaints(src.effects);
  n.constraints = { ...src.constraints };
  n._fontName = JSON.parse(JSON.stringify(src._fontName));
  n._rangeFonts = JSON.parse(JSON.stringify(src._rangeFonts || []));
  n._plugin = { ...src._plugin };
  // A copied INSTANCE keeps pointing at the same main component, as live clone() does.
  n.mainComponent = src.mainComponent;
  for (const c of src.children) { const cc = cloneSubtree(c); cc.parent = n; n.children.push(cc); }
  return n;
}

// Clone a main subtree into instance sublayers. The root gets a fresh id; descendants get the
// deterministic composite id I<instId>;<mainChildId> — exactly the format the live API uses and the
// std-lib's override() builds. Every cloned node is registered so getNodeByIdAsync resolves it.
function cloneInto(mainNode, instId, isRoot) {
  const n = new Node(mainNode.type);
  registry.delete(n.id); // re-key below
  n.id = isRoot ? instId : "I" + instId + ";" + mainNode.id;
  registry.set(n.id, n);
  for (const k of COPY_FIELDS) n[k] = mainNode[k];
  n.fills = clonePaints(mainNode.fills);
  n.strokes = clonePaints(mainNode.strokes);
  n.effects = clonePaints(mainNode.effects);
  n.fontName = JSON.parse(JSON.stringify(mainNode._fontName));
  n._rangeFonts = JSON.parse(JSON.stringify(mainNode._rangeFonts || []));
  n.children = [];
  for (const c of mainNode.children) { const cc = cloneInto(c, instId, false); cc.parent = n; n.children.push(cc); }
  return n;
}

export function createFigmaMock() {
  __id = 0;
  registry.clear();
  const page = new Node("PAGE");
  page.name = "Page 1";
  registry.delete(page.id); page.id = "0:1"; registry.set(page.id, page);
  // The user's current selection — what flcm.selection() reads. A plain array a scenario sets directly
  // (figma.currentPage.selection = [node, …]); empty by default, like a fresh page.
  page.selection = [];
  // Under `documentAccess: dynamic-page` a PageNode must be loadAsync'd before exportAsync reads it.
  // The current page is always loaded in live Figma, so this resolves immediately — it exists so a
  // caller that correctly awaits it isn't punished by the mock for doing the right thing.
  page.loadAsync = async () => {};

  const figma = {
    mixed: MIXED,
    currentPage: page,
    root: { children: [page], setPluginData: (k, v) => page.setPluginData(k, v), getPluginData: (k) => page.getPluginData(k) },
    // Undo API: RECORDED, not emulated — real history semantics are the live probe's to ground
    // (scripts/probe-commit-undo.mjs). Tests assert the SEQUENCE of calls the verb scaffold makes
    // (entry seal / success commit / failure commit+trigger), never that anything reverts.
    undoLog: [],
    commitUndo() { this.undoLog.push("commit"); },
    triggerUndo() { this.undoLog.push("trigger"); },
    createFrame() { return new Node("FRAME"); },
    // Live createText seeds a default black fill — buildText's present-empty fills clear ("none")
    // only means something against it.
    createText() {
      const t = new Node("TEXT");
      t.fontName = { family: "Inter", style: "Regular" };
      t.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      return t;
    },
    createComponent() { return new Node("COMPONENT"); },
    createSlice() { return new Node("SLICE"); },
    createRectangle() { return new Node("RECTANGLE"); },
    createEllipse() { return new Node("ELLIPSE"); },
    // Live createLine seeds a default black stroke (like createVector below) — model it so a
    // stroke:"none" line that fails to write the clear shows up stroked here, not falsely bare.
    createLine() { const l = new Node("LINE"); l.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }]; return l; },
    createPolygon() { const p = new Node("POLYGON"); p.pointCount = 3; return p; },
    createStar() { const s = new Node("STAR"); s.pointCount = 5; s.innerRadius = 0.5; return s; },
    // Live Figma seeds a new vector with a default black 1px stroke (createRectangle/Ellipse get none).
    // Replicate it so the mock can catch a fill-only path that fails to clear it — otherwise mock-green
    // hides a real unauthored-outline defect (the render side must actively strip this default).
    createVector() { const v = new Node("VECTOR"); v.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }]; return v; },
    // Model createNodeFromSvg faithfully to the axes the bridge touches: it returns a FRAME (so it inherits
    // clipsContent) carrying the parsed vectors as children. We don't parse the markup; we produce a frame
    // with one vector child so a scenario can assert the frame type, the clip default, and a child landed.
    // Empty/garbage markup that a real parser would reject isn't modeled here — the bridge's try/catch is
    // what surfaces the live parser's throw; the mock just records the source.
    createNodeFromSvg(markup) {
      const f = new Node("FRAME");
      f.name = "svg";
      f._svgSource = String(markup == null ? "" : markup);
      const child = new Node("VECTOR");
      child.parent = f;
      f.children.push(child);
      return f;
    },
    createImage(bytes) { return { hash: "img" + (bytes && bytes.length ? bytes.length : 0) + ":" + ++__id }; },
    base64Decode(b64) { return Uint8Array.from(Buffer.from(String(b64), "base64")); },
    createComponentFromNode(node) {
      // Mirror the live API: produce a NEW COMPONENT node, move the frame's children onto it, replace
      // the frame in its parent, and remove the old frame. (In-place mutation would leave the old
      // frame on the page and falsely trip the no-fill-root warning — live replaces the node.)
      const comp = new Node("COMPONENT");
      for (const k of COPY_FIELDS) comp[k] = node[k];
      comp.fills = clonePaints(node.fills);
      comp.strokes = clonePaints(node.strokes);
      comp.effects = clonePaints(node.effects);
      comp.children = node.children;
      comp.children.forEach((c) => (c.parent = comp));
      comp.key = "k" + Math.abs(hashStr(node.id)).toString(16).padStart(40, "0").slice(0, 40);
      comp.remote = false;
      comp.componentPropertyDefinitions = {};
      const parent = node.parent;
      if (parent) {
        const i = parent.children.indexOf(node);
        if (i >= 0) parent.children[i] = comp;
        comp.parent = parent;
      }
      node.children = [];
      node.parent = null;
      node.removed = true;
      return comp;
    },
    // No sync getNodeById, deliberately: the manifest declares `documentAccess: dynamic-page`, under which
    // the live API throws on it. Omitting it from the mock is what keeps that enforced — a call site that
    // regresses to the sync form fails here instead of only in a real Figma file.
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    // The mock models no shared styles — nodes never carry a fill/text/effectStyleId, so the read
    // path's resolver treats every lookup as unresolvable (dropping the slot, like live).
    async getStyleByIdAsync() { return null; },
    // RECORDED like undo: tests assert a font was preloaded before a size write, not that Figma
    // would have refused without it (that rejection is live behavior, grounded by probe).
    fontLoads: [],
    loadFontAsync(font) { this.fontLoads.push(font); return Promise.resolve(); },
    // The bundled-Inter weight ladder the real API exposes, so fonts.ts's nearest-style snap has a
    // realistic family to match against (numeric weights resolve to Thin..Black, not just 4 buckets).
    // Both the upright and italic ladders are exposed so italic resolution (author `fontStyle`,
    // markdown `*…*`) has a real italic variant to snap to — Inter's regular italic is named "Italic"
    // (not "Regular Italic"), matching the live family.
    listAvailableFontsAsync() {
      const weights = ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"];
      const styles = weights.concat(weights.map((w) => (w === "Regular" ? "Italic" : w + " Italic")));
      return Promise.resolve(styles.map((style) => ({ fontName: { family: "Inter", style } })));
    },
    base64Encode() { return ""; },
  };
  globalThis.figma = figma;
  return figma;
}

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// Style name -> numeric weight, the inverse of the Inter ladder listAvailableFontsAsync exposes — so a
// resolved segment carries the fontWeight the live API would report for the snapped style.
const STYLE_WEIGHTS = { "Thin": 100, "Extra Light": 200, "Light": 300, "Regular": 400, "Medium": 500,
  "Semi Bold": 600, "Bold": 700, "Extra Bold": 800, "Black": 900 };
function weightOfStyle(style) {
  const upright = style === "Italic" ? "Regular" : style.replace(/ Italic$/, "");
  return STYLE_WEIGHTS[upright] ?? 400;
}
