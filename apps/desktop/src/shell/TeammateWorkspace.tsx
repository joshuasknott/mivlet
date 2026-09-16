import {
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { useShellRuntime } from "../hooks/useShellRuntime";
import { ExecutionApprovalRouter } from "../lib/execution-approvals";
import { enqueueWorkspaceDispose, WorkspaceExecution } from "../lib/workspace-execution";
import { hasNativeRuntimeAdapter } from "../runtime/adapters/select";
import { runtimeAccountTheme } from "../runtime/domains/account";
import { ActiveWorkspace } from "./ActiveWorkspace";
import "./teammate-workspace.css";
import { OnboardingPage } from "./workspace-lazy";
import {
  activeWorkspaceScope,
  teammateWorkspaceGate,
} from "./workspace-presentation";

/** A single account/settings owner, with one execution workspace per native scope. */
export function TeammateWorkspace() {
  const [approvals] = useState(() => new ExecutionApprovalRouter());
  const current = useRef<WorkspaceExecution | null>(null);
  const priorClose = useRef<Promise<void>>(Promise.resolve());
  const runtime = useShellRuntime({
    approvalGate: approvals,
    onScopeReset: () => {
      priorClose.current = enqueueWorkspaceDispose(
        priorClose.current,
        current.current,
      );
      current.current = null;
    },
  });
  const account = runtime.accountWorkspaceStatus;
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    if (!account.accountBound || !hasNativeRuntimeAdapter()) return;
    let currentTheme = true;
    void runtimeAccountTheme()
      .then((value) => {
        if (currentTheme) setTheme(value);
      })
      .catch(() => undefined);
    return () => {
      currentTheme = false;
    };
  }, [account.accountBound]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const changeTheme = (value: "light" | "dark") => {
    setTheme(value);
    if (account.accountBound && hasNativeRuntimeAdapter())
      void runtimeAccountTheme(value).catch(() => undefined);
  };
  const gate = teammateWorkspaceGate({
    accountWorkspacePending: runtime.accountWorkspacePending,
    runtimeSnapshotReady: runtime.runtimeSnapshotReady,
    runtimeSnapshotError: runtime.runtimeSnapshotError,
    account,
    onboardingRequired: runtime.onboardingRequired,
  });
  if (gate === "loading")
    return (
      <main className="team-loading" role="status">
        Opening your workspace…
      </main>
    );
  if (gate === "onboarding")
    return (
      <Suspense fallback={<main className="team-loading" aria-busy="true" />}>
        <OnboardingPage
          identityStatus={runtime.identityStatus}
          identityPending={runtime.identityPending}
          onSignIn={() => runtime.signInIdentity()}
          workspaceMessage={account.message}
          onOpenWorkspace={runtime.reconcileAccountWorkspace}
        />
      </Suspense>
    );
  const scope = activeWorkspaceScope(account);
  return (
    <ActiveWorkspace
      key={scope}
      runtime={runtime}
      approvals={approvals}
      theme={theme}
      onTheme={changeTheme}
      priorClose={priorClose}
      onService={(service) => {
        current.current = service;
      }}
    />
  );
}
