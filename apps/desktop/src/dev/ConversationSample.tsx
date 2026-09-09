import { useEffect, useState } from "react";
import type { FableAgentProfile } from "@fable/protocol";
import type { NativeAgentState } from "../hooks/useNativeAgent";
import { ConversationFeed } from "../components/conversation/ConversationFeed";

const artifact = JSON.stringify({ kind: "computer-artifact", version: 1, id: `artifact-${"a".repeat(64)}`, computerId: `local-${"b".repeat(24)}`, title: "Project comparison", relativePath: "project-comparison.md", mimeType: "text/markdown", sizeBytes: 2048, createdAt: "2026-09-06T12:00:00Z" });
const parts: NonNullable<NativeAgentState["responseParts"]> = [
  { id: "text-0", kind: "text", content: "I’ll compare your recent projects and check their READMEs for what each one does." },
  { id: "tool-1", kind: "tool", tool: "connector-search", state: "succeeded", content: "Found three recently updated repositories." },
  { id: "text-2", kind: "text", content: "Three projects have recent changes. I’m checking their features before choosing what to highlight." },
  { id: "tool-3", kind: "tool", tool: "read-file", state: "succeeded", content: "Read the three project summaries." },
  { id: "tool-4", kind: "tool", tool: "computer-artifact", state: "succeeded", content: artifact },
  { id: "text-5", kind: "text", content: "Here are the three projects worth highlighting.\n\n| Project | What stands out |\n| --- | --- |\n| Mivlet | A quiet workspace for working with AI teammates |\n| Memvella | A place to keep knowledge connected |\n| Surrey Societies | A shared home for society events and membership |\n\n**Mivlet is the strongest lead.** Its conversation and separate computer make the value easy to demonstrate.\n\nThe comparison is attached below. These descriptions are based on repository documentation; I haven’t tested the live products." },
];

/** Explicit sample data; never invokes a provider or executes a tool. */
export function ConversationSample({ agent, onPreviewArtifact }: { agent: FableAgentProfile; onPreviewArtifact: (output: string) => void }) {
  const [mode, setMode] = useState(() => new URLSearchParams(window.location.search).get("conversation") ?? "complete");
  const [step, setStep] = useState(mode === "stream" ? 1 : mode === "stopped" ? 3 : 6);
  const [startedAt] = useState(new Date(Date.now() - 42000).toISOString());
  useEffect(() => {
    if (mode !== "stream" || step >= 6) return;
    const timer = window.setTimeout(() => setStep((value) => value + 1), 1600);
    return () => window.clearTimeout(timer);
  }, [mode, step]);
  const running = mode === "stream" && step < 6;
  const state: NativeAgentState = {
    transcript: "", running, status: mode === "stopped" ? "cancelled" : running ? "streaming" : "completed",
    lastError: null, noTransport: true, usage: null, contextReceipts: {}, providerRoutes: {}, usageReceipts: {}, recoverableAttempts: [],
    currentAttemptId: "sample-run", progressThreadId: "sample-thread", progressPrompt: "Which projects should I highlight on my portfolio?",
    startedAt, endedAt: new Date(Date.parse(startedAt) + 42000).toISOString(),
    reasoningSummaries: { sample: "I’m comparing each project’s stated purpose and distinctive features. Recent changes help identify which projects are active." },
    responseParts: mode === "failure" ? [...parts.slice(0, 2), { id: "failed", kind: "tool", tool: "read-file", state: "failed", content: "The connection expired. Reconnect GitHub to read this file." }] : parts.slice(0, step),
  };
  return <>
    <ConversationFeed messages={[]} agent={agent} state={state} threadId="sample-thread" profileName="Joshua" connectors={[]} optimisticPrompt="" workspaceId="sample-workspace"
      onPreviewArtifact={onPreviewArtifact} interruption={mode === "stopped" ? <div className="conversation-attention"><p>Stopped. Your completed work is still here.</p><button onClick={() => { setMode("stream"); setStep(3); }}>Continue</button></div> : mode === "failure" ? <div className="conversation-attention"><p>Your GitHub connection has expired. Reconnect to continue.</p><button onClick={() => { setMode("stream"); setStep(3); }}>Reconnect (sample)</button></div> : null} />
  </>;
}
