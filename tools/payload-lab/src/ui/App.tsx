import { useEffect, useState } from "react";
import {
  formats,
  type Capture,
  type Comparison,
  type Format,
  type Json,
  type Baseline,
} from "../shared/model.js";
import { api } from "./api.js";
import { ComparisonView } from "./ComparisonView.js";
export function App() {
  const [captures, setCaptures] = useState<Capture[]>([]),
    [captureId, setCaptureId] = useState("");
  const [status, setStatus] = useState<{
    credentialConfigured: boolean;
    tags: string[];
    head: string;
  }>();
  const [url, setUrl] = useState(""),
    [name, setName] = useState("");
  const [kind, setKind] = useState<Baseline["kind"]>("main"),
    [ref, setRef] = useState("");
  const [format, setFormat] = useState<Format>("tree");
  const [result, setResult] = useState<Comparison>(),
    [raw, setRaw] = useState<Json | null>(null);
  const [selected, setSelected] = useState(""),
    [path, setPath] = useState("");
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("payload-lab-theme") ?? "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("payload-lab-theme", theme);
  }, [theme]);
  useEffect(() => {
    Promise.all([api<Capture[]>("/captures"), api<NonNullable<typeof status>>("/status")])
      .then(([c, s]) => {
        setCaptures(c);
        setStatus(s);
        setCaptureId(c[0]?.id ?? "");
      })
      .catch((e) => setError(e.message));
  }, []);
  async function action(label: string, run: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy("");
    }
  }
  async function add(sample = false) {
    await action(sample ? "Loading sample…" : "Capturing Figma…", async () => {
      const capture = await api<Capture>(
        sample ? "/sample" : "/captures",
        sample ? {} : { url, name },
      );
      setCaptures(await api<Capture[]>("/captures"));
      setCaptureId(capture.id);
      setResult(undefined);
      setUrl("");
      setName("");
    });
  }
  async function replay() {
    await action("Replaying both revisions…", async () => {
      const baseline = kind === "tag" || kind === "commit" ? { kind, ref } : { kind };
      const data = await api<Comparison>("/compare", { captureId, baseline });
      const source = await api<Json>(`/captures/${captureId}/raw`);
      setResult(data);
      setRaw(source);
      setSelected(
        data.analysis.changes.find((c) => c.nodeId)?.nodeId ??
          data.analysis.candidateNodes[0]?.id ??
          "",
      );
      setPath("");
    });
  }
  const active = captures.find((c) => c.id === captureId),
    metrics = result?.analysis.metrics[format];
  function select(id: string, nextPath = "") {
    setSelected(id);
    setPath(nextPath);
  }
  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">F</span>
          <strong>Payload Lab</strong>
          <span className="pill">LOCAL DEV</span>
        </div>
        <div className="header-right">
          <span className="muted small">Capture once. Compare the output.</span>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle color theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="library">
          <div className="section-head">
            <h2>Capture library</h2>
            <span className="muted small">{captures.length}</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label>
              Figma URL
              <input
                required
                type="url"
                value={url}
                placeholder="https://figma.com/design/…"
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label>
              Capture name
              <input
                required
                maxLength={100}
                value={name}
                placeholder="Checkout · desktop"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="primary full" disabled={!!busy || !status?.credentialConfigured}>
              Capture from Figma
            </button>
          </form>
          <p className="small muted">
            {status?.credentialConfigured
              ? "Figma credentials are configured on the server."
              : "Set FIGMA_API_KEY or FIGMA_OAUTH_TOKEN in the server environment to capture."}
          </p>
          <button className="full secondary" disabled={!!busy} onClick={() => void add(true)}>
            Load local sample
          </button>
          <div className="library-list">
            {captures.map((c) => (
              <button
                className={`capture-card ${captureId === c.id ? "active" : ""}`}
                disabled={!!busy}
                key={c.id}
                onClick={() => {
                  setCaptureId(c.id);
                  setResult(undefined);
                  setRaw(null);
                }}
              >
                <strong>{c.name}</strong>
                <span>{c.kind === "sample" ? "SYNTHETIC SAMPLE" : "LIVE REST CAPTURE"}</span>
                <small>
                  {new Date(c.capturedAt).toLocaleDateString()} · {(c.bytes / 1024).toFixed(1)} KB
                </small>
              </button>
            ))}
          </div>
          <p className="privacy small muted">
            Stored locally. No telemetry.
            <br />
            Only an explicit capture contacts Figma.
          </p>
        </aside>
        <main>
          <div className="title-row">
            <div>
              <div className="eyebrow">REST PAYLOAD COMPARISON</div>
              <h1>{active?.name ?? "Inspect what the model receives"}</h1>
              <p className="muted">
                {active
                  ? `${active.kind === "sample" ? "Synthetic data · verify live designs separately" : "Live capture · verify against the design"} · ${new Date(active.capturedAt).toLocaleString()}`
                  : "Save a live capture or load a sample to begin."}
              </p>
            </div>
            {active && (
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => {
                  if (confirm(`Delete “${active.name}” from this local library?`))
                    void action("Deleting capture…", async () => {
                      await api(`/captures/${active.id}`, undefined, "DELETE");
                      const c = await api<Capture[]>("/captures");
                      setCaptures(c);
                      setCaptureId(c[0]?.id ?? "");
                      setResult(undefined);
                    });
                }}
              >
                Delete capture
              </button>
            )}
          </div>
          <div className="toolbar">
            <label>
              Baseline
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as Baseline["kind"]);
                  setRef("");
                  setResult(undefined);
                }}
                disabled={!!busy}
              >
                <option value="main">main</option>
                <option value="merge-base">Merge-base with main</option>
                <option value="previous">Previous commit</option>
                <option value="tag">Release tag</option>
                <option value="commit">Specific commit</option>
              </select>
            </label>
            {kind === "tag" && (
              <label>
                Tag
                <select
                  value={ref}
                  onChange={(e) => {
                    setRef(e.target.value);
                    setResult(undefined);
                  }}
                >
                  <option value="">Choose a tag</option>
                  {status?.tags.map((t) => <option key={t}>{t}</option>)}
                </select>
              </label>
            )}
            {kind === "commit" && (
              <label>
                Commit
                <input
                  value={ref}
                  placeholder="Commit SHA or local ref"
                  onChange={(e) => {
                    setRef(e.target.value);
                    setResult(undefined);
                  }}
                />
              </label>
            )}
            <span className="arrow">→</span>
            <div className="candidate">
              <span className="small muted">Candidate</span>
              <strong>Working tree</strong>
            </div>
            <label className="format">
              Output
              <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                {formats.map((f) => (
                  <option value={f} key={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              disabled={!captureId || !!busy || ((kind === "tag" || kind === "commit") && !ref)}
              onClick={() => void replay()}
            >
              {busy || "Replay capture"}
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {busy && (
            <div className="progress" role="status">
              {busy} The saved capture stays unchanged.
            </div>
          )}
          {result && metrics ? (
            <>
              <ComparisonView
                result={result}
                format={format}
                selected={selected}
                path={path}
                raw={raw}
                select={select}
              />{" "}
            </>
          ) : (
            !busy && (
              <div className="welcome">
                <div className="welcome-glyph">{"{ }"}</div>
                <h2>Same design. Two code states.</h2>
                <p>
                  Replay one capture to see what changed,
                  <br />
                  what repeats, and what each field costs.
                </p>
                <div className="steps">
                  <span>01 · Capture a design</span>
                  <span>02 · Choose a baseline</span>
                  <span>03 · Inspect the difference</span>
                </div>
                <p className="small muted">
                  Local samples test the workflow. Live captures build confidence.
                </p>
              </div>
            )
          )}
        </main>
      </div>
    </div>
  );
}
