import { memo, useId } from "react";
import { agentCast } from "./agent-cast.js";

// The desktop app's original character sheet and recolouring matrix.
export const AgentAvatar = memo(function AgentAvatar({
  name = "Nova",
  size = 48,
  className = "",
}) {
  const agent = agentCast.find((item) => item.name === name) ?? agentCast[0];
  const id = `marketing-agent-${useId().replaceAll(":", "")}`;
  const channels = [1, 3, 5].map(
    (offset) => parseInt(agent.color.slice(offset, offset + 2), 16) / 255,
  );
  const row = (channel) => `${channel / 2} ${1 - channel} ${channel / 2} 0 0`;
  return (
    <svg
      className={`agent-avatar ${className}`}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, overflow: "visible" }}
    >
      <defs>
        <filter
          id={id}
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="512"
          height="512"
        >
          <feColorMatrix
            type="matrix"
            values={`${channels.map(row).join(" ")} 0 0 0 1 0`}
          />
        </filter>
      </defs>
      <svg viewBox="0 0 512 512" overflow="hidden">
        <image
          href="/avatars/agent-characters.webp"
          width="1536"
          height="1024"
          x={-(agent.variant % 3) * 512}
          y={-Math.floor(agent.variant / 3) * 512}
          filter={`url(#${id})`}
        />
      </svg>
    </svg>
  );
});
