import type { FableAgentProfile } from "@fable/protocol";
import { useId, type CSSProperties } from "react";

export const agentColorPalette = [
  { value: "#865DFA", label: "Violet" },
  { value: "#3581FB", label: "Blue" },
  { value: "#2CC663", label: "Green" },
  { value: "#FCBD22", label: "Amber" },
  { value: "#FC6D69", label: "Coral" },
  { value: "#555B63", label: "Slate" }
] as const;

export const DEFAULT_AGENT_COLOR = agentColorPalette[0].value;

export function nextAgentColor(colors: Array<string | undefined>) {
  const used = new Set(colors.map((color) => color?.toUpperCase()));
  return agentColorPalette.find((option) => !used.has(option.value.toUpperCase()))?.value
    ?? agentColorPalette[colors.length % agentColorPalette.length].value;
}

type AgentAvatarStyle = CSSProperties & {
  "--agent-icon-base": string;
  "--agent-icon-light": string;
  "--agent-icon-fold": string;
  "--agent-icon-dark": string;
};

function mixHex(color: string, target: "#000000" | "#FFFFFF", amount: number) {
  const source = color.slice(1).match(/.{2}/g)?.map((part) => Number.parseInt(part, 16));
  const destination = target === "#FFFFFF" ? 255 : 0;
  if (!source || source.length !== 3) return color;
  return `#${source.map((channel) => Math.round(channel + ((destination - channel) * amount))
    .toString(16)
    .padStart(2, "0")).join("")}`.toUpperCase();
}

function avatarStyle(color: string): AgentAvatarStyle {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_AGENT_COLOR;
  return {
    color: normalized,
    "--agent-icon-base": normalized,
    "--agent-icon-light": mixHex(normalized, "#FFFFFF", 0.08),
    "--agent-icon-fold": mixHex(normalized, "#000000", 0.1),
    "--agent-icon-dark": mixHex(normalized, "#000000", 0.24)
  };
}

export function AgentIcon({ size = 30 }: { size?: number }) {
  const gradientId = `fold-agent-${useId().replaceAll(":", "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="6 5 36 38"
      fill="none"
      aria-hidden="true"
      data-agent-mark="fold"
    >
      <defs>
        <linearGradient id={`${gradientId}-body`} x1="10" y1="10" x2="38" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--agent-icon-light)" />
          <stop offset="1" stopColor="var(--agent-icon-base)" />
        </linearGradient>
        <linearGradient id={`${gradientId}-fold`} x1="25" y1="8" x2="35" y2="19" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--agent-icon-fold)" />
          <stop offset="1" stopColor="var(--agent-icon-dark)" />
        </linearGradient>
      </defs>
      <path
        d="M24 7.5C34 12.4 40 21.3 40 30.2C40 38 33.4 41.5 24 41.5C14.6 41.5 8 38 8 30.2C8 21.3 14 12.5 24 7.5Z"
        fill={`url(#${gradientId}-body)`}
      />
      <path
        d="M24.2 7.4C24.9 11.5 24.3 14.8 27.1 17.5C30.2 20.3 34.7 19.1 37 16.2C38.4 14.4 37.2 12.8 34.6 11.6C31.6 10.2 28.2 8.7 24.2 7.4Z"
        fill={`url(#${gradientId}-fold)`}
      />
      <ellipse cx="18.5" cy="29" rx="1.8" ry="3.1" fill="#303030" />
      <ellipse cx="29.5" cy="29" rx="1.8" ry="3.1" fill="#303030" />
    </svg>
  );
}

export function AgentAvatar({
  color,
  imageDataUrl,
  iconSize = 30,
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
