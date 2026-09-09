import type { FableAgentProfile } from "@fable/protocol";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { AVATAR_COLOURS, avatarVariant, blobAvatarDataUrl } from "../../lib/blob-avatar";
import type { AgentPresence } from "../../lib/agent-presence";
import "./agent-presence.css";

export const DEFAULT_AGENT_COLOR = "#865DFA";
type AvatarProps = {
  seed: string;
  color?: string;
  thinking?: boolean;
  presence?: AgentPresence;
  imageDataUrl?: string;
  iconSize?: number;
  className?: string;
  motion?: "quiet" | "expressive";
};

// Coordinates registered to the generated artwork, including the lens pupil.
const eyePositions = [[36, 62, 64, 62], [21, 54, 64, 57], [36, 60, 63, 62], [36, 61, 64, 61], [35, 57, 65, 57], [35, 58, 65, 58], [34, 61, 62, 66], [35, 57, 65, 57]];
const eyeColours = ["#FFF5DE", "#91F1FF", "#F0DBFF", "#B9FFEA", "#BAF4FF", "#FFF0B0", "#A5F0FF", "#FFF2E8"];

export function AgentAvatar({ seed, imageDataUrl, iconSize = 30, className = "", color, thinking = false, presence, motion = "quiet" }: AvatarProps) {
  const colorId = useId().replaceAll(":", "");
  const variant = avatarVariant(seed);
  const current = presence ?? (thinking ? "thinking" : "idle");
  const previous = useRef(current);
  const [celebrating, setCelebrating] = useState(false);
  useEffect(() => {
    // Restored completed history must not replay a success animation.
    const completedNow = current === "done" && ["received", "thinking", "working", "service", "waiting"].includes(previous.current);
    previous.current = current;
    setCelebrating(completedNow);
    if (completedNow) {
      const timer = window.setTimeout(() => setCelebrating(false), 1100);
      return () => window.clearTimeout(timer);
    }
  }, [current]);
  const expression = current === "done" && !celebrating ? "idle" : current;
  const tint = color && color.toUpperCase() !== AVATAR_COLOURS[variant] && !imageDataUrl;
  const colourTables = tint ? colourTransfer(color, AVATAR_COLOURS[variant]) : undefined;
  const [lx, ly, rx, ry] = eyePositions[variant];
  return <span aria-hidden="true" data-presence={current} data-expression={expression} data-character={variant} data-motion={motion}
    className={`agent-avatar ${imageDataUrl ? "agent-avatar--image" : "agent-avatar--generated"}${className ? ` ${className}` : ""}`}
    style={{ width: iconSize, height: iconSize, borderRadius: imageDataUrl ? "30%" : 0, "--eye-colour": eyeColours[variant] } as CSSProperties}>
    {colourTables ? <svg className="agent-avatar__filter" width="0" height="0" focusable="false"><defs><filter id={colorId} colorInterpolationFilters="sRGB">
      <feColorMatrix type="saturate" values="0" />
      <feComponentTransfer><feFuncR type="table" tableValues={colourTables[0]} /><feFuncG type="table" tableValues={colourTables[1]} /><feFuncB type="table" tableValues={colourTables[2]} /></feComponentTransfer>
    </filter></defs></svg> : null}
    <span className="agent-avatar__character">
      <img src={imageDataUrl ?? blobAvatarDataUrl(seed)} alt="" draggable={false} style={tint ? { filter: `url(#${colorId})` } : undefined} />
      {!imageDataUrl ? <svg className="agent-avatar__face" viewBox="0 0 100 100" focusable="false">
        <g className="agent-avatar__eyes">
          <g transform={`translate(${lx} ${ly})`}><Eye presence={expression} lens={variant === 1} /></g>
          <g transform={`translate(${rx} ${ry})`}><Eye presence={expression} right /></g>
        </g>
        {expression === "speaking" ? <path className="agent-avatar__voice" d="M46 76v2m4-4v6m4-4v2" /> : null}
      </svg> : null}
    </span>
  </span>;
}

function Eye({ presence, right = false, lens = false }: { presence: AgentPresence; right?: boolean; lens?: boolean }) {
  if (lens) return <circle className="agent-avatar__pupil" r={presence === "paused" || presence === "unavailable" ? 2.5 : 4} fill="currentColor" stroke="none" />;
  if (["received", "waiting", "input", "listening", "human"].includes(presence)) return <path d="M0 -2v4" strokeWidth={presence === "listening" ? 6 : 5} />;
  const path = presence === "done" ? "M-5 1Q0 -6 5 1"
    : presence === "paused" || presence === "unavailable" ? "M-5 2h10"
    : presence === "blocked" ? right ? "M-5 -2L5 1" : "M-5 1L5 -2"
    : presence === "thinking" ? right ? "M-5 0h10" : "M-5 -1Q0 -4 5 -1"
    : presence === "working" || presence === "service" ? "M-5 0h10"
    : "M-5 0Q0 3 5 0";
  return <path d={path} />;
}

export function ProfileAgentAvatar({ agent, ...props }: { agent: FableAgentProfile } & Omit<AvatarProps, "seed" | "color" | "imageDataUrl">) {
  return <AgentAvatar seed={agent.avatarSeed ?? `blob-v1:${agent.id}`} imageDataUrl={agent.iconImageDataUrl} color={agent.iconColor} {...props} />;
}

// Recolour only the shell artwork, retaining dark screens and independent eyes.
function colourTransfer(color: string, original: string) {
  const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_AGENT_COLOR;
  const channels = [1, 3, 5].map((offset) => parseInt(safeColor.slice(offset, offset + 2), 16) / 255);
  const source = [1, 3, 5].map((offset) => parseInt(original.slice(offset, offset + 2), 16) / 255);
  const luminance = source[0] * .2126 + source[1] * .7152 + source[2] * .0722;
  // Keep the dark display neutral, map the shell midtone to the chosen colour,
  // then approach a neutral white highlight. No negative-channel hue fringes.
  return channels.map((target) => Array.from({ length: 21 }, (_, index) => {
    const light = index / 20;
    if (light <= .15) return light;
    return light < luminance
      ? .15 + (target - .15) * (light - .15) / (luminance - .15)
      : target + (1 - target) * (light - luminance) / (1 - luminance);
  }).join(" "));
}
