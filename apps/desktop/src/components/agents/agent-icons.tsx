import type { FableAgentProfile } from "@fable/protocol";
import { useMemo, useId } from "react";
import { blobAvatarDataUrl } from "../../lib/blob-avatar";
import type { AgentPresence } from "../../lib/agent-presence";
import "./agent-presence.css";

// Saved profiles keep their colour across generated portraits.
export const DEFAULT_AGENT_COLOR = "#865DFA";

export function AgentAvatar({ seed, imageDataUrl, iconSize = 30, className = "", color = DEFAULT_AGENT_COLOR, thinking = false, presence }: {
  seed: string;
  color?: string;
  thinking?: boolean;
  presence?: AgentPresence;
  imageDataUrl?: string;
  iconSize?: number;
  className?: string;
}) {
  const colorId = useId().replaceAll(":", "");
  const source = useMemo(() => imageDataUrl ?? blobAvatarDataUrl(seed), [imageDataUrl, seed]);
  return <span data-presence={presence ?? (thinking ? "thinking" : "idle")} className={`agent-avatar ${imageDataUrl ? "agent-avatar--image" : "agent-avatar--generated"}${className ? ` ${className}` : ""}`}
    style={{ width: iconSize, height: iconSize, borderRadius: imageDataUrl ? "30%" : 0 }}>
    {color && !imageDataUrl ? <svg width="0" height="0" aria-hidden="true" focusable="false"><defs><filter id={colorId} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={colorMatrix(color)} /></filter></defs></svg> : null}
    <img src={source} alt="" aria-hidden="true" style={color && !imageDataUrl ? { filter: `url(#${colorId})` } : undefined} />
  </span>;
}

export function ProfileAgentAvatar({ agent, iconSize = 18, thinking = false, presence }: { agent: FableAgentProfile; iconSize?: number; thinking?: boolean; presence?: AgentPresence }) {
  return <AgentAvatar seed={agent.avatarSeed ?? `blob-v1:${agent.id}`} imageDataUrl={agent.iconImageDataUrl} color={agent.iconColor} thinking={thinking} presence={presence} iconSize={iconSize} />;
}

// Tint the light clay body while retaining the dark eyes and natural shading.
function colorMatrix(color: string) {
  const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_AGENT_COLOR;
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(safeColor.slice(offset, offset + 2), 16) / 255);
  return `${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0`;
}
