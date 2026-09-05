import { FigmaLink } from "./FigmaLink.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	Capture,
	Comparison,
	Format,
	Json,
	Obj,
	TreeNode,
} from "../shared/model.js";
import { object } from "../shared/model.js";
import { findRawNode, sourceHint, fieldAt } from "../shared/source.js";
export function valueText(value: unknown) {
	return value === undefined
		? "—"
		: typeof value === "string"
			? value
			: JSON.stringify(value, null, 2);
}
function Output({
	text,
	selected,
	side,
}: {
	text: string;
	selected: string;
	side: string;
}) {
	const ref = useRef<HTMLPreElement>(null);
	const match = useMemo(() => {
		if (!selected) return null;
		const lines = text.split("\n");
		let offset = 0;
		for (const [index, line] of lines.entries()) {
			if (
				line.includes(`"id": "${selected}"`) ||
				line.includes(`id: '${selected}'`) ||
				line.trim() === `id: ${selected}` ||
				line.includes(`#${selected} `) ||
				line.endsWith(`#${selected}`)
			)
				return { offset, end: offset + line.length, line: index };
			offset += line.length + 1;
		}
		return null;
	}, [text, selected]);
	useEffect(() => {
		if (ref.current && match)
			ref.current.scrollTop = Math.max(0, match.line * 19 - 70);
	}, [match]);
	return (
		<div className="output">
			<h3>{side}</h3>
			<pre ref={ref} aria-label={`${side} serialized output`}>
				{match ? (
					<>
						{text.slice(0, match.offset)}
						<span className="highlight">
							{text.slice(match.offset, match.end)}
						</span>
						{text.slice(match.end)}
					</>
				) : (
					text
				)}
			</pre>
		</div>
	);
}

export function Inspector({
	result,
	format,
	selected,
	path,
	raw,
}: {
	result: Comparison;
	format: Format;
	selected: string;
	path: string;
	raw: Json | null;
}) {
	const [tab, setTab] = useState("fields");
	const before = result.analysis.baselineNodes.find((n) => n.id === selected);
	const after = result.analysis.candidateNodes.find((n) => n.id === selected);
	const source = raw && selected ? findRawNode(raw, selected) : undefined;
	const fieldPath = path.startsWith(`/nodes/${selected}/`)
		? path
				.slice(`/nodes/${selected}/`.length)
				.split("/")
				.map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"))
		: [];
	const hints = sourceHint(source, fieldPath[0] ?? "");
	const envelopePath =
		!selected && path
			? path
					.slice(1)
					.split("/")
					.map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"))
			: [];
	const envelopeBefore = envelopePath.length
		? fieldAt(result.baseline.design, envelopePath)
		: undefined;
	const envelopeAfter = envelopePath.length
		? fieldAt(result.candidate.design, envelopePath)
		: undefined;
	return (
		<section className="inspector">
			<div className="section-head">
				<div className="tabs" role="tablist" aria-label="Inspector view">
					{[
						["fields", "Fields & source"],
						["output", "Serialized output"],
						["metrics", "All metrics"],
					].map(([key, label]) => (
						<button
							role="tab"
							aria-selected={tab === key}
							onClick={() => setTab(key)}
							key={key}
						>
							{label}
						</button>
					))}
				</div>
				<span className="muted mono selection-label">
					{path || selected || "Select a node or change"}
					<FigmaLink capture={result.capture} nodeId={selected} />
				</span>
			</div>
			{tab === "fields" && (
				<>
					<div className="field-focus">
						{fieldPath.length > 0 && (
							<>
								<strong className="mono">{fieldPath.join(" / ")}</strong>
								<span>
									Baseline:{" "}
									<code>{valueText(fieldAt(before?.fields, fieldPath))}</code>
								</span>
								<span>
									Working tree:{" "}
									<code>{valueText(fieldAt(after?.fields, fieldPath))}</code>
								</span>
							</>
						)}
					</div>
					<div className="field-grid">
						<div>
							<h3>Baseline · resolved fields</h3>
							<pre>{valueText(before?.fields ?? envelopeBefore)}</pre>
						</div>
						<div>
							<h3>Working tree · resolved fields</h3>
							<pre>{valueText(after?.fields ?? envelopeAfter)}</pre>
						</div>
						<div>
							<h3>Capture · source node</h3>
							<p className="muted small">
								Matched by node ID. Layout, geometry, styles, and collapsed
								nodes are derived; these are source facts, not a one-to-one
								field mapping.
							</p>
							{hints && (
								<>
									<h3>Possible wire inputs · navigation hints</h3>
									<pre>{valueText(hints)}</pre>
									<p className="small muted">
										Ancestors and shared tables may also contribute. Use the raw
										node below to check the derivation.
									</p>
								</>
							)}
							<details open={!hints}>
								<summary>Raw node</summary>
								<pre>{valueText(source)}</pre>
							</details>
						</div>
					</div>
				</>
			)}
			{tab === "output" && (
				<>
					<p className="output-note muted small">
						Exact tool output · {result.analysis.serialization[format]} ·
						selected node highlighted where its ID appears. Templates and styles
						remain in their emitted tables.
					</p>
					<div className="outputs">
						<Output
							text={result.baseline.serialized[format]}
							selected={selected}
							side="Baseline"
						/>
						<Output
							text={result.candidate.serialized[format]}
							selected={selected}
							side="Working tree"
						/>
					</div>
				</>
			)}
			{tab === "metrics" && <Metrics result={result} format={format} />}
		</section>
	);
}
function Metrics({ result, format }: { result: Comparison; format: Format }) {
	const m = result.analysis.metrics[format];
	const labels = {
		bytes: "Serialized bytes",
		estimatedTokens: "Estimated tokens",
		nodes: "Emitted nodes",
		maxDepth: "Maximum depth",
		components: "Component table entries",
		properties: "Property values + definitions",
		simplifyMs: "Simplification (ms)",
		serializeMs: "Serialization (ms)",
	};
	return (
		<div className="metrics-table">
			<table>
				<thead>
					<tr>
						<th>Measure</th>
						<th>Baseline</th>
						<th>Working tree</th>
						<th>Change</th>
					</tr>
				</thead>
				<tbody>
					{Object.entries(labels).map(([key, label]) => {
						const k = key as keyof typeof m.baseline;
						const a = m.baseline[k],
							b = m.candidate[k];
						return (
							<tr key={key}>
								<td>{label}</td>
								<td>
									{a.toLocaleString(undefined, { maximumFractionDigits: 2 })}
								</td>
								<td>
									{b.toLocaleString(undefined, { maximumFractionDigits: 2 })}
								</td>
								<td>
									{b - a > 0 ? "+" : ""}
									{(b - a).toLocaleString(undefined, {
										maximumFractionDigits: 2,
									})}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<p className="small muted">
				Token estimate: UTF-8 bytes ÷ 4, rounded up. A size heuristic, not a
				model tokenizer. Root depth is 0. Properties count instance values and
				owner definitions. Timings vary between runs; dependency resolution and
				bundling are excluded.
			</p>
		</div>
	);
}
export function Tree({
	capture,
	nodes,
	selected,
	select,
	changed,
}: {
	capture: Capture;
	nodes: TreeNode[];
	selected: string;
	select: (id: string) => void;
	changed: Set<string>;
}) {
	const [search, setSearch] = useState("");
	return (
		<section className="tree-pane">
			<div className="section-head">
				<h2>Simplified tree</h2>
				<span className="muted small">{nodes.length} nodes</span>
			</div>
			<input
				aria-label="Filter nodes"
				placeholder="Find a name or ID…"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
			/>
			<div className="tree-list">
				{nodes
					.filter((n) =>
						`${n.id} ${n.fields.name ?? ""}`
							.toLowerCase()
							.includes(search.toLowerCase()),
					)
					.map((node) => (
						<div className="tree-node-row" key={node.id}>
							<button
								className={`tree-row ${selected === node.id ? "selected" : ""}`}
								style={{ paddingLeft: 12 + Math.min(node.depth, 8) * 14 }}
								onClick={() => select(node.id)}
								aria-pressed={selected === node.id}
							>
								<span
									className={
										changed.has(node.id) ? "node-dot changed-dot" : "node-dot"
									}
								/>
								<span className="node-label">
									{String(node.fields.name ?? node.fields.type ?? "Node")}
									<small>
										{node.id} · {String(node.fields.type ?? "")}
									</small>
								</span>
							</button>
							<FigmaLink capture={capture} nodeId={node.id} />
						</div>
					))}
			</div>
		</section>
	);
}
export function nodeAtPath(design: Obj, path: string): string {
	let value: Json = design,
		id = "";
	for (const segment of path.split("/").filter(Boolean)) {
		if (typeof object(value).id === "string") id = String(object(value).id);
		value = Array.isArray(value)
			? value[Number(segment)]
			: object(value)[segment];
		if (value === undefined) break;
	}
	return id;
}
