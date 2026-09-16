// Figma's native tracks and the read template are two representations of the same tracks.
export type GridTrack = { type: "HUG" } | { type: "FIXED" | "FLEX"; value: number };
export function serializeGridTracks(tracks: readonly { type: "HUG" | "FIXED" | "FLEX"; value?: number }[]): string {
  return tracks.map(track => track.type === "HUG" ? "fit-content(100%)" : `${track.value ?? 1}${track.type === "FIXED" ? "px" : "fr"}`).join(" ");
}

// REST may compress equal tracks with repeat/minmax; the plugin stores expanded tracks.
export function parseGridTracks(raw: string, subject: string): GridTrack[] {
  const tokens = raw.match(/repeat\(\s*\d+\s*,\s*(?:minmax\([^)]*\)|fit-content\([^)]*\)|[^()])+\)|minmax\([^)]*\)|fit-content\([^)]*\)|[^\s]+/g) ?? [];
  const tracks: GridTrack[] = [];
  for (const token of tokens) {
    const repeat = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/.exec(token);
    if (repeat) {
      const count = Number(repeat[1]);
      if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error(subject + ": grid repeat count must be between 1 and 10000.");
      const repeated = parseGridTracks(repeat[2], subject);
      for (let i = 0; i < count; i++) tracks.push(...repeated);
      continue;
    }
    if (token === "auto" || token === "fit-content(100%)") { tracks.push({ type: "HUG" }); continue; }
    const normalized = /^minmax\(\s*0(?:px)?\s*,\s*(\d+(?:\.\d+)?fr)\s*\)$/.exec(token)?.[1] ?? token;
    const match = /^(\d+(?:\.\d+)?)(px|fr)$/.exec(normalized);
    if (!match || !Number.isFinite(Number(match[1])) || (match[2] === "fr" && Number(match[1]) <= 0)) throw new Error(subject + ": unsupported grid track " + token + "; use Npx, Nfr, auto, fit-content(100%), repeat(N, tracks), or minmax(0, Nfr).");
    tracks.push({ type: match[2] === "px" ? "FIXED" : "FLEX", value: Number(match[1]) });
  }
  return tracks;
}

// ---- Implicit rows. Figma flows row-wise, so a grid's COLUMNS are the axis an author must state;
// the row count is a fact about the children, and making it one the author has to know is how a
// tile wall with a captioned first tile becomes a hand-computed pixel row. A claim is one child's
// demand on the grid — an anchored track index (0-based) or auto, and a span. ----
export interface GridClaim {
  column?: number;
  columnSpan?: number;
  row?: number;
  rowSpan?: number;
}

/**
 * How many rows these claims need at `columnCount`, by CSS row-major auto-placement
 * (`grid-auto-flow: row`, sparse): claims anchored in both axes take their cells first, then a
 * cursor walks the rest left-to-right, top-to-bottom. Always at least 1 — a grid with no children
 * still has a row.
 */
export function rowsForGridClaims(columnCount: number, claims: readonly GridClaim[]): number {
  const columns = Math.max(Math.floor(columnCount) || 1, 1);
  const occupied = new Set<string>();
  let rows = 0;
  const sizeOf = (claim: GridClaim) => ({
    columns: Math.min(Math.max(Math.floor(claim.columnSpan ?? 1), 1), columns),
    rows: Math.max(Math.floor(claim.rowSpan ?? 1), 1),
  });
  type Size = ReturnType<typeof sizeOf>;
  const free = (row: number, column: number, size: Size) => {
    if (column < 0 || column + size.columns > columns) return false;
    for (let r = row; r < row + size.rows; r++) for (let c = column; c < column + size.columns; c++) if (occupied.has(r + ":" + c)) return false;
    return true;
  };
  const take = (row: number, column: number, size: Size) => {
    for (let r = row; r < row + size.rows; r++) for (let c = column; c < column + size.columns; c++) occupied.add(r + ":" + c);
    rows = Math.max(rows, row + size.rows);
  };
  const clampColumn = (column: number, size: Size) => Math.min(Math.max(column, 0), columns - size.columns);
  const floating: { claim: GridClaim; size: Size }[] = [];
  for (const claim of claims) {
    const size = sizeOf(claim);
    if (claim.row !== undefined && claim.column !== undefined) take(Math.max(claim.row, 0), clampColumn(claim.column, size), size);
    else floating.push({ claim, size });
  }
  let cursorRow = 0, cursorColumn = 0;
  for (const { claim, size } of floating) {
    // An anchored row is where the claim sits, full or not: an overlap Figma refuses is the
    // author's to see, and inventing a different row would only hide it behind a wrong row count.
    if (claim.row !== undefined) {
      const row = Math.max(claim.row, 0);
      let column = 0;
      while (column + size.columns <= columns && !free(row, column, size)) column++;
      take(row, clampColumn(column, size), size);
      continue;
    }
    if (claim.column !== undefined) {
      const column = clampColumn(claim.column, size);
      if (column < cursorColumn) cursorRow++;
      cursorColumn = column;
      while (!free(cursorRow, column, size)) cursorRow++;
      take(cursorRow, column, size);
      continue;
    }
    while (!free(cursorRow, cursorColumn, size)) {
      cursorColumn++;
      if (cursorColumn + size.columns > columns) { cursorColumn = 0; cursorRow++; }
    }
    take(cursorRow, cursorColumn, size);
    cursorColumn += size.columns;
  }
  return Math.max(rows, 1);
}

/** Rows a grid hugs one per claim-row — what "gridTemplateRows omitted" resolves to. */
export function hugGridTracks(rows: number): GridTrack[] {
  return Array.from({ length: rows }, () => ({ type: "HUG" }) as GridTrack);
}

/** The author boundary uses one placement parser for canonical words and composed input aliases. */
export function parseGridPlacement(raw: unknown, subject: string): { anchor?: number; span: number } {
  const match = typeof raw === "string" ? /^(?:(\d+)(?: \/ span (\d+))?|span (\d+))$/.exec(raw.trim()) : null;
  if (!match || match.slice(1).some(v => v !== undefined && (!Number.isSafeInteger(Number(v)) || Number(v) < 1))) throw new Error(subject + ' needs "N", "span N", or "N / span N".');
  return { ...(match[1] ? { anchor: Number(match[1]) - 1 } : {}), span: Number(match[2] ?? match[3] ?? 1) };
}
