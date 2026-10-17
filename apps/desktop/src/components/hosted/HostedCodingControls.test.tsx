import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_CODING_IMAGE, type ApprovalResolutionResponse, type CollaborationWorkItem, type HostedRepositoryImportReview, type HostedTaskSnapshot } from "@mivlet/protocol";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../../runtime-scope";
import { HostedCodingImport } from "./HostedCodingImport";
import { HostedCodingSelection } from "./HostedCodingSelection";
import { emptyCodingSelection, prepareCodingSelection } from "./hosted-coding-selection";
import type { HostedCodingApi } from "./hosted-coding-api";
import { useState } from "react";

const candidates = { repositoryId: "repo", files: [{ path: "src/index.ts", sizeBytes: 18 }, { path: "README.md", sizeBytes: 9 }], truncated: true };
const repository = { version: 1 as const, snapshotId: "snapshot", repositoryId: "repo", branch: "task", baseCommit: "base", inputTreeId: "tree", manifestSha256: "a".repeat(64), files: [{ path: "src/index.ts", sizeBytes: 18, sha256: "b".repeat(64) }], writablePaths: ["src/index.ts"], totalBytes: 18 };
const output = { version: 1 as const, snapshotId: "snapshot", inputManifestSha256: repository.manifestSha256, outputManifestSha256: "c".repeat(64), files: [{ path: "src/index.ts", sizeBytes: 19, sha256: "d".repeat(64) }], deletedPaths: [], totalBytes: 19 };
const item = { id: "work", workspaceId: "workspace", agentId: "agent", generation: 8 } as CollaborationWorkItem;
const snapshot: HostedTaskSnapshot = { binding: { version: 3, mode: "offline-coding", taskId: "cloud-task", admissionId: "admit", runId: "run", workspaceId: "workspace", agentId: "agent", workId: "work", workGeneration: 4, conversationId: "chat", conversationGeneration: 1, expectedSequence: 0, inputSha256: "a".repeat(64), providerId: "openai", model: "saved-model", credentialId: "cloud-key", credentialRevision: 4, expiresAt: Date.now() + 60000, budget: { maxModelCalls: 4, maxToolCalls: 8, maxOutputTokens: 4096, maxElapsedMs: 120000, maxResultBytes: 65536 }, repository: { snapshot: repository, scope: { writablePaths: ["src/index.ts"], checks: [], image: HOSTED_CODING_IMAGE, network: "disabled" } } }, generation: 1, status: "completed", sequence: 3, resultBytes: 0, createdAt: Date.now(), updatedAt: Date.now(), retainedUntil: Date.now() + 86400000, coding: { modelCalls: 2, toolCalls: 2, allocatedOutputTokens: 2048, completedChecks: [], output } };
const review = (): HostedRepositoryImportReview => ({ reviewId: "import-review", snapshot: repository, output, currentTreeId: "tree", outputTreeId: "result-tree", head: "base", computerGeneration: 2, expiresAt: Date.now() + 60000, changes: [{ path: "src/index.ts", status: "modified" }], diff: "+<script>literal</script>", truncated: false, approval: { id: "approval", service: "hosted-repository", action: "import", mode: "read-only", riskLevel: "high", dataUsed: ["Returned files"], consequence: "Replace the reviewed files once.", requestedAt: "2026-10-17T00:00:00Z", decisions: ["once", "deny"] } });
function api(): HostedCodingApi {
  return { prepare: vi.fn(), candidates: vi.fn(), reviewImport: vi.fn(async () => review()), applyImport: vi.fn(async () => ({ snapshotId: "snapshot", repositoryId: "repo", outputManifestSha256: output.outputManifestSha256, outputTreeId: "result-tree", beforeImportCheckpointId: "checkpoint", verificationInvalidated: true as const })) };
}
const approved = (request: HostedRepositoryImportReview["approval"]) => ({ persisted: true, auditEntry: { requestId: request.id, decision: "once" }, effectiveRequest: request, dismissed: true } as ApprovalResolutionResponse);
function props(actions = api()) {
  return { item, snapshot, api: actions, approve: vi.fn(async (resolution: { request: HostedRepositoryImportReview["approval"] }) => approved(resolution.request)), onChanged: vi.fn(async () => {}), onStop: vi.fn(), disabled: false };
}
async function openImport() {
  fireEvent.click(screen.getByRole("button", { name: "Review returned changes" }));
  await screen.findByRole("dialog", { name: "Review cloud changes" });
}
beforeEach(() => setActiveRuntimeDataScope("workspace", "account-a"));
afterEach(() => clearActiveRuntimeDataScope());

it("requires explicit file read and write selection and removes writes when read access is removed", () => {
  function Selection() { const [value, setValue] = useState(emptyCodingSelection); return <HostedCodingSelection candidates={candidates} value={value} onChange={setValue} onLoad={() => {}} disabled={false} />; }
  render(<Selection />);
  const share = screen.getByRole("checkbox", { name: "Share src/index.ts" });
  const write = screen.getByRole("checkbox", { name: "Allow changes to src/index.ts" });
  expect(share).not.toBeChecked(); expect(write).toBeDisabled();
  fireEvent.click(share); expect(write).toBeEnabled(); expect(write).not.toBeChecked();
  fireEvent.click(write); expect(write).toBeChecked();
  fireEvent.click(share); expect(write).not.toBeChecked(); expect(write).toBeDisabled();
});

it("binds exact selected paths and argument arrays and refuses hidden, stale, shell and alias expansions", () => {
  const selection = { ...emptyCodingSelection(), selectedPaths: ["src/index.ts"], writablePaths: ["src/index.ts"], newPaths: "src/menu.ts", checks: '["/usr/bin/python3","-m","unittest"]' };
  expect(prepareCodingSelection(selection, candidates)).toEqual({ selectedPaths: ["src/index.ts"], writablePaths: ["src/index.ts", "src/menu.ts"], checks: [{ id: "check-1", argv: ["/usr/bin/python3", "-m", "unittest"] }] });
  for (const patch of [{ selectedPaths: [] }, { selectedPaths: ["missing.ts"] }, { writablePaths: ["README.md"] }, { newPaths: ".env" }, { newPaths: "src/INDEX.ts" }, { checks: '["/bin/sh","-c","test"]' }, { checks: "python -m unittest" }]) {
    expect(() => prepareCodingSelection({ ...selection, ...patch }, candidates)).toThrow();
  }
});

it("shows literal diffs and applies only after exact separate approval", async () => {
  const p = props(); render(<HostedCodingImport {...p} />); await openImport();
  expect(screen.getByText("+<script>literal</script>")).toBeVisible();
  expect(document.querySelector(".hosted-coding-diff script")).toBeNull();
  expect(p.api.applyImport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import changes once" }));
  await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
  expect(p.api.applyImport).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: 8, snapshotId: "snapshot", outputManifestSha256: output.outputManifestSha256, reviewId: "import-review", resolution: expect.objectContaining({ decision: "once" }) }));
});

it("retains uncertain import evidence without replaying the attempt", async () => {
  const actions = api(); actions.applyImport = vi.fn().mockRejectedValue(new Error("Import reply lost; refresh status."));
  render(<HostedCodingImport {...props(actions)} />); await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Import changes once" }));
  await screen.findByText("Import reply lost; refresh status.");
  expect(screen.getByRole("button", { name: "Import changes once" })).toBeDisabled();
  expect(actions.applyImport).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Keep changes for later" })).toBeEnabled();
});

it("rejects a mismatching native output before presenting an import approval", async () => {
  const actions = api(); actions.reviewImport = vi.fn(async () => ({ ...review(), output: { ...output, totalBytes: 20 } }));
  const p = props(actions); render(<HostedCodingImport {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Review returned changes" }));
  await screen.findByText(/returned files or task changed/);
  expect(screen.queryByRole("dialog")).toBeNull(); expect(p.approve).not.toHaveBeenCalled();
});

it("ignores a late review after the account changes", async () => {
  let finish!: (value: HostedRepositoryImportReview) => void;
  const actions = api(); actions.reviewImport = vi.fn(() => new Promise<HostedRepositoryImportReview>(resolve => { finish = resolve; }));
  render(<HostedCodingImport {...props(actions)} />);
  fireEvent.click(screen.getByRole("button", { name: "Review returned changes" }));
  setActiveRuntimeDataScope("workspace", "account-b");
  await act(async () => finish(review()));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(actions.applyImport).not.toHaveBeenCalled();
});

it("keeps Stop inside the focused import dialog and prevents apply after a pending approval", async () => {
  let finish!: (value: ApprovalResolutionResponse) => void;
  const p = props(); p.approve = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  render(<HostedCodingImport {...p} />); await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Import changes once" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
  await act(async () => finish(approved(review().approval)));
  expect(p.onStop).toHaveBeenCalledTimes(1); expect(p.api.applyImport).not.toHaveBeenCalled();
});

it("rejects an approval completed after the Work generation changes", async () => {
  let finish!: (value: ApprovalResolutionResponse) => void;
  const p = props(); p.approve = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<HostedCodingImport {...p} />); await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Import changes once" }));
  view.rerender(<HostedCodingImport {...p} item={{ ...item, generation: 9 }} />);
  await act(async () => finish(approved(review().approval)));
  expect(p.api.applyImport).not.toHaveBeenCalled();
});

it("prevents apply when a parent Stop or unavailable state arrives during approval", async () => {
  let finish!: (value: ApprovalResolutionResponse) => void;
  const p = props(); p.approve = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<HostedCodingImport {...p} />); await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Import changes once" }));
  view.rerender(<HostedCodingImport {...p} disabled />);
  await act(async () => finish(approved(review().approval)));
  expect(p.api.applyImport).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Import changes once" })).toBeDisabled();
});

it("does not revive pending import authority after a temporary parent Stop clears", async () => {
  let finish!: (value: ApprovalResolutionResponse) => void;
  const p = props(); p.approve = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<HostedCodingImport {...p} />); await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Import changes once" }));
  view.rerender(<HostedCodingImport {...p} disabled />);
  view.rerender(<HostedCodingImport {...p} />);
  await act(async () => finish(approved(review().approval)));
  expect(p.api.applyImport).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Import changes once" })).toBeDisabled();
});
