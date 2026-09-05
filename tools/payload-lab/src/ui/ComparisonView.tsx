import { useState } from "react";
import type { Comparison, Format, Json } from "../shared/model.js";
import { Inspector, Tree, valueText, nodeAtPath } from "./Inspector.js";
export function ComparisonView({
	result,
	format,
	selected,
	path,
	raw,
	select,
}: {
	result: Comparison;
	format: Format;
	selected: string;
	path: string;
	raw: Json | null;
	select: (id: string, path?: string) => void;
}) {
	const [filter, setFilter] = useState("all"),
		[view, setView] = useState("changes");
	const metrics = result.analysis.metrics[format];
	const changed = new Set(
		result.analysis.changes.flatMap((c) => (c.nodeId ? [c.nodeId] : [])),
	);
	const candidateIds = new Set(result.analysis.candidateNodes.map((n) => n.id));
	const rows = [
		...result.analysis.candidateNodes,
		...result.analysis.baselineNodes.filter((n) => !candidateIds.has(n.id)),
	];
	const allChanges =
		view === "meaning"
			? result.analysis.changes
			: result.analysis.emittedChanges;
	const changes = allChanges.filter(
		(c) => filter === "all" || c.kind === filter,
	);
	return (
		<>
			<div className="run-meta mono small">
				{result.baseline.revision.slice(0, 12)} → working tree · source{" "}
				{result.candidate.sourceHash.slice(0, 10)} · capture{" "}
				{result.capture.sha256.slice(0, 10)}
				{result.stale && (
					<strong className="warning">
						{" "}
						· Source changed during replay. Replay again.
					</strong>
				)}
			</div>
			<div className="metrics-strip">
				{[
					["Serialized bytes", metrics.baseline.bytes, metrics.candidate.bytes],
					[
						"Estimated tokens",
						metrics.baseline.estimatedTokens,
						metrics.candidate.estimatedTokens,
					],
					["Nodes", metrics.baseline.nodes, metrics.candidate.nodes],
				].map(([label, before, after]) => (
					<div key={String(label)}>
						<span className="small muted">{label}</span>
						<strong>
							{Number(after).toLocaleString()}
							<small>
								{Number(after) - Number(before) >= 0 ? "+" : ""}
								{(Number(after) - Number(before)).toLocaleString()}
							</small>
						</strong>
						<span className="small muted">
							Baseline {Number(before).toLocaleString()}
						</span>
					</div>
				))}
				<div>
					<span className="small muted">Structural changes</span>
					<strong>{result.analysis.emittedChanges.length}</strong>
					<span className="small muted">
						{result.analysis.serialization[format]}
					</span>
				</div>
			</div>
			<div className="comparison-grid">
				<Tree
					capture={result.capture}
					nodes={rows}
					selected={selected}
					select={select}
					changed={changed}
				/>
				<section className="diff-pane">
					<div className="section-head">
						<div className="tabs">
							<button
								className={view === "changes" ? "active" : ""}
								onClick={() => setView("changes")}
							>
								Structural diff
							</button>
							<button
								className={view === "meaning" ? "active" : ""}
								onClick={() => setView("meaning")}
							>
								Resolved fields
							</button>
							<button
								className={view === "repeats" ? "active" : ""}
								onClick={() => setView("repeats")}
							>
								Repeated values
							</button>
						</div>
						{view !== "repeats" && (
							<select
								aria-label="Filter changes"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
							>
								{["all", "added", "removed", "changed", "moved"].map((k) => (
									<option key={k} value={k}>
										{k}
									</option>
								))}
							</select>
						)}
					</div>
					{view !== "repeats" ? (
						<div className="change-list">
							{changes.length ? (
								changes.map((change, i) => (
									<button
										className={`change-row ${change.nodeId && selected === change.nodeId ? "selected" : ""}`}
										key={i}
										onClick={() => select(change.nodeId ?? "", change.path)}
									>
										<span className={`badge ${change.kind}`}>
											{change.kind}
										</span>
										<div>
											<strong className="mono">{change.path}</strong>
											<div className="change-values">
												<code>{valueText(change.before)}</code>
												<span>→</span>
												<code>{valueText(change.after)}</code>
											</div>
										</div>
									</button>
								))
							) : (
								<div className="empty-small">
									No {filter === "all" ? "structural" : filter} changes.
									<p className="muted">
										Inspect serialized output for formatting and representation
										changes.
									</p>
								</div>
							)}
						</div>
					) : (
						<div className="repeat-list">
							<p className="small muted">
								Exact strings of 4+ characters in emitted data. Repetition may
								carry useful meaning. Approximate repeated bytes are not
								guaranteed savings.
							</p>
							{(["baseline", "candidate"] as const).map((side) => (
								<div key={side}>
									<h3>
										{side === "candidate" ? "Working tree" : "Baseline"} ·{" "}
										{result.analysis.repetitions[side].length} repeated values
									</h3>
									{result.analysis.repetitions[side]
										.slice(0, 100)
										.map((r, i) => (
											<details key={i}>
												<summary>
													<code>{String(r.value)}</code>
													<span>
														{r.occurrences}× · ~{r.repeatedBytes} bytes
													</span>
												</summary>
												{r.paths.map((p) => (
													<button
														className="path-button mono"
														key={p}
														onClick={() =>
															select(nodeAtPath(result[side].design, p), p)
														}
													>
														{p}
													</button>
												))}
											</details>
										))}
									{result.analysis.repetitions[side].length > 100 && (
										<p>Showing the 100 largest repeated values.</p>
									)}
								</div>
							))}
						</div>
					)}
				</section>
			</div>
			<Inspector
				result={result}
				format={format}
				selected={selected}
				path={path}
				raw={raw}
			/>
			<details className="run-details">
				<summary>Run details & limitations</summary>
				{result.warnings.map((w) => (
					<p key={w}>{w}</p>
				))}
				<p className="mono small">
					Dependencies {result.dependencyHash}
					<br />
					Baseline pipeline: {result.baseline.pipeline}
					<br />
					Candidate pipeline: {result.candidate.pipeline}
					<br />
					Captured source: {result.capture.sourceUrl}
					<br />
					Compared: {result.comparedAt}
				</p>
				<p>
					Styles and template references are expanded for the structural diff.
					Exact output preserves them. Source matching uses node IDs; field
					derivation and equivalence still need human review.
				</p>
			</details>
		</>
	);
}
