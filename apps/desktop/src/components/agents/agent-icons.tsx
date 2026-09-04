import type { FableAgentProfile } from "@fable/protocol";
import { useMemo } from "react";
import { blobAvatarDataUrl } from "../../lib/blob-avatar";

// Retained for compatibility with saved profiles. Portrait geometry uses the seed.
export const DEFAULT_AGENT_COLOR = "#865DFA";

export function AgentAvatar({ seed, imageDataUrl, iconSize = 30, className = "" }: {
  seed: string;
  imageDataUrl?: string;
  iconSize?: number;
  className?: string;
}) {
  const source = useMemo(() => imageDataUrl ?? blobAvatarDataUrl(seed), [imageDataUrl, seed]);
  return <span className={`agent-avatar ${imageDataUrl ? "agent-avatar--image" : "agent-avatar--generated"}${className ? ` ${className}` : ""}`}
    style={{ width: iconSize, height: iconSize, borderRadius: "30%" }}>
    <img src={source} alt="" aria-hidden="true" />
  </span>;
}

export function ProfileAgentAvatar({ agent, iconSize = 18 }: { agent: FableAgentProfile; iconSize?: number }) {
  return <AgentAvatar seed={agent.avatarSeed ?? `blob-v1:${agent.id}`} imageDataUrl={agent.iconImageDataUrl} iconSize={iconSize} />;
}
