import { Component, type ReactNode } from "react";

/** Keep renderer failures visible without exposing account data from errors. */
export class WorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="team-loading" role="alert">
          <div>
            <h1>Your workspace could not be displayed</h1>
            <p>Reload Mivlet to try again. Unsaved text may be lost.</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload Mivlet
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
