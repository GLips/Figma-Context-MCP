import type { FigmaCredential } from "~/services/figma.js";

/**
 * What one caller may spend of this server's resources, built once at the edge and the only place a
 * tool finds them. The local server builds it from its bind: loopback means the caller is the
 * operator. A hosted server builds it from a verified identity. Extensions widen it with their own
 * grants (the write path adds plugin access).
 */
export interface CallerContext {
  /** Spent by every Figma call. Absent: each call fails asking for a token. */
  credential: FigmaCredential | undefined;
  /** The directory download_figma_images may write under. Null refuses the tool when called. */
  imageDir: string | null;
}
