import type { FableAgentProfile } from "@fable/protocol";
import { useMemo, useId } from "react";
import { blobAvatarDataUrl } from "../../lib/blob-avatar";

// Saved profiles keep their colour across generated portraits.
export const DEFAULT_AGENT_COLOR = "#865DFA";

export function AgentAvatar({ seed, imageDataUrl, iconSize = 30, className = "", color = DEFAULT_AGENT_COLOR, thinking = false }: {
  seed: string;
  color?: string;
  thinking?: boolean;
  imageDataUrl?: string;
  iconSize?: number;
  className?: string;
}) {
  const colorId = useId().replaceAll(":", "");
  const source = useMemo(() => imageDataUrl ?? blobAvatarDataUrl(seed), [imageDataUrl, seed]);
  return <span className={`agent-avatar ${thinking ? "agent-avatar--thinking " : ""}${imageDataUrl ? "agent-avatar--image" : "agent-avatar--generated"}${className ? ` ${className}` : ""}`}
    style={{ width: iconSize, height: iconSize, borderRadius: imageDataUrl ? "30%" : 0 }}>
    {color && !imageDataUrl ? <svg width="0" height="0" aria-hidden="true" focusable="false"><defs><filter id={colorId} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={colorMatrix(color)} /></filter></defs></svg> : null}
    <img src={source} alt="" aria-hidden="true" style={color && !imageDataUrl ? { filter: `url(#${colorId})` } : undefined} />
  </span>;
}

export function ProfileAgentAvatar({ agent, iconSize = 18, thinking = false }: { agent: FableAgentProfile; iconSize?: number; thinking?: boolean }) {
  return <AgentAvatar seed={agent.avatarSeed ?? `blob-v1:${agent.id}`} imageDataUrl={agent.iconImageDataUrl} color={agent.iconColor} thinking={thinking} iconSize={iconSize} />;
}

// Map the portrait's dark body to the chosen colour while keeping its light eyes.
function colorMatrix(color: string) {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  return channels.map((channel) => {
    const scale = (1 - channel) / 0.8;
    return [0.2126 * scale, 0.7152 * scale, 0.0722 * scale, 0, channel - 0.08 * scale].join(" ");
  }).join(" ") + " 0 0 0 1 0";
}
