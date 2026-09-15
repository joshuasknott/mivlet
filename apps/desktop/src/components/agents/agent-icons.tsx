import type { MivletAgentProfile } from "@mivlet/protocol";
import { useEffect, useRef, useState, type RefObject } from "react";
import { AVATAR_COLOURS, avatarVariant } from "../../lib/blob-avatar";
import type { AgentPresence } from "../../lib/agent-presence";
import { AgentCharacter } from "./agent-character";
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
  /** Workspace / agent / conversation / execution identity, never a status label. */
  activityKey?: string;
};

export function AgentAvatar(props: AvatarProps) {
  // A different identity cannot inherit a previous character's transition history.
  return <AvatarInstance key={JSON.stringify([props.seed, props.imageDataUrl, props.activityKey])} {...props} />;
}

function AvatarInstance({ seed, imageDataUrl, iconSize = 30, className = "", color, thinking = false, presence, motion = "quiet" }: AvatarProps) {
  const variant = avatarVariant(seed);
  const current = presence ?? (thinking ? "thinking" : "idle");
  const root = useRef<HTMLSpanElement>(null);
  const visible = useAvatarVisibility(root, !imageDataUrl);
  const previous = useRef(current);
  const [entrance, setEntrance] = useState<AgentPresence | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);

  useEffect(() => {
    const changed = previous.current !== current;
    const completedNow = changed && current === "done" && visible
      && ["received", "thinking", "working", "service", "waiting", "input"].includes(previous.current);
    previous.current = current;
    setAcknowledging(completedNow);
    setEntrance(changed && visible ? current : null);
    if (completedNow) {
      const timer = window.setTimeout(() => { setAcknowledging(false); setEntrance(null); }, 900);
      return () => window.clearTimeout(timer);
    }
  }, [current, visible]);

  const expression = current === "done" && !acknowledging ? "idle" : current;
  const shellColor = color && /^#[0-9a-f]{6}$/i.test(color) ? color : AVATAR_COLOURS[variant];
  return <span ref={root} aria-hidden="true" data-presence={current} data-expression={expression}
    data-character={variant} data-motion={motion} data-animate={visible && motion === "expressive" && !imageDataUrl}
    data-entrance={entrance === current ? entrance : undefined}
    className={`agent-avatar ${imageDataUrl ? "agent-avatar--image" : "agent-avatar--generated"}${className ? ` ${className}` : ""}`}
    style={{ width: iconSize, height: iconSize, borderRadius: imageDataUrl ? "30%" : 0 }}>
    {imageDataUrl ? <img src={imageDataUrl} alt="" draggable={false} />
      : <AgentCharacter variant={variant} color={shellColor} expression={expression} />}
  </span>;
}

/** Offscreen and background avatars have no running CSS timeline. No polling. */
function useAvatarVisibility(root: RefObject<HTMLSpanElement | null>, enabled: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let intersecting = typeof IntersectionObserver === "undefined";
    const update = () => setVisible(intersecting && document.visibilityState !== "hidden");
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    });
    if (root.current) observer?.observe(root.current);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, [enabled, root]);
  return visible;
}

export function ProfileAgentAvatar({ agent, ...props }: { agent: MivletAgentProfile } & Omit<AvatarProps, "seed" | "color" | "imageDataUrl">) {
  return <AgentAvatar key={agent.id} seed={agent.avatarSeed ?? `blob-v1:${agent.id}`} imageDataUrl={agent.iconImageDataUrl} color={agent.iconColor} {...props} />;
}
