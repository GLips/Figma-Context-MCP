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

