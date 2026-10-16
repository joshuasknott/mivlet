import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageMarkdown } from "../../../apps/desktop/src/components/conversation/MessageMarkdown";
import { collectLibraryArtifacts } from "../../../apps/desktop/src/components/navigation/library-artifacts";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import "../../../apps/desktop/src/styles.css";
import "../../../apps/desktop/src/components/conversation/conversation.css";

const table = [
  "| Item | Value | Status |",
  "| --- | ---: | --- |",
  ...Array.from(
    { length: 300 },
    (_, i) => `| Synthetic row ${i + 1} | ${i} | Ready |`,
  ),
].join("\n");
const outputs = Array.from({ length: 2_000 }, (_, i) => ({
  agentId: "benchmark-agent",
  outputs: [
    {
      text: JSON.stringify({
        kind: "computer-artifact",
        version: 1,
        id: `artifact-${i.toString(16).padStart(64, "0")}`,
        computerId: `local-${"a".repeat(24)}`,
        title: `Synthetic report ${i}`,
        relativePath: `reports/report-${i}.md`,
        mimeType: "text/markdown",
        sizeBytes: 10,
        createdAt: "2026-10-12T10:00:00Z",
      }),
    },
  ],
})) as CollaborationWorkItem[];
const samples: { scenario: string; durationMs: number }[] = [];
const longTasks: number[] = [];
let startupMs = 0;
const heap = () =>
  (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    ?.usedJSHeapSize ?? null;
const heapSamples: { phase: string; bytes: number | null }[] = [];
function report() {
  const sorted = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
      : null;
  return {
    environment: "synthetic-browser-production-components",
    startupMs,
    sampleCount: samples.length,
    p50FrameMs: percentile(0.5),
    p95FrameMs: percentile(0.95),
    longTaskCount: longTasks.length,
    maxLongTaskMs: Math.max(0, ...longTasks),
    samples,
    heapSamples,
    note: "No account, provider or native IPC. Heap samples are observational and do not force garbage collection.",
  };
}
(
  window as Window & { __mivletBenchmarkReport?: typeof report }
).__mivletBenchmarkReport = report;
if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
  const observer = new PerformanceObserver((list) =>
    longTasks.push(...list.getEntries().map((entry) => entry.duration)),
  );
  observer.observe({ type: "longtask", buffered: true });
}
function App() {
  const [scenario, setScenario] = useState("history");
  const [query, setQuery] = useState("");
  const [tick, setTick] = useState(0);
  const [preview, setPreview] = useState(false);
  const started = useRef<number | null>(null);
  const changed = (action: () => void) => {
    started.current = performance.now();
    action();
  };
  useLayoutEffect(() => {
    const begin = started.current;
    started.current = null;
    requestAnimationFrame(() => {
      if (!startupMs) startupMs = performance.now();
      if (begin !== null)
        samples.push({ scenario, durationMs: performance.now() - begin });
    });
  }, [scenario, query, tick, preview]);
  useEffect(() => {
    if (scenario !== "stream") return;
    let frame = 0;
    let step = 0;
    const advance = () => {
      changed(() => setTick(++step));
      if (step < 120) frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [scenario]);
  const artifacts =
    scenario === "files"
      ? collectLibraryArtifacts(outputs, query.trim().toLowerCase())
      : [];
  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "auto" }}>
      <h1>Mivlet renderer benchmark</h1>
      <p>
        Synthetic data using production Markdown and file-selection code. No
        account, provider or native actions.
      </p>
      <label>
        Scenario{" "}
        <select
          value={scenario}
          onChange={(event) => changed(() => setScenario(event.target.value))}
        >
          <option value="history">Long history: 500 messages</option>
          <option value="table">Large table: 300 rows</option>
          <option value="stream">Streaming: 120 frames</option>
          <option value="files">Files: 2,000 outputs</option>
        </select>
      </label>{" "}
      <label>
        Search{" "}
        <input
          aria-label="Benchmark search"
          value={query}
          onChange={(event) => changed(() => setQuery(event.target.value))}
        />
      </label>{" "}
      <button
        onClick={() =>
          changed(() => {
            heapSamples.push({
              phase: preview ? "before-close" : "before-open",
              bytes: heap(),
            });
            setPreview(!preview);
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                heapSamples.push({
                  phase: preview ? "after-close" : "after-open",
                  bytes: heap(),
                }),
              ),
            );
          })
        }
      >
        {preview ? "Close preview" : "Open preview"}
      </button>
      <div
        style={{ height: 620, overflow: "auto", marginTop: 20 }}
        data-benchmark-content
      >
        {scenario === "history" &&
          Array.from({ length: 500 }, (_, i) => (
            <article key={i}>
              <MessageMarkdown
                content={`### Synthetic message ${i + 1}\nA bounded saved response with **formatting**, a short list and a code block.\n\n- First observation\n- Second observation\n\n\`\`\`js\nconst result = ${i};\n\`\`\``}
              />
            </article>
          ))}
        {scenario === "table" && <MessageMarkdown content={table} />}
        {scenario === "stream" && (
          <MessageMarkdown
            content={`### Synthetic streaming response\n${"A bounded update. ".repeat(tick)}\nFrame ${tick}`}
          />
        )}
        {scenario === "files" && (
          <ul>
            {artifacts.map((item) => (
              <li key={item.artifact.id}>{item.artifact.title}</li>
            ))}
          </ul>
        )}
        {preview && (
          <section aria-label="Benchmark preview">
            <MessageMarkdown content={table} />
          </section>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
