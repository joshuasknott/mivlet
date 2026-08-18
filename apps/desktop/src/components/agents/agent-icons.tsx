import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import type { FableAgentProfile } from "@fable/protocol";
import type { CSSProperties } from "react";

export const agentColorPalette = [
  { value: "#6D5DF7", label: "Violet" },
  { value: "#2672E8", label: "Blue" },
  { value: "#13966F", label: "Green" },
  { value: "#D07A19", label: "Amber" },
  { value: "#D6537D", label: "Rose" },
  { value: "#A14FD1", label: "Purple" },
  { value: "#0E8FA4", label: "Teal" },
  { value: "#D2543D", label: "Coral" },
  { value: "#626B78", label: "Slate" },
  { value: "#202124", label: "Black" }
] as const;

export const DEFAULT_AGENT_COLOR = agentColorPalette[0].value;

export function nextAgentColor(colors: Array<string | undefined>) {
  const used = new Set(colors.map((color) => color?.toUpperCase()));
  return agentColorPalette.find((option) => !used.has(option.value.toUpperCase()))?.value
    ?? agentColorPalette[colors.length % agentColorPalette.length].value;
}

function avatarStyle(color: string): CSSProperties {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_AGENT_COLOR;
  return { color: normalized };
}

export function AgentIcon({ size = 18 }: { size?: number }) {
  return <Robot size={size} weight="fill" aria-hidden="true" />;
}

export function AgentAvatar({
  color,
  imageDataUrl,
  iconSize = 18,
  className = ""
}: {
  color: string;
  imageDataUrl?: string;
  iconSize?: number;
  className?: string;
}) {
  return (
    <span
      className={`agent-avatar ${imageDataUrl ? "agent-avatar--image" : "agent-avatar--glyph"}${className ? ` ${className}` : ""}`}
      style={avatarStyle(color)}
    >
      {imageDataUrl
        ? <img src={imageDataUrl} alt="" aria-hidden="true" />
        : <AgentIcon size={iconSize} />}
    </span>
  );
}

export function ProfileAgentAvatar({ agent, iconSize = 18 }: { agent: FableAgentProfile; iconSize?: number }) {
  return <AgentAvatar color={agent.iconColor} imageDataUrl={agent.iconImageDataUrl} iconSize={iconSize} />;
}
