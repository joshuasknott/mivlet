import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Renderer } from "@openuidev/react-lang";
import {
  InterfaceContext,
  mivletInterfaceLibrary,
  type InterfaceInteraction,
} from "./catalogue";
const RichInterfaceRenderer = lazy(() => import("./RichInterfaceRenderer"));

class InterfaceBoundary extends Component<
  { children: ReactNode; source: string; onError?: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError?.("This interface could not render.");
  }
  componentDidUpdate(previous: { source: string }) {
    if (this.state.failed && previous.source !== this.props.source)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        This interface could not render. Its source remains inspectable.
      </p>
    ) : (
      this.props.children
    );
  }
}
export default function InterfaceRenderer({
  code,
  streaming,
  interaction,
  profile,
  owner,
  onError,
}: {
  code: string;
  streaming: boolean;
  interaction: InterfaceInteraction;
  profile?: "mivlet-v2";
  owner: { workspaceId: string; agentId: string; generation?: number };
  onError?: (message: string) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (profile !== "mivlet-v2") onError?.(invalid ? "Some interface content is invalid." : "");
  }, [invalid, onError, profile]);
  return (
    <InterfaceBoundary source={code} onError={onError}>
      <InterfaceContext.Provider value={interaction}>
        {profile === "mivlet-v2" ? (
          <Suspense fallback={<p role="status">Loading interactive layout…</p>}>
            <RichInterfaceRenderer
              code={code}
              streaming={streaming}
              interaction={interaction}
              owner={owner}
              onError={onError}
            />
          </Suspense>
        ) : (
          <>
            <Renderer
              response={code}
              library={mivletInterfaceLibrary}
              isStreaming={streaming}
              publishObservability={false}
              toolProvider={null}
              onError={(errors) => setInvalid(errors.length > 0)}
            />
            {invalid && !streaming ? (
              <p role="alert">
                Some interface content is invalid. Inspect the source or ask the
                agent to correct it.
              </p>
            ) : null}
          </>
        )}
      </InterfaceContext.Provider>
    </InterfaceBoundary>
  );
}
