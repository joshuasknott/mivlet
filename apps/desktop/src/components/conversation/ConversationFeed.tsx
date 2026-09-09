import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConnectorManifest, FableAgentProfile } from "@fable/protocol";
import type { NativeAgentState } from "../../hooks/useNativeAgent";
import type { ConversationMessageView } from "../../lib/conversation-runtime";
import { conversationTurns, toolActivity, toolFailureSummary, type ConversationTurn, type ResponsePart } from "../../lib/conversation-presentation";
import { parseComputerArtifact } from "../../lib/computer-artifacts";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { agentPresence, type AgentPresence } from "../../lib/agent-presence";
import { ConnectorMentionText } from "../ConnectorMention";
import { ComputerArtifacts } from "../ComputerArtifacts";
import { MessageMarkdown } from "./MessageMarkdown";
import "./conversation.css";

interface Props {
  messages: ConversationMessageView[];
  agent: FableAgentProfile;
  state: NativeAgentState;
  presence?: AgentPresence;
  threadId?: string;
  profileName: string;
  connectors: ConnectorManifest[];
  optimisticPrompt: string;
  workspaceId: string;
  generation?: number;
  approval?: ReactNode;
  interruption?: ReactNode;
  onPreviewArtifact?: (output: string) => void;
  onOpenConnector?: (connectorId: string) => void;
}

export function ConversationFeed(props: Props) {
  const { state, threadId } = props;
  const live = state.currentAttemptId && state.progressThreadId === threadId;
  const turns = useMemo(() => conversationTurns(props.messages), [props.messages]);
  const presented = [...turns];
  if (live) {
    const index = presented.findIndex((turn) => turn.id === state.currentAttemptId);
    const canonical = presented[index];
    const redacted = props.messages.some((entry) => entry.message.runId === state.currentAttemptId && entry.currentRevision.state === "redacted");
    const canonicalReady = canonical && !state.running && (redacted ||
      canonical.parts.filter((part) => part.kind === "text").map((part) => part.content).join("") === state.transcript);
    const turn: ConversationTurn = {
      id: state.currentAttemptId!, prompt: state.progressPrompt ?? props.optimisticPrompt,
      parts: canonicalReady ? canonical.parts : state.responseParts ?? (state.transcript ? [{ id: "text", kind: "text", content: state.transcript }] : []),
      startedAt: state.startedAt, endedAt: state.endedAt,
    };
    if (index < 0) presented.push(turn); else presented[index] = { ...turn, prompt: canonical.prompt ?? turn.prompt };
  }
  return <>
    {presented.map((turn) => <Turn key={turn.id} turn={turn} {...props}
      live={Boolean(live && turn.id === state.currentAttemptId)} />)}
    {props.optimisticPrompt && (!live || props.optimisticPrompt !== state.progressPrompt) ? <UserMessage content={props.optimisticPrompt} {...props} /> : null}
    {!live && (props.approval || props.interruption) ? <div className="conversation-attention">{props.approval}{props.interruption}</div> : null}
  </>;
}

function UserMessage({ content, profileName, connectors }: { content: string; profileName: string; connectors: ConnectorManifest[] }) {
  return <article className="conversation-message conversation-message--user" aria-label={`${profileName}'s message`}>
    <p><ConnectorMentionText text={content} connectors={connectors} /></p>
  </article>;
}

function Turn({ turn, live, ...props }: Props & { turn: ConversationTurn; live: boolean }) {
  const running = live && props.state.running;
  const [disclosure, setDisclosure] = useState({ running, open: false });
  const expanded = disclosure.running === running && disclosure.open;
  const [clock, setClock] = useState(Date.now());
  const [savedSummary, setSavedSummary] = useState("");
  const receipt = props.state.progressReceipts?.[turn.id];
  const summary = live ? Object.values(props.state.reasoningSummaries ?? {}).join("\n\n") : Object.values(receipt?.summaries ?? {}).join("\n\n") || savedSummary;
  useEffect(() => { if (live && summary) setSavedSummary(summary); }, [live, summary]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const startedAt = receipt?.startedAt ?? turn.startedAt;
  const endedAt = receipt?.endedAt ?? turn.endedAt;
  const elapsed = startedAt ? Math.max(0, Math.floor(((running ? clock : Date.parse(endedAt ?? startedAt)) - Date.parse(startedAt)) / 1000)) : 0;
  const duration = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
  const lastText = turn.parts.reduce((last, part, index) => part.kind === "text" ? index : last, -1);
  const lastTool = turn.parts.reduce((last, part, index) => part.kind === "tool" ? index : last, -1);
  const final = !running && lastText >= 0 && lastText > lastTool ? turn.parts[lastText] : undefined;
  const work = turn.parts.filter((part, index) => part.kind !== "notice" && (!final || index !== lastText));
  const notices = turn.parts.filter((part) => part.kind === "notice" && (!live || (!props.state.lastError && props.state.status !== "cancelled")));
  const failed = work.filter((part) => part.kind === "tool" && part.state === "failed").length;
  const hasActivity = work.length > 0 || Boolean(summary) || running;
  const outputs = turn.parts.filter((part) => part.kind === "tool" && part.state === "succeeded" && parseComputerArtifact(part.content));
  const files = outputs.filter((part, index) => outputs.findIndex((other) => parseComputerArtifact(other.content)?.id === parseComputerArtifact(part.content)?.id) === index);
  const stopped = live && props.state.status === "cancelled";
  const label = running ? props.approval ? "Waiting for your approval" : "Working" : stopped ? "Stopped" : elapsed > 0 ? `Worked for ${duration}` : "Worked";
  const currentTool = [...turn.parts].reverse().find((part) => part.kind === "tool" && part.state === "running");
  const activity = props.state.activity || (currentTool?.kind === "tool" ? toolActivity(currentTool.tool, "running") : "");
  if (!turn.parts.length && !running && !live) return turn.prompt ? <UserMessage content={turn.prompt} {...props} /> : null;
  return <section className="conversation-turn">
    {turn.prompt ? <UserMessage content={turn.prompt} {...props} /> : null}
    <article className="conversation-response" aria-label={`${props.agent.name}'s response`}>
      <header className="conversation-response__author"><ProfileAgentAvatar agent={props.agent} iconSize={28} motion={live ? "expressive" : "quiet"} presence={live ? props.presence ?? agentPresence(props.state, Boolean(props.approval)) : "idle"} /><strong>{props.agent.name}</strong></header>
      {hasActivity ? <details className="turn-activity" open={expanded}>
        <summary onClick={(event) => { event.preventDefault(); setDisclosure({ running, open: !expanded }); }}>
          <span>{label}</span>
          <svg className="turn-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {failed ? <span className="turn-warning"> · {failed} failed {failed === 1 ? "attempt" : "attempts"}</span> : null}
        </summary>
        {expanded ? <div className="turn-activity__body">
          {summary ? <MessageMarkdown content={summary} /> : null}
          {work.map((part) => <Part key={`${part.kind}:${part.id}`} part={part} running={running} onOpenConnector={props.onOpenConnector} />)}
        </div> : null}
      </details> : null}
      {running && activity && !props.approval && !expanded ? <p className="turn-current" role="status">{activity}</p> : null}
      {final?.kind === "text" ? <div className="turn-answer"><MessageMarkdown content={final.content} /></div> : null}
      {notices.map((part) => <Part key={`${part.kind}:${part.id}`} part={part} running={false} />)}
      {files.length ? <div className="turn-files" aria-label="Files from this response">{files.map((part) => <ComputerArtifacts key={part.id} output={part.content}
        workspaceId={props.workspaceId} agentId={props.agent.id} expectedGeneration={props.generation} onPreview={props.onPreviewArtifact} />)}</div> : null}
      {live ? <>{props.approval ? <div className="conversation-attention">{props.approval}</div> : null}{props.interruption}</> : null}
    </article>
  </section>;
}

function Part({ part, running, onOpenConnector }: { part: ResponsePart; running: boolean; onOpenConnector?: (connectorId: string) => void }) {
  if (part.kind === "text") return <MessageMarkdown content={part.content} />;
  if (part.kind === "notice") return <p className={part.error ? "turn-warning" : "turn-notice"}>{part.content}</p>;
  const pending = part.state === "running" && !running;
  return <div className={`turn-tool${part.state === "failed" ? " turn-tool--failed" : ""}`}>
    <span aria-hidden="true">{part.state === "succeeded" ? "✓" : part.state === "failed" || pending ? "!" : "·"}</span>
    {pending ? "Action interrupted" : toolActivity(part.tool, part.state, part.connectorId)}
    {part.state === "failed" ? <p className="turn-tool__error">{toolFailureSummary(part.content)}
      {part.connectorId && onOpenConnector && /connect|sign.in|permission|authoriz|access|expired/i.test(part.content) ? <button type="button" onClick={() => onOpenConnector(part.connectorId!)}>Reconnect</button> : null}
    </p> : null}
  </div>;
}
