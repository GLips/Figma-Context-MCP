// Page and slug names derive from the trial and start time so a page in Figma
// can be traced back to its run record and report by eye.

export function pageNameFor(trial: string, startedAt: Date): string {
  return `${trial} ${local(startedAt, "YYYY-MM-DD HH:mm")}`;
}

// sq slugs are alphanumerics + hyphens only.
export function slugFor(trial: string, startedAt: Date): string {
  return `trial-${trial}-${local(startedAt, "MMDD-HHmm")}`;
}

function local(d: Date, shape: "YYYY-MM-DD HH:mm" | "MMDD-HHmm"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const MM = p(d.getMonth() + 1);
  const DD = p(d.getDate());
  const HH = p(d.getHours());
  const mm = p(d.getMinutes());
  return shape === "YYYY-MM-DD HH:mm"
    ? `${d.getFullYear()}-${MM}-${DD} ${HH}:${mm}`
    : `${MM}${DD}-${HH}${mm}`;
}
