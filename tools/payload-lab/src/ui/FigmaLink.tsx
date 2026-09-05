import type { Capture } from "../shared/model.js";

export function FigmaLink({
	capture,
	nodeId,
}: {
	capture: Capture;
	nodeId: string;
}) {
	if (capture.kind !== "live" || !nodeId) return null;
	const href = `figma://file/${encodeURIComponent(capture.fileKey)}?node-id=${encodeURIComponent(nodeId)}`;
	const label = `Open node ${nodeId} in Figma desktop`;
	return (
		<a className="figma-link" href={href} aria-label={label} title={label}>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
			</svg>
		</a>
	);
}
