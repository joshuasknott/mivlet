import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeCommandRepositoryReview } from "@mivlet/protocol";
import { CodingRepositoryReview } from "./CodingRepositoryReview";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../../../runtime-scope";
vi.mock("../../../runtime/domains/command-jobs", () => ({ inspectNativeCommandRepository: vi.fn() }));
const target = { workspaceId: "workspace", agentId: "agent", expectedGeneration: 4, jobId: "a".repeat(48), jobGeneration: 4 };
const repositoryId = "b".repeat(48);
const receipt = (patch: Partial<NativeCommandRepositoryReview> = {}): NativeCommandRepositoryReview => ({
  jobId: target.jobId, jobGeneration: 4,
  repository: { id: repositoryId, name: "Portfolio", branch: "mivlet/task", base: "base", baseBranch: "main", remote: null, operation: "idle", lastResult: null, lastCommand: null, commandDiffId: null, publication: null },
  files: ["src/app.tsx", "README.md"], truncated: false, busy: false, recoveryRequired: false,
  changes: { head: "head", diffId: "tree", diff: "+ <script>example</script>", files: "M src/app.tsx", truncated: false }, ...patch,
});
beforeEach(() => setActiveRuntimeDataScope("workspace", "account-a"));
afterEach(() => { cleanup(); clearActiveRuntimeDataScope(); vi.useRealTimers(); });

it("reads only the exact job target and renders real file paths and escaped changes", async () => {
  const readRepository = vi.fn().mockResolvedValue(receipt());
  const view = render(<CodingRepositoryReview target={target} repositoryId={repositoryId} view="files" readRepository={readRepository} />);
  await screen.findByText("src/app.tsx");
  expect(readRepository).toHaveBeenCalledWith(target);
  expect(screen.getByText(/Current state of this task/)).toBeTruthy();
  view.rerender(<CodingRepositoryReview target={target} repositoryId={repositoryId} view="changes" readRepository={readRepository} />);
  expect(await screen.findByLabelText("Task repository diff")).toHaveTextContent("+ <script>example</script>");
  expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByRole("button", { name: /approve|select|edit|delete/i })).toBeNull();
});

it.each(["jobId", "jobGeneration", "repository"] as const)("rejects a retargeted %s receipt", async (key) => {
  const result = receipt();
  if (key === "repository") result.repository = { ...result.repository, id: "c".repeat(48) };
  else if (key === "jobId") result.jobId = "d".repeat(48);
  else result.jobGeneration = 5;
  render(<CodingRepositoryReview target={target} repositoryId={repositoryId} view="files" readRepository={async () => result} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer matches");
  expect(screen.queryByText("src/app.tsx")).toBeNull();
});

it("ignores a late result after the owner changes", async () => {
  let finish!: (value: NativeCommandRepositoryReview) => void;
  const readRepository = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(receipt({ files: ["current.txt"] }));
  const view = render(<CodingRepositoryReview target={target} repositoryId={repositoryId} view="files" readRepository={readRepository} />);
  view.rerender(<CodingRepositoryReview target={{ ...target, agentId: "other-agent" }} repositoryId={repositoryId} view="files" readRepository={readRepository} />);
  await screen.findByText("current.txt");
  await act(async () => finish(receipt()));
  expect(screen.queryByText("src/app.tsx")).toBeNull();
  expect(screen.getByText("current.txt")).toBeTruthy();
});

it("does not adopt a response across an account change in the same workspace", async () => {
  let finish!: (value: NativeCommandRepositoryReview) => void;
  render(<CodingRepositoryReview target={target} repositoryId={repositoryId} view="files" readRepository={() => new Promise(resolve => { finish = resolve; })} />);
  setActiveRuntimeDataScope("workspace", "account-b");
  await act(async () => finish(receipt()));
  expect(await screen.findByRole("alert")).toHaveTextContent("account or workspace changed");
  expect(screen.queryByText("src/app.tsx")).toBeNull();
});

it("bounds stalled reads and only accepts a deliberate new refresh", async () => {
  vi.useFakeTimers();
  let finish!: (value: NativeCommandRepositoryReview) => void;
  const readRepository = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(receipt());
  render(<CodingRepositoryReview target={target} repositoryId={repositoryId} view="files" readRepository={readRepository} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByRole("alert")).toHaveTextContent("did not respond");
  await act(async () => finish(receipt({ files: ["late.txt"] })));
  expect(screen.queryByText("late.txt")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh files" })));
  expect(screen.getByText("src/app.tsx")).toBeTruthy();
  expect(readRepository).toHaveBeenCalledTimes(2);
});

it("distinguishes no changes, unavailable changes, and truncated recovery evidence", async () => {
  const readRepository = vi.fn().mockResolvedValueOnce(receipt({ changes: { head: "head", diffId: "tree", diff: "", files: "", truncated: false } }))
    .mockResolvedValueOnce(receipt({ changes: null, busy: true, recoveryRequired: true, truncated: true }));
  render(<CodingRepositoryReview target={target} repositoryId={repositoryId} view="changes" readRepository={readRepository} />);
  await screen.findByText("No changes from the starting commit.");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh changes" })));
  expect(screen.queryByText("No changes from the starting commit.")).toBeNull();
  expect(screen.getByText(/Changes are unavailable/)).toBeTruthy();
  expect(screen.getByText(/review is truncated/)).toBeTruthy();
  expect(screen.getByRole("alert")).toHaveTextContent("needs recovery");
});
