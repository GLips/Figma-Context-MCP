// css — THE string boundary. This is the ONLY module that knows CSS string syntax exists. Authors write
// CSS-shaped leaves (a #hex/rgba() color, a "linear-gradient(...)" string, a "32px"/"-0.02em" metric)
// and a future `get` result is a SimplifiedNode of CSS strings; every one is parsed HERE, exactly once,
// into the typed currency (ir.ts). Nothing above this file touches a string leaf — the sugar (flcm.ts)
// calls these to normalize author input, the bridge never imports this module at all.
//
// Each parser FAILS LOUD outside its documented subset rather than emitting silently-wrong pixels —
// fidelity is the whole risk of accepting CSS-shaped input, so the edges are strict.

import {
  PaintSpec, ImageHashSpec, ImageScaleMode, GradientType, GradientStop, Rgba,
  EffectSpec, WriteLineHeight, WriteLetterSpacing, Edges,
  FillLeaf, WriteGradientFill, WriteCssEffects, WriteBlendMode,
} from "./ir.js";
import { solid, linearGradient, radialGradient } from "./paint.js";
import { shadow, layerBlurFromCssPx, backgroundBlurFromCssPx } from "./effects.js";

// FillInput / WriteGradientFill / WriteCssEffects moved to ir.ts (the figma-free type hub) so the schema
// module can source them without importing this module's parsers. parseFill/parseCssEffects below still
// own the runtime normalization of all three input shapes into the typed currency.

// ---- Colors ----
// #hex (read emits these when alpha is 1) or rgba() (whenever alpha < 1). Alpha rides on the parsed
// Rgba.a and the paint layer maps it to a solid's opacity.
function parseHex(input: string): Rgba {
  let h = input.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + "ff";
  else if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  else if (h.length === 6) h = h + "ff";
  else if (h.length !== 8) throw new Error('bad hex color "' + input + '": use #rgb, #rrggbb, #rgba, or #rrggbbaa.');
  if (!/^[0-9a-fA-F]{8}$/.test(h)) throw new Error('bad hex color "' + input + '": contains non-hex characters.');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: parseInt(h.slice(6, 8), 16) / 255,
  };
}

// rgb()/rgba(): channels 0-255, optional alpha 0-1. Comma OR whitespace/slash separators are both legal
// CSS (`rgb(255 0 0 / 0.5)`). Percent channels are outside the documented subset and throw.
function parseRgb(input: string): Rgba {
  const inner = input.slice(input.indexOf("(") + 1, input.lastIndexOf(")"));
  const parts = inner.split(/[\s,\/]+/).filter((p) => p.length);
  if (parts.length < 3 || parts.length > 4) throw new Error('bad color "' + input + '": rgb()/rgba() needs 3 channels and an optional alpha.');
  if (parts.some((p) => p.indexOf("%") !== -1)) throw new Error('bad color "' + input + '": percent channels are outside the supported subset — use 0-255 numbers.');
  const ch = parts.slice(0, 3).map((p) => {
    const n = Number(p);
    if (!isFinite(n) || n < 0 || n > 255) throw new Error('bad color "' + input + '": channel "' + p + '" must be 0-255.');
    return n / 255;
  });
  const a = parts.length === 4 ? Number(parts[3]) : 1;
  if (!isFinite(a) || a < 0 || a > 1) throw new Error('bad color "' + input + '": alpha must be 0-1.');
  return { r: ch[0], g: ch[1], b: ch[2], a };
}

// The one entry every author color string flows through: #hex (any length) or rgb()/rgba().
export function parseColor(input: string): Rgba {
  const s = String(input).trim();
  return s.indexOf("rgb") === 0 ? parseRgb(s) : parseHex(s);
}

// ---- Fills (color string | gradient string | read-form { type, gradient }) -> PaintSpec ----
// Takes ONE leaf. The read shape's array spelling is unwrapped upstream (flcm.compilePaintWord),
// where the stacked-paints refusal lives — a parser that also un-nested would have to own that rule.
export function parseFill(value: FillLeaf, field: string): PaintSpec {
  if (value && typeof value === "object") {
    if ("kind" in value) return value; // already a typed PaintSpec (what flcm.gradient() returns)
    if (isImageFill(value)) return readImagePaint(value, field);
    const g = value as WriteGradientFill;
    if (typeof g.gradient === "string" && typeof g.type === "string" && g.type.indexOf("GRADIENT_") === 0) {
      return parseGradientString(g.gradient);
    }
    throw badFill(field, value);
  }
  if (typeof value !== "string") throw badFill(field, value);
  const css = value.trim();
  return /^[a-z-]+-gradient\s*\(/i.test(css) ? parseGradientString(css) : solid(parseColor(css));
}

function badFill(field: string, value: unknown): Error {
  return new Error("flcm: " + field + " must be a color string, a gradient string (linear-gradient(...) / radial-gradient(...)), or a gradient leaf { type, gradient }. Got " + JSON.stringify(value) + ".");
}

// A read-form image fill (the read shape's SimplifiedImageFill: { type:'IMAGE', imageRef|gifRef,
// scaleMode }) names bytes ALREADY IN THE DOCUMENT, so in-plugin it needs no fetch and no url — the
// imageRef IS the paint's imageHash [verified: node-to-snapshot maps `ref: paint.imageHash`]. It is
// distinct from an AUTHORED image, which arrives as a typed ImageSpec ({ kind:'image', url }) and
// returns early above via the `"kind" in value` path, never reaching here. `type:'IMAGE'` is the
// always-present discriminator; the ref itself can be missing (Figma returns a null imageRef for an
// asset that lives in a file you don't own), and THAT case still has nothing to point at.
function isImageFill(value: object): boolean {
  const o = value as Record<string, unknown>;
  return o.type === "IMAGE" || typeof o.imageRef === "string" || typeof o.gifRef === "string";
}

// The read shape's scale-mode words → the plugin's. "STRETCH" is REST's spelling of the plugin's CROP
// (node-to-snapshot maps it on the way out), and it is the one mode that CANNOT come back: the crop is
// carried by the paint's imageTransform matrix, which the read shape never surfaces, so rebuilding it
// would silently un-crop the image. Refused by name below rather than reproduced wrong.
const READ_SCALE_MODES: Record<string, ImageScaleMode> = { FILL: "FILL", FIT: "FIT", TILE: "TILE" };

function readImagePaint(value: object, field: string): ImageHashSpec {
  const o = value as { imageRef?: unknown; gifRef?: unknown; scaleMode?: unknown; scalingFactor?: unknown };
  // An animated GIF carries BOTH refs, and its `imageRef` points at the static snapshot frame — so the
  // one path that looks like it works is exactly the one that silently strips the animation. There is no
  // hash to point a new paint at (the GIF's own bytes live behind gifRef, which is not an image hash).
  if (typeof o.gifRef === "string" && o.gifRef) {
    throw new Error(
      "flcm: " + field + " is an animated GIF fill, and its `imageRef` is only the static snapshot frame — rebuilding from it would drop the animation. Duplicate the node with flcm.clone to keep the GIF.",
    );
  }
  const hash = typeof o.imageRef === "string" && o.imageRef ? o.imageRef : undefined;
  if (!hash) {
    throw new Error(
      "flcm: " + field + " is an image fill with no imageRef — Figma reports a null ref for an asset that lives in a file you don't own, so there is nothing to point the new paint at (" +
        JSON.stringify(value) + "). Duplicate the node with flcm.clone instead, or author your own image with flcm.image(url).",
    );
  }
  const scaleMode = READ_SCALE_MODES[String(o.scaleMode)];
  if (!scaleMode) {
    throw new Error(
      "flcm: " + field + ' is a cropped image fill (scaleMode "' + String(o.scaleMode) + '"). The crop lives in the paint\'s transform matrix, which the read shape does not carry, so rebuilding it would silently un-crop the image. Duplicate the node with flcm.clone to keep the crop.',
    );
  }
  const spec: ImageHashSpec = { kind: "image", hash, scaleMode };
  if (scaleMode === "TILE" && typeof o.scalingFactor === "number") spec.scalingFactor = o.scalingFactor;
  return spec;
}

// ---- Blend mode (CSS mix-blend-mode name -> Figma BlendMode). Only the CSS-named modes are reachable;
// Figma's PASS_THROUGH / LINEAR_BURN / LINEAR_DODGE have no mix-blend-mode spelling and aren't offered.
// Case-insensitive (CSS keywords are). An unknown name FAILS LOUD, naming the supported set. ----
const BLEND_MODES: Record<string, WriteBlendMode> = {
  normal: "NORMAL",
  darken: "DARKEN",
  multiply: "MULTIPLY",
  "color-burn": "COLOR_BURN",
  lighten: "LIGHTEN",
  screen: "SCREEN",
  "color-dodge": "COLOR_DODGE",
  overlay: "OVERLAY",
  "soft-light": "SOFT_LIGHT",
  "hard-light": "HARD_LIGHT",
  difference: "DIFFERENCE",
  exclusion: "EXCLUSION",
  hue: "HUE",
  saturation: "SATURATION",
  color: "COLOR",
  luminosity: "LUMINOSITY",
};

export function parseBlendMode(input: string): WriteBlendMode {
  const mode = BLEND_MODES[String(input).trim().toLowerCase()];
  if (!mode) {
    throw new Error('flcm: unsupported blend "' + input + '" — use one of these CSS mix-blend-mode names: ' + Object.keys(BLEND_MODES).join(", ") + ". (Figma has no equivalent for pass-through or plus-lighter/plus-darker.)");
  }
  return mode;
}

// ---- Gradient strings -> PaintSpec. Dispatch by CSS gradient function; conic is absent on purpose (it
// maps to GRADIENT_ANGULAR, outside the supported subset) and falls through to the loud error. ----
const GRADIENTS: Record<string, (stops: string[], raw: string) => PaintSpec> = {
  "linear-gradient": parseLinearGradient,
  "radial-gradient": parseRadialGradient,
};

function parseGradientString(css: string): PaintSpec {
  const { name, args } = cssFn(css.trim());
  const parse = GRADIENTS[name];
  if (!parse) {
    const why = name === "conic-gradient"
      ? "angular/conic gradients are outside the supported subset"
      : "unsupported gradient '" + name + "'";
    throw badGradient(css, why + " — use linear-gradient or radial-gradient");
  }
  return parse(args, css);
}

// Split a CSS function call into its name and top-level comma args (commas inside rgba()/stops protected).
function cssFn(s: string): { name: string; args: string[] } {
  const open = s.indexOf("(");
  if (open < 0 || s[s.length - 1] !== ")") throw badGradient(s, "expected a CSS function like linear-gradient(...)");
  const args = splitTopLevel(s.slice(open + 1, s.length - 1), ",").map((p) => p.trim()).filter((p) => p.length);
  return { name: s.slice(0, open).trim().toLowerCase(), args };
}

const SIDE_ANGLE: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };

function parseLinearGradient(args: string[], raw: string): PaintSpec {
  const head = args[0] || "";
  let angle = 180; // CSS default = "to bottom"
  let stops = args;
  if (/^[-\d.]+deg$/i.test(head)) { angle = parseFloat(head); stops = args.slice(1); }
  else if (/^to\s+/i.test(head)) { angle = sideAngle(head, raw); stops = args.slice(1); }
  else if (/(grad|rad|turn)$/i.test(head)) throw badGradient(raw, "only deg angles are supported (got '" + head + "')");
  return linearGradient(angle, parseStops(stops, raw));
}

function parseRadialGradient(args: string[], raw: string): PaintSpec {
  const head = args[0] || "";
  const hasGeometry = /^(circle|ellipse|at)\b/i.test(head);
  const isEllipse = hasGeometry && /ellipse/i.test(head);
  const center = hasGeometry ? radialCenter(head, raw) : { x: 50, y: 50 };
  const stops = hasGeometry ? args.slice(1) : args;
  const type: GradientType = isEllipse ? "GRADIENT_DIAMOND" : "GRADIENT_RADIAL"; // read's circle/ellipse mapping
  return radialGradient(type, center.x, center.y, parseStops(stops, raw));
}

function sideAngle(token: string, raw: string): number {
  const side = token.replace(/^to\s+/i, "").trim().toLowerCase();
  if (SIDE_ANGLE[side] == null) throw badGradient(raw, "only `to top|right|bottom|left` are supported (got '" + token + "')");
  return SIDE_ANGLE[side];
}

function radialCenter(head: string, raw: string): { x: number; y: number } {
  const at = head.match(/at\s+([\d.]+)%\s+([\d.]+)%/i);
  if (at) return { x: parseFloat(at[1]), y: parseFloat(at[2]) };
  if (/\bat\b/i.test(head)) throw badGradient(raw, "radial center must be `at X% Y%` (percentages) in the supported subset");
  return { x: 50, y: 50 };
}

// `<color> [<pos>%]` stops. Position is the trailing `N%` token (the color may contain spaces, e.g.
// `rgba(0, 0, 0, 0.5)`). Missing positions get an even spread. Stop alpha rides on the stop color.
function parseStops(stops: string[], raw: string): GradientStop[] {
  if (!stops.length) throw badGradient(raw, "needs at least one color stop");
  const n = stops.length;
  return stops.map((part, i) => {
    const m = part.match(/\s+([\d.]+)%$/);
    const color = m ? part.slice(0, part.length - m[0].length).trim() : part;
    const position = m ? parseFloat(m[1]) / 100 : evenSpread(i, n);
    return { position, color: parseColor(color) };
  });
}

// Default stop position when none is given: 0 for a lone stop, else an even 0..1 spread.
function evenSpread(i: number, n: number): number {
  return n > 1 ? i / (n - 1) : 0;
}

function badGradient(s: string, why: string): Error {
  return new Error('flcm: cannot parse gradient "' + s + '" — ' + why + ".");
}

// ---- CSS effect strings (WriteCssEffects) -> EffectSpec[] ----
// boxShadow/textShadow decode as shadows; filter/backdropFilter as blurs with their Figma blur kind.
const EFFECT_FIELDS: { field: keyof WriteCssEffects; decode: (css: string) => EffectSpec[] }[] = [
  { field: "boxShadow", decode: parseShadows },
  { field: "textShadow", decode: parseShadows },
  { field: "filter", decode: (css) => parseBlurs(css, layerBlurFromCssPx) },
  { field: "backdropFilter", decode: (css) => parseBlurs(css, backgroundBlurFromCssPx) },
];

export function parseCssEffects(fx: WriteCssEffects): EffectSpec[] {
  const out: EffectSpec[] = [];
  for (const { field, decode } of EFFECT_FIELDS) {
    const css = fx[field];
    if (css) out.push(...decode(css));
  }
  return out;
}

// box-shadow: `[inset] <x>px <y>px <blur>px [<spread>px] <color>`, comma-separated for many.
function parseShadows(css: string): EffectSpec[] {
  return splitTopLevel(css, ",").map((part) => parseShadow(part.trim()));
}

function parseShadow(s: string): EffectSpec {
  // Whitespace tokens at paren depth 0, so an rgba() color stays one token. Lengths lead; whatever
  // remains after the leading `Npx` run is the color.
  const tokens = splitTopLevel(s, " ").map((t) => t.trim()).filter((t) => t.length);
  const inner = tokens[0] === "inset";
  if (inner) tokens.shift();
  const lengths: number[] = [];
  while (tokens.length && /^-?\d+(\.\d+)?px$/.test(tokens[0])) lengths.push(parseFloat(tokens.shift()!));
  if (lengths.length < 2) throw badEffect(s, "box-shadow needs at least <x>px <y>px");
  // No color token -> CSS `currentColor`, which we can't resolve here. Reject rather than silently
  // substitute a translucent black (a silent-wrong divergence per ADR-0003) — name the fix in the error.
  if (!tokens.length) throw badEffect(s, 'box-shadow needs an explicit color — CSS `currentColor` is not available here (e.g. "0px 4px 8px rgba(0,0,0,0.25)")');
  const color = parseColor(tokens.join(" "));
  return shadow({
    inner,
    color,
    x: lengths[0],
    y: lengths[1],
    radius: lengths.length > 2 ? lengths[2] : 0, // 1:1 with the Figma radius
    spread: lengths.length > 3 ? lengths[3] : 0,
  });
}

// filter / backdrop-filter: one or more `blur(Npx)`. The build() constructor applies the ×2 CSS->Figma
// factor (see effects.ts), so it is NOT applied here. Any other function (drop-shadow(), …) throws.
function parseBlurs(css: string, build: (cssPx: number) => EffectSpec): EffectSpec[] {
  const fns = splitTopLevel(css.trim(), " ").map((t) => t.trim()).filter((t) => t.length);
  if (!fns.length) throw badEffect(css, "expected blur(Npx)");
  return fns.map((fn) => {
    const m = fn.match(/^blur\(\s*([\d.]+)px\s*\)$/i);
    if (!m) throw badEffect(css, "only blur(Npx) is supported (got '" + fn + "')");
    return build(parseFloat(m[1]));
  });
}

function badEffect(s: string, why: string): Error {
  return new Error('flcm: cannot parse effect "' + s + '" — ' + why + ".");
}

// ---- Scalar metric coercions (author may pass a number or a CSS string) ----

// A px-or-number leaf -> number. Accepts ONLY a number or a strict "Npx" — NOT parseFloat's leniency,
// which silently coerces out-of-subset metrics to wrong pixels ("8em"->8, "50%"->50, "12foo"->12). The
// whole point of the CSS surface is fidelity, so a metric outside the subset fails loud, naming the value.
export function length(v: number | string): number {
  if (typeof v === "number") return v;
  const m = /^(-?\d+(\.\d+)?)px$/.exec(String(v).trim());
  if (!m) throw new Error('flcm: expected a number or "Npx" (e.g. 24 or "24px"), got ' + JSON.stringify(v) + " — em/%/rem and bare numeric strings are not coerced.");
  return parseFloat(m[1]);
}

// A CSS 1–4 value box shorthand ("12px" | "12px 16px" | "12px 16px 8px" | "12px 16px 8px 4px") -> typed
// Edges, following CSS's own fill-in rules. The READ shape spells padding this way (one string, per
// core/utils generateCSSShorthand) while flcm's `padding` prop takes numbers, so the read→write
// normalizer needs the decode; nothing else authors padding as a string. Each value rides `length`, so a
// non-px unit fails loud there rather than coercing to wrong pixels.
export function boxShorthand(value: string, field: string): Edges {
  const parts = String(value).trim().split(/\s+/).filter((p) => p.length);
  if (!parts.length || parts.length > 4) {
    throw new Error("flcm: " + field + ' must be a CSS box shorthand of 1–4 values (e.g. "12px" or "12px 16px") — got ' + JSON.stringify(value) + ".");
  }
  const n = parts.map((p) => length(p));
  const top = n[0];
  const right = n.length > 1 ? n[1] : top;
  return { top, right, bottom: n.length > 2 ? n[2] : top, left: n.length > 3 ? n[3] : right };
}

// A "N%" size/position leaf. Percent has no CSS→Figma string parse (it resolves against the parent at
// render, not here at the boundary), so this is just the strict reader: `isPercent` branches a percent
// string from a number/`"fill"`/`"hug"` in the sugar, and `percent` extracts its numeric value. Strict
// like `length` — a bare number, `"50 %"`, or `"50%%"` is not a percent — so a typo fails loud upstream
// rather than resolving to a wrong fraction.
const PERCENT_RE = /^(-?\d+(\.\d+)?)%$/;
export function isPercent(v: unknown): v is string {
  return typeof v === "string" && PERCENT_RE.test(v.trim());
}
export function percent(v: string): number {
  const m = PERCENT_RE.exec(String(v).trim());
  if (!m) throw new Error('flcm: expected a percent like "50%", got ' + JSON.stringify(v) + ".");
  return parseFloat(m[1]);
}

// A strict "<number><unit>" reader for the font-relative metrics. Rejects parseFloat's leniency that
// would otherwise pass "1.5rem" as 1.5em, "5 0%" as 50%, or "12foo%" as 12 — each a silent-wrong metric.
function unitValue(s: string, unit: "em" | "%", what: string): number {
  const m = new RegExp("^(-?\\d+(\\.\\d+)?)" + unit + "$").exec(s);
  if (!m) throw new Error("flcm: bad " + what + " " + JSON.stringify(s) + ' — expected e.g. "1.5em" or "150%".');
  return parseFloat(m[1]);
}

// lineHeight CSS leaf -> the plugin's LineHeight. Read emits "24px" (PIXELS), "1.5em" (-> PERCENT), or
// omits it (AUTO). A bare number is taken as px. Out-of-subset units throw rather than zeroing the metric.
export function lineHeight(v: number | string): WriteLineHeight {
  if (typeof v === "number") return { value: v, unit: "PIXELS" };
  const s = String(v).trim().toLowerCase();
  if (s === "" || s === "auto" || s === "normal") return { unit: "AUTO" };
  if (s.slice(-2) === "em") return { value: unitValue(s, "em", "lineHeight") * 100, unit: "PERCENT" };
  if (s.slice(-1) === "%") return { value: unitValue(s, "%", "lineHeight"), unit: "PERCENT" };
  return { value: length(s), unit: "PIXELS" };
}

// letterSpacing CSS leaf -> the plugin's LetterSpacing. Read emits a font-size-relative "0.05em"
// (-> PERCENT, em*100); "2px" and bare numbers are PIXELS.
export function letterSpacing(v: number | string): WriteLetterSpacing {
  if (typeof v === "number") return { value: v, unit: "PIXELS" };
  const s = String(v).trim().toLowerCase();
  if (s.slice(-2) === "em") return { value: unitValue(s, "em", "letterSpacing") * 100, unit: "PERCENT" };
  if (s.slice(-1) === "%") return { value: unitValue(s, "%", "letterSpacing"), unit: "PERCENT" };
  return { value: length(s), unit: "PIXELS" };
}

// Split a CSS list on a separator at PAREN DEPTH 0, so commas inside rgba()/gradient stops don't split a
// shadow list or a stop list mid-color.
function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim().length) out.push(buf);
  return out;
}
