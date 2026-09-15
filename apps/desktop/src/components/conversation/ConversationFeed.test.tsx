import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import type { NativeAgentState } from "../../hooks/useNativeAgent";
import { ConversationFeed } from "./ConversationFeed";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { MessageMarkdown } from "./MessageMarkdown";

const agent: MivletAgentProfile = { id: "a", name: "Chief of Staff", icon: "agent", iconColor: "#24bb77", instructions: "", modelId: "", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" };
const initial: NativeAgentState = { transcript: "", usage: null, running: true, lastError: null, status: "streaming", recoverableAttempts: [], contextReceipts: {}, providerRoutes: {}, usageReceipts: {}, currentAttemptId: "run-1", noTransport: false, progressThreadId: "thread-1", progressPrompt: "Check the files", responseParts: [
  { id: "text-0", kind: "text", content: "I’ll check the files." },
  { id: "call-1", kind: "tool", tool: "read-file", content: "", state: "running" },
] };
const props = { messages: [], agent, threadId: "thread-1", profileName: "Joshua", connectors: [], optimisticPrompt: "", workspaceId: "workspace-1" };

describe("conversation turns", () => {
  it("keeps a request rejected before execution visible and reusable", () => {
    const reuse = vi.fn();
    render(<ConversationFeed {...props} state={{ ...initial, currentAttemptId: null, running: false }} onReusePrompt={reuse} pendingTurns={[{ id: "failed", prompt: "Create the fixture file", startedAt: "2026-09-12T10:00:00Z", parts: [{ id: "error", kind: "notice", error: true, content: "Computer status unavailable" }] }]} />);
    expect(screen.getByText("Create the fixture file")).toBeVisible();
    expect(screen.getByText("Computer status unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit & resend" }));
    expect(reuse).toHaveBeenCalledWith("Create the fixture file", "edit");
    expect(screen.getByRole("button", { name: "Copy message" })).toBeVisible();
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-09-12T10:00:00Z");
  });
  it("offers workspace files only after a successful file tool result", () => {
    const open = vi.fn();
    const view = render(<ConversationFeed {...props} onOpenWorkspaceFiles={open} state={{ ...initial, running: false, responseParts: [{ id: "write", kind: "tool", tool: "write-file", state: "succeeded", content: "Saved fixture.txt" }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open workspace files" }));
    expect(open).toHaveBeenCalledWith("a");
    view.rerender(<ConversationFeed {...props} onOpenWorkspaceFiles={open} state={{ ...initial, running: false, responseParts: [{ id: "text", kind: "text", content: "I saved fixture.txt" }] }} />);
    expect(screen.queryByRole("button", { name: "Open workspace files" })).toBeNull();
  });
  it("surfaces a confirmed decision with its provenance and later state", () => {
    render(<ConversationFeed {...props} state={{ ...initial, currentAttemptId: null, running: false }} decisionEvents={[{ id: "decision", projectId: "project", conversationId: "thread-1", kind: "decision", text: "Use the blue banner", confidence: "confirmed", status: "superseded", source: "Confirmed by you", createdAt: "2026-09-12T10:00:00Z" }]} />);
    const event = screen.getByLabelText("Confirmed project decision");
    expect(event).toHaveTextContent("Decision confirmed · superseded");
    expect(event).toHaveTextContent("Use the blue banner");
    expect(event).toHaveTextContent("Confirmed by you");
  });
  it("omits repeated direct-chat identity but preserves project attribution", () => {
    const view = render(<ConversationFeed {...props} showAuthor={false} state={initial} />);
    expect(screen.queryByText("Chief of Staff")).toBeNull();
    expect(screen.getByRole("article", { name: "Chief of Staff's response" })).toBeVisible();
    view.rerender(<ConversationFeed {...props} showAuthor={false} requireAuthor authors={{ "run-1": agent }} state={initial} />);
    expect(screen.getByText("Chief of Staff")).toBeVisible();
  });
  it("uses recorded project authors and hides synthetic handoff prompts", () => {
    const view = render(<ConversationFeed {...props} requireAuthor suppressLivePrompt authors={{ "run-1": { ...agent, id: "leo", name: "Leo" } }} state={initial} />);
    expect(screen.getByText("Leo")).toBeVisible();
    expect(screen.queryByText("Chief of Staff")).toBeNull();
    expect(screen.queryByText("Check the files")).toBeNull();
    view.rerender(<ConversationFeed {...props} requireAuthor suppressLivePrompt authors={{}} state={initial} />);
    expect(screen.getByText("Agent")).toBeVisible();
    expect(screen.queryByText("Chief of Staff")).toBeNull();
  });
  it("keeps one author and one action as a stream finishes; collapses routine work", () => {
    const view = render(<ConversationFeed {...props} state={initial} />);
    expect(screen.getAllByText("Chief of Staff")).toHaveLength(1);
    expect(screen.getByText("Reading a file")).toBeVisible();
    expect(screen.queryByText("Reasoning summary")).toBeNull();
    view.rerender(<ConversationFeed {...props} state={{ ...initial, running: false, status: "completed", responseParts: [
      initial.responseParts![0], { id: "call-1", kind: "tool", tool: "read-file", state: "succeeded", content: "Found the file." },
      { id: "text-2", kind: "text", content: "**All done.** Here is the result." },
    ] }} />);
    expect(screen.getByText("Worked").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("All done.")).toBeVisible();
    expect(screen.getAllByText("Chief of Staff")).toHaveLength(1);
    fireEvent.click(screen.getByText("Worked"));
    expect(screen.getByText("Read a file")).toBeVisible();
    expect(screen.queryByText("Reading a file")).toBeNull();
  });
  it("hides traces until clicked, shows a single flat disclosure, and collapses on completion", () => {
    const state = { ...initial, startedAt: "2026-09-06T12:00:00Z", reasoningSummaries: { r1: "Comparing the evidence." } };
    const view = render(<ConversationFeed {...props} state={state} />);
    expect(screen.queryByText("Comparing the evidence.")).toBeNull();
    expect(screen.queryByText("I’ll check the files.")).toBeNull();
    expect(screen.getByText("Reading a file")).toBeVisible();
    fireEvent.click(screen.getByText("Working"));
    expect(screen.getByText("Comparing the evidence.")).toBeVisible();
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
    view.rerender(<ConversationFeed {...props} state={{ ...state, running: false, status: "completed", endedAt: "2026-09-06T12:00:06Z" }} />);
    expect(screen.getByText("Worked for 6s").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("Comparing the evidence.")).toBeNull();
    fireEvent.click(screen.getByText("Worked for 6s"));
    expect(screen.getByText("Comparing the evidence.")).toBeVisible();
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
  });
  it("does not show another thread's live text or summaries", () => {
    render(<ConversationFeed {...props} threadId="other-thread" state={{ ...initial, reasoningSummaries: { secret: "Other thread summary" } }} />);
    expect(screen.queryByText("I’ll check the files.")).toBeNull();
    expect(screen.queryByText("Other thread summary")).toBeNull();
  });
  it("keeps failures visible when activity is collapsed", () => {
    render(<ConversationFeed {...props} state={{ ...initial, running: false, responseParts: [{ id: "call-1", kind: "tool", tool: "read-file", state: "failed", content: "File missing" }] }} />);
    expect(screen.getByText(/1 failed attempt/)).toBeVisible();
  });
  it("leaves uploaded portrait colours intact", () => {
    const view = render(<ProfileAgentAvatar agent={{ ...agent, iconImageDataUrl: "data:image/png;base64,a" }} thinking />);
    expect(view.container.querySelector("img")?.style.filter).toBe("");
  });
  it("shows a submitted attachment's durable name and readable workspace handle", () => {
    const messages = [{
      message: { id: "message-1", threadId: "thread-1", runId: "run-file", kind: "user", sequence: 1, createdAt: "2026-09-10T12:00:00Z", detail: { attachments: [{ id: "attachment-1", name: "totals.csv", mimeType: "text/csv", sizeBytes: 24, availability: "workspace-file", relativePath: "Attachments/totals-a1.csv" }] } },
      currentRevision: { state: "terminal", content: "Calculate totals", checkpointedAt: "2026-09-10T12:00:01Z" },
    }] as never;
    render(<ConversationFeed {...props} messages={messages} state={{ ...initial, running: false, status: "completed", currentAttemptId: null }} />);
    expect(screen.getByText("totals.csv")).toBeVisible();
    expect(screen.getByText("Attachments/totals-a1.csv")).toBeVisible();
  });
});

describe("assistant Markdown", () => {
  it("decodes prose entities while preserving literal code and escaped HTML as text", () => {
    const view = render(<MessageMarkdown content={'A &amp; B &lt;img src=x onerror=alert(1)&gt;\n\n`&amp;`'} />);
    expect(view.container.querySelector("p")).toHaveTextContent("A & B <img src=x onerror=alert(1)>");
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("code")).toHaveTextContent("&amp;");
  });
  it("renders rich content without executing HTML or loading remote images", () => {
    const view = render(<MessageMarkdown content={'## Results\n\n- **First**\n- Second\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n\n```js\nconst answer = 42;\n```\n\n[Safe](https://example.com) [Unsafe](javascript:alert(1))\n\n<script>alert(1)</script>\n\n![Tracker](https://example.com/pixel.png)'} />);
    expect(screen.getByRole("heading", { name: "Results" })).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("link", { name: "Safe" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(view.container.querySelector("script,img")).toBeNull();
    expect(view.container.querySelector("pre code")).toHaveTextContent("const answer = 42;");
  });
});
