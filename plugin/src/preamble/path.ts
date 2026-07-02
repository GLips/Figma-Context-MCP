// SVG path normalization for flcm.path.
//
// Why this exists: Figma's `vectorPaths` parser accepts ONLY the `M L C Q Z` subset in *absolute* form.
// Standard SVG `d` strings routinely use `H V S T A` and relative (lowercase) commands, so before this
// module they failed loud at render — forcing the author onto flcm.svg and losing themeability. That was
// ergo5's rank-1 cost. We convert the full command set into the accepted subset so any valid `d` renders
// as a single themeable vector.
//
// The dividing line for fail-loud moves from "unsupported command" to "unparseable": valid-but-unsupported
// commands are converted; genuinely malformed data (e.g. "M12 banana") still throws a specific error.
//
// Lossiness: arc→cubic is a bezier approximation (exact ellipses can't be a finite set of cubics) and the
// re-serialized output no longer byte-matches the author's input. Icon-scale error is imperceptible; the
// warning about byte-equality is for a future read side, not the render path.

// Returns [c1x, c1y, c2x, c2y, endX, endY] cubic segments approximating the arc from (x1,y1) to (x2,y2).
// Standard endpoint→center parameterization (SVG impl notes F.6) + split into ≤90° segments, each a cubic.
// Caller handles the degenerate rx|ry==0 and coincident-endpoint cases before calling. Returns [] when
// pathological radii/rotation drive the math non-finite — the caller treats that empty result as fail-loud.
function arcToCubics(
  x1: number, y1: number,
  rx: number, ry: number,
  phiDeg: number,
  fa: number, fs: number,
  x2: number, y2: number,
): number[][] {
  const TAU = Math.PI * 2;
  const phi = (phiDeg * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  rx = Math.abs(rx);
  ry = Math.abs(ry);

  // Step F.6.5.1 — midpoint in the rotated frame.
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Step F.6.6 — scale out-of-range radii up so the arc is realizable.
  let rxs = rx * rx;
  let rys = ry * ry;
  const x1ps = x1p * x1p;
  const y1ps = y1p * y1p;
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxs = rx * rx;
    rys = ry * ry;
  }

  // Step F.6.5.2 — center in the rotated frame.
  const sign = fa === fs ? -1 : 1;
  let num = rxs * rys - rxs * y1ps - rys * x1ps;
  num = num < 0 ? 0 : num; // clamp float noise so sqrt stays real
  const denom = rxs * y1ps + rys * x1ps;
  const coef = sign * Math.sqrt(num / denom);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * (-ry * x1p)) / rx;

  // Step F.6.5.3 — center in the original frame.
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // Step F.6.5.5/6 — start angle and sweep.
  const vAngle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = vAngle(1, 0, ux, uy);
  let dtheta = vAngle(ux, uy, vx, vy);
  if (fs === 0 && dtheta > 0) dtheta -= TAU;
  if (fs === 1 && dtheta < 0) dtheta += TAU;

  // Split into segments each spanning ≤90°, and approximate each with one cubic.
  const segments = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  // Pathological radii/rotation (denormal or overflowing radii, a rotation so large the trig loses all
  // meaning) leave the center or sweep non-finite. Bail with [] so the caller fails loud rather than
  // emitting a broken curve or silently dropping the arc.
  if (!isFinite(segments) || !isFinite(cx) || !isFinite(cy)) return [];
  const delta = dtheta / segments;
  const t = (4 / 3) * Math.tan(delta / 4); // control-arm length factor for a cubic matching the arc tangents

  const point = (theta: number): number[] => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    return [cosPhi * rx * c - sinPhi * ry * s + cx, sinPhi * rx * c + cosPhi * ry * s + cy];
  };
  const deriv = (theta: number): number[] => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    return [-cosPhi * rx * s - sinPhi * ry * c, -sinPhi * rx * s + cosPhi * ry * c];
  };

  const curves: number[][] = [];
  let a1 = theta1;
  for (let i = 0; i < segments; i++) {
    const a2 = a1 + delta;
    const [p1x, p1y] = point(a1);
    const [d1x, d1y] = deriv(a1);
    const [p2x, p2y] = point(a2);
    const [d2x, d2y] = deriv(a2);
    // The commanded endpoint (x2,y2) is authoritative — pin the final segment to it so large-radius
    // floating-point cancellation in point() can't leave the path short of where the arc must end.
    const ex = i === segments - 1 ? x2 : p2x;
    const ey = i === segments - 1 ? y2 : p2y;
    curves.push([p1x + t * d1x, p1y + t * d1y, p2x - t * d2x, p2y - t * d2y, ex, ey]);
    a1 = a2;
  }
  return curves;
}

const CMD = /[MmLlHhVvCcSsQqTtAaZz]/;

// The previous curve's control point, tagged so a smooth command reflects only after a matching curve.
type Ctrl = { kind: "C" | "Q"; x: number; y: number };

// Smooth commands (S/T) place their first control at the reflection of the previous curve's control about
// the current point — but only when the previous command was the matching curve kind; otherwise the control
// coincides with the current point (spec F.4.5/F.4.6).
function reflectCtrl(prev: Ctrl | null, kind: Ctrl["kind"], cx: number, cy: number): [number, number] {
  return prev && prev.kind === kind ? [2 * cx - prev.x, 2 * cy - prev.y] : [cx, cy];
}

// Normalize any valid SVG `d` string into `M L C Q Z`-only absolute commands (Figma's accepted subset).
// Throws on genuinely malformed input.
export function normalizePathData(d: string): string {
  const n = d.length;
  let i = 0;

  const fail = (msg: string): never => {
    throw new Error('flcm.path: could not parse the SVG path data "' + d + '" — ' + msg + " (at index " + i + ").");
  };
  const isWs = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
  const skipSep = (): void => {
    while (i < n && (isWs(d[i]) || d[i] === ",")) i++;
  };
  const readNumber = (): number => {
    skipSep();
    const start = i;
    if (i < n && (d[i] === "+" || d[i] === "-")) i++;
    let sawDigit = false;
    while (i < n && d[i] >= "0" && d[i] <= "9") {
      i++;
      sawDigit = true;
    }
    if (i < n && d[i] === ".") {
      i++;
      while (i < n && d[i] >= "0" && d[i] <= "9") {
        i++;
        sawDigit = true;
      }
    }
    if (!sawDigit) fail("expected a number");
    if (i < n && (d[i] === "e" || d[i] === "E")) {
      i++;
      if (i < n && (d[i] === "+" || d[i] === "-")) i++;
      let expDigit = false;
      while (i < n && d[i] >= "0" && d[i] <= "9") {
        i++;
        expDigit = true;
      }
      if (!expDigit) fail("malformed exponent in number");
    }
    return parseFloat(d.slice(start, i));
  };
  // Arc flags are a single 0 or 1 and may abut the next number (e.g. "0 1 50" written "0150"), so they
  // can't go through readNumber — they get their own one-char reader.
  const readFlag = (): number => {
    skipSep();
    const ch = d[i];
    if (ch === "0") {
      i++;
      return 0;
    }
    if (ch === "1") {
      i++;
      return 1;
    }
    return fail("arc large-arc/sweep flag must be 0 or 1");
  };

  // Round to 6 decimals to shed float noise from relative accumulation and arc-cubic trig, while
  // preserving any realistically authored precision (icon coords never carry meaningful sub-1e-6 detail).
  // 6 also keeps every nonzero output ≥ 1e-6, which String() renders in fixed notation — a finer cut would
  // let tiny values serialize in exponential form ("4e-7"), which we don't want in path data. Normalize
  // -0 → 0. The finite check is on the ROUNDED value: a huge-but-finite input that overflows on the ×1e6
  // fails loud here rather than serializing "Infinity" (an unsupported token) into the output.
  const fmt = (x: number): string => {
    const r = Math.round(x * 1e6) / 1e6;
    if (!isFinite(r)) fail("coordinate is out of range");
    return String(r === 0 ? 0 : r);
  };

  const out: string[] = [];
  let cmd = "";
  let cx = 0;
  let cy = 0; // current point
  let sx = 0;
  let sy = 0; // subpath start (for Z)
  let lastCtrl: Ctrl | null = null; // null after any non-curve command; see reflectCtrl

  skipSep();
  // SVG requires the first command to be a moveto; anything else is malformed (spec §9.3.3).
  if (i >= n || (d[i] !== "M" && d[i] !== "m")) fail("path must start with a moveto (M or m) command");
  while (i < n) {
    const ch = d[i];
    if (CMD.test(ch)) {
      cmd = ch;
      i++;
    } else if (/[A-Za-z]/.test(ch)) {
      fail('unknown command "' + ch + '"');
    } else if (cmd === "") {
      fail("expected a command letter");
    }

    switch (cmd) {
      case "M":
      case "m": {
        const rel = cmd === "m";
        let x = readNumber();
        let y = readNumber();
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        out.push("M" + fmt(x) + " " + fmt(y));
        lastCtrl = null;
        // Extra coordinate pairs after a moveto are implicit lineto (spec F.4.2).
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
      case "l": {
        const rel = cmd === "l";
        let x = readNumber();
        let y = readNumber();
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        out.push("L" + fmt(x) + " " + fmt(y));
        lastCtrl = null;
        break;
      }
      case "H":
      case "h": {
        let x = readNumber();
        if (cmd === "h") x += cx;
        cx = x;
        out.push("L" + fmt(cx) + " " + fmt(cy));
        lastCtrl = null;
        break;
      }
      case "V":
      case "v": {
        let y = readNumber();
        if (cmd === "v") y += cy;
        cy = y;
        out.push("L" + fmt(cx) + " " + fmt(cy));
        lastCtrl = null;
        break;
      }
      case "C":
      case "c": {
        const rel = cmd === "c";
        let x1 = readNumber();
        let y1 = readNumber();
        let x2 = readNumber();
        let y2 = readNumber();
        let x = readNumber();
        let y = readNumber();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        out.push("C" + fmt(x1) + " " + fmt(y1) + " " + fmt(x2) + " " + fmt(y2) + " " + fmt(x) + " " + fmt(y));
        cx = x;
        cy = y;
        lastCtrl = { kind: "C", x: x2, y: y2 };
        break;
      }
      case "S":
      case "s": {
        const rel = cmd === "s";
        let x2 = readNumber();
        let y2 = readNumber();
        let x = readNumber();
        let y = readNumber();
        if (rel) {
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        const [x1, y1] = reflectCtrl(lastCtrl, "C", cx, cy);
        out.push("C" + fmt(x1) + " " + fmt(y1) + " " + fmt(x2) + " " + fmt(y2) + " " + fmt(x) + " " + fmt(y));
        cx = x;
        cy = y;
        lastCtrl = { kind: "C", x: x2, y: y2 };
        break;
      }
      case "Q":
      case "q": {
        const rel = cmd === "q";
        let x1 = readNumber();
        let y1 = readNumber();
        let x = readNumber();
        let y = readNumber();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x += cx;
          y += cy;
        }
        out.push("Q" + fmt(x1) + " " + fmt(y1) + " " + fmt(x) + " " + fmt(y));
        cx = x;
        cy = y;
        lastCtrl = { kind: "Q", x: x1, y: y1 };
        break;
      }
      case "T":
      case "t": {
        const rel = cmd === "t";
        let x = readNumber();
        let y = readNumber();
        if (rel) {
          x += cx;
          y += cy;
        }
        const [x1, y1] = reflectCtrl(lastCtrl, "Q", cx, cy);
        out.push("Q" + fmt(x1) + " " + fmt(y1) + " " + fmt(x) + " " + fmt(y));
        cx = x;
        cy = y;
        lastCtrl = { kind: "Q", x: x1, y: y1 };
        break;
      }
      case "A":
      case "a": {
        const rel = cmd === "a";
        const rx = readNumber();
        const ry = readNumber();
        const rot = readNumber();
        const large = readFlag();
        const sweep = readFlag();
        let x = readNumber();
        let y = readNumber();
        if (rel) {
          x += cx;
          y += cy;
        }
        if (rx === 0 || ry === 0) {
          // Degenerate radius → straight line to the endpoint (spec F.6.2).
          out.push("L" + fmt(x) + " " + fmt(y));
        } else if (cx === x && cy === y) {
          // Coincident endpoints → the arc is omitted entirely (spec F.6.2).
        } else {
          const cubics = arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y);
          // Empty means the arc math went non-finite (pathological radii/rotation Figma can't realize) —
          // fail loud rather than dropping the segment silently.
          if (cubics.length === 0) fail("arc radii/rotation cannot be realized as a finite curve");
          for (const c of cubics) {
            out.push(
              "C" + fmt(c[0]) + " " + fmt(c[1]) + " " + fmt(c[2]) + " " + fmt(c[3]) + " " + fmt(c[4]) + " " + fmt(c[5]),
            );
          }
        }
        cx = x;
        cy = y;
        // Arc has no reflection semantics — a following S/T uses the current point as its control.
        lastCtrl = null;
        break;
      }
      case "Z":
      case "z": {
        out.push("Z");
        cx = sx;
        cy = sy;
        lastCtrl = null;
        // A closepath takes no coordinates; require an explicit command before any further data.
        cmd = "";
        break;
      }
      default:
        // Unreachable for author input: a non-CMD letter fails at the letter check above, and cmd === ""
        // is guarded before the switch. This guards the one remaining path — adding a letter to CMD
        // without a matching case here — which would otherwise spin (that command consumes no numbers, so
        // the cursor never advances). Fail loud instead.
        fail('internal: command "' + cmd + '" has no handler');
    }
    skipSep();
  }

  if (out.length === 0) fail("path contained no drawing commands");
  return out.join(" ");
}
