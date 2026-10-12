import { useMemo, useRef, useState } from "react";
import { Renderer } from "@openuidev/react-lang";
import type { InterfaceInteraction } from "./catalogue";
import { RichOwner, richInterfaceLibrary } from "./rich-catalogue";
import {
  decodeRichState,
  encodeRichState,
  validateRichInterface,
} from "./rich-interface-guard";
import "@openuidev/react-ui/styles/card.css";
import "@openuidev/react-ui/defaults.css";
import "@openuidev/react-ui/styles/tabs.css";
import "@openuidev/react-ui/styles/charts.css";
import "./rich-interface.css";

const components = new Set(Object.keys(richInterfaceLibrary.components));
export default function RichInterfaceRenderer({
  code,
  streaming,
  interaction,
  owner,
}: {
  code: string;
  streaming: boolean;
  interaction: InterfaceInteraction;
  owner: { workspaceId: string; agentId: string; generation?: number };
}) {
  const checked = useMemo(
    () => validateRichInterface(code, components, streaming),
    [code, streaming],
  );
  const [error, setError] = useState("");
  const latest = useRef(interaction);
  latest.current = interaction;
  const initial = useMemo(() => {
    try {
      return decodeRichState(
        typeof interaction.state.openuiState === "string"
          ? interaction.state.openuiState
          : undefined,
      );
    } catch {
      return {};
    }
  }, []);
  if (checked.error)
    return (
      <p role="alert">
        {checked.error} Ask the agent to correct the interface.
      </p>
    );
  if (!checked.code)
    return <p role="status">Preparing interactive response…</p>;
  return (
    <RichOwner.Provider value={owner}>
      <div className="rich-interface" inert={interaction.disabled || undefined}>
        <Renderer
          response={checked.code}
          library={richInterfaceLibrary}
          isStreaming={streaming}
          initialState={initial}
          publishObservability={false}
          toolProvider={null}
          onStateUpdate={(state) => {
            if (latest.current.disabled) return;
            try {
              const encoded = encodeRichState(state);
              if (encoded !== latest.current.state.openuiState)
                latest.current.change("openuiState", encoded);
            } catch (reason) {
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Unable to save interface state.",
              );
            }
          }}
          onAction={(event) => {
            if (
              !latest.current.disabled &&
              event.type === "continue_conversation"
            )
              latest.current.review(
                event.humanFriendlyMessage ||
                  "Continue from this interactive response",
              );
          }}
          onError={(errors) =>
            setError(
              errors.length
                ? "Some interface content could not render. Ask the agent to correct it."
                : "",
            )
          }
        />
        {error && <p role="alert">{error}</p>}
      </div>
    </RichOwner.Provider>
  );
}
