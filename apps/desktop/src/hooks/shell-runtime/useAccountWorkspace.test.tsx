import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as account from "../../runtime/domains/account";
import { useAccountWorkspace } from "./useAccountWorkspace";
import { DEFAULT_ACCOUNT_WORKSPACE_STATUS, PREVIEW_ACCOUNT_WORKSPACE_STATUS, PREVIEW_IDENTITY_STATUS } from "./defaults";

vi.mock("../../runtime/domains/account", () => ({
  loadRuntimeIdentityStatus: vi.fn(), loadRuntimeAccountWorkspaceStatus: vi.fn(),
  prepareRuntimeIdentitySignIn: vi.fn(), beginRuntimeIdentitySignIn: vi.fn(),
  cancelRuntimeIdentitySignIn: vi.fn(), reconcileRuntimeAccountWorkspace: vi.fn(),
  beginRuntimeIdentityRecovery: vi.fn(), refreshRuntimeIdentity: vi.fn(),
  signOutRuntimeIdentity: vi.fn(), clearRuntimeAccountWorkspaceSession: vi.fn(),
}));
const signedOut = { enabled: true, state: "signed-out" as const, scopes: [], message: "Sign in." };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  return renderHook(() => useAccountWorkspace({ onScopeChange: vi.fn(), shouldReload: () => false, setLastAction: vi.fn() }));
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  vi.mocked(account.loadRuntimeIdentityStatus).mockResolvedValue(signedOut);
  vi.mocked(account.loadRuntimeAccountWorkspaceStatus).mockResolvedValue(DEFAULT_ACCOUNT_WORKSPACE_STATUS);
  vi.mocked(account.prepareRuntimeIdentitySignIn).mockResolvedValue("first");
  vi.mocked(account.cancelRuntimeIdentitySignIn).mockResolvedValue(true);
});
afterEach(() => { Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: undefined }); });

it("cancels the exact request, allows retry, and ignores an old completion", async () => {
  const first = deferred<typeof PREVIEW_IDENTITY_STATUS>();
  const second = deferred<typeof PREVIEW_IDENTITY_STATUS>();
  vi.mocked(account.beginRuntimeIdentitySignIn).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result } = setup();
  await waitFor(() => expect(result.current.runtime.accountWorkspacePending).toBe(false));
  let firstRun!: Promise<void>;
  act(() => { firstRun = result.current.runtime.signInIdentity("sign-up"); });
  await waitFor(() => expect(account.beginRuntimeIdentitySignIn).toHaveBeenCalledWith("first", "sign-up"));
  await act(() => result.current.runtime.cancelIdentitySignIn());
  expect(account.cancelRuntimeIdentitySignIn).toHaveBeenCalledWith("first");
  vi.mocked(account.prepareRuntimeIdentitySignIn).mockResolvedValue("second");
  let secondRun!: Promise<void>;
  act(() => { secondRun = result.current.runtime.signInIdentity(); });
  await act(async () => { first.resolve(PREVIEW_IDENTITY_STATUS); await firstRun; });
  expect(result.current.runtime.identityPending).toBe(true);
  expect(result.current.runtime.identityStatus.state).toBe("signed-out");
  vi.mocked(account.loadRuntimeAccountWorkspaceStatus).mockResolvedValue(PREVIEW_ACCOUNT_WORKSPACE_STATUS);
  await act(async () => { second.resolve(PREVIEW_IDENTITY_STATUS); await secondRun; });
  expect(result.current.runtime.accountWorkspaceStatus.accountBound).toBe(true);
  expect(account.reconcileRuntimeAccountWorkspace).not.toHaveBeenCalled();
});

it("handles Back while native preparation is still pending without launching a browser", async () => {
  const prepared = deferred<string>();
  vi.mocked(account.prepareRuntimeIdentitySignIn).mockReturnValue(prepared.promise);
  const { result } = setup();
  await waitFor(() => expect(result.current.runtime.accountWorkspacePending).toBe(false));
  let run!: Promise<void>;
  let cancel!: Promise<void>;
  act(() => { run = result.current.runtime.signInIdentity(); });
  act(() => { cancel = result.current.runtime.cancelIdentitySignIn(); });
  await act(async () => { prepared.resolve("first"); await Promise.all([run, cancel]); });
  expect(account.beginRuntimeIdentitySignIn).not.toHaveBeenCalled();
  expect(account.cancelRuntimeIdentitySignIn).toHaveBeenCalledWith("first");
  expect(result.current.runtime.identityPending).toBe(false);
});

it("keeps startup loading until identity and workspace agree", async () => {
  const identity = deferred<typeof PREVIEW_IDENTITY_STATUS>();
  vi.mocked(account.loadRuntimeIdentityStatus).mockReturnValue(identity.promise);
  vi.mocked(account.loadRuntimeAccountWorkspaceStatus).mockResolvedValue(PREVIEW_ACCOUNT_WORKSPACE_STATUS);
  const { result } = setup();
  await waitFor(() => expect(result.current.runtime.accountWorkspaceStatus.accountBound).toBe(true));
  expect(result.current.runtime.accountWorkspacePending).toBe(true);
  await act(async () => identity.resolve(PREVIEW_IDENTITY_STATUS));
  expect(result.current.runtime.accountWorkspacePending).toBe(false);
  expect(result.current.runtime.identityStatus.state).toBe("signed-in");
});
