import { useId } from "react";
import type { AgentPresence } from "../../lib/agent-presence";

const EYE_COLOURS = ["#FFF5DE", "#91F1FF", "#F0DBFF", "#B9FFEA", "#BAF4FF", "#FFF0B0", "#A5F0FF", "#FFF2E8"];
const EYES = [[36, 62, 64, 62], [21, 54, 64, 57], [36, 60, 63, 62], [36, 61, 64, 61], [35, 57, 65, 57], [35, 58, 65, 58], [34, 61, 62, 66], [35, 57, 65, 57]];
const MOUTH_Y = [73, 70, 70, 73, 67, 70, 75, 69];

function mix(colour: string, target: string, amount: number) {
  return `#${[1, 3, 5].map((offset) => {
    const source = parseInt(colour.slice(offset, offset + 2), 16);
    const end = parseInt(target.slice(offset, offset + 2), 16);
    return Math.round(source + (end - source) * amount).toString(16).padStart(2, "0");
  }).join("")}`;
}

/** Hand-drawn from the eight original robot portraits in their saved variant order.
 * The cap/crest, panels, lens and eyes remain separate geometry, never image masks. */
function Artwork({ variant, id, edge }: { variant: number; id: string; edge: string }) {
  const shell = `url(#${id}-shell)`;
  const detail = `url(#${id}-detail)`;
  const screen = `url(#${id}-screen)`;
  const shellProps = { fill: shell, stroke: edge, strokeWidth: .45 };
  const detailProps = { fill: detail, stroke: edge, strokeWidth: .4 };
  const screenProps = { className: "agent-avatar__screen", fill: screen, stroke: "#111827", strokeWidth: .7 };
  switch (variant) {
    case 0: return <>
      <path className="agent-avatar__shell" d="M11 60C14 37 29 22 50 19 73 17 88 36 89 59 91 80 77 90 50 90 23 90 7 81 11 60Z" {...shellProps} />
      <path d="M20 48C24 38 43 37 57 39 74 40 80 45 80 57 80 73 73 79 51 80 29 81 22 76 20 65 18 59 18 53 20 48Z" {...screenProps} />
      <g className="agent-avatar__accessory" data-part="crest"><path d="M41 22C44 12 60 6 72 9 83 11 84 19 77 25 69 32 53 33 44 29 41 28 40 25 41 22Z" {...detailProps} /></g>
    </>;
    case 1: return <>
      <g data-part="ears" fill={shell} stroke={edge} strokeWidth=".45"><ellipse cx="11" cy="54" rx="6" ry="12" /><ellipse cx="88" cy="54" rx="6" ry="12" /></g>
      <path className="agent-avatar__shell" d="M10 48C12 25 30 10 50 10 72 10 89 28 89 53 89 77 77 88 50 88 25 88 9 74 10 48Z" {...shellProps} />
      <path d="M18 47C21 37 40 34 54 35 73 36 83 42 83 56 83 72 70 76 50 77 29 77 18 71 17 59 16 54 16 51 18 47Z" {...screenProps} />
      <g className="agent-avatar__accessory" data-part="lens"><ellipse cx="21" cy="54" rx="14" ry="15" {...detailProps} /><ellipse cx="21" cy="54" rx="9.6" ry="10.4" fill={screen} stroke={edge} strokeWidth="1" /><path d="M14 48Q17 43 22 44" fill="none" stroke="#FFFFFF" strokeOpacity=".15" strokeWidth="1" strokeLinecap="round" /></g>
    </>;
    case 2: return <>
      <path className="agent-avatar__shell" d="M10 55C14 27 28 10 50 10 72 10 86 27 90 55L89 66C85 82 70 86 50 86 30 86 15 82 11 66Z" {...shellProps} />
      <path d="M26 38 75 44C79 48 79 61 75 67 71 73 60 76 49 75 35 75 26 71 23 64 21 55 22 45 26 38Z" {...screenProps} />
      <g className="agent-avatar__accessory" data-part="bob">
        <path data-part="left-panel" d="M31 20C20 28 14 43 8 57L4 64C3 69 8 73 15 74 19 76 20 68 21 60 22 49 25 39 29 31Z" {...detailProps} />
        <path data-part="right-panel" d="M69 20C80 28 86 44 92 58L96 64C97 69 91 73 84 74 80 76 79 68 78 60 77 49 75 38 72 31Z" {...detailProps} />
        <path data-part="fringe" d="M30 25C36 15 65 14 72 28L78 45Q79 47 75 46L27 40Q25 40 26 37Z" {...detailProps} />
      </g>
    </>;
    case 3: return <>
      <g data-part="ears" fill={detail} stroke={edge} strokeWidth=".4"><ellipse cx="11" cy="56" rx="7" ry="14" /><ellipse cx="89" cy="56" rx="7" ry="14" /></g>
      <path className="agent-avatar__shell" d="M11 49C15 28 31 16 50 16 69 16 85 28 89 49L88 68C87 77 72 86 60 91Q50 97 40 91C28 86 13 77 12 68Z" {...shellProps} />
      <path d="M18 46C20 37 36 37 50 37 66 37 79 38 81 48 85 65 75 77 55 80 41 83 22 73 19 63 17 58 16 51 18 46Z" {...screenProps} />
      <g className="agent-avatar__accessory" data-part="fin"><path d="M30 20Q50 13 70 20C75 27 64 29 50 29S26 27 30 20Z" {...detailProps} /><path d="M42 17 45 7C46 2 50 3 54 7 58 10 59 15 60 18Q60 21 50 21T42 17Z" {...detailProps} /></g>
    </>;
    case 4: return <>
      <g className="agent-avatar__accessory" data-part="pods" fill={detail} stroke={edge} strokeWidth=".45"><path d="M16 35C5 35 1 44 1 54 1 63 6 69 15 69L20 60V43Z" /><path d="M84 35C95 35 99 44 99 54 99 63 94 69 85 69L80 60V43Z" /><ellipse cx="5" cy="53" rx="3" ry="10" /><ellipse cx="95" cy="53" rx="3" ry="10" /></g>
      <path className="agent-avatar__shell" d="M13 45C15 22 31 12 50 12 70 12 85 22 87 45L87 66C85 80 69 86 50 86 30 86 15 80 13 66Z" {...shellProps} />
      <path d="M20 43C23 34 37 32 50 32 66 32 78 35 80 46 83 61 75 71 63 73H38C25 71 18 64 18 52Q18 46 20 43Z" {...screenProps} />
    </>;
    case 5: return <>
      <path className="agent-avatar__shell" d="M3 55C6 29 23 6 49 6 75 6 93 28 97 55 99 67 94 75 85 76L78 61 22 61 15 76C6 75 1 67 3 55Z" {...shellProps} />
      <path d="M15 44C19 32 34 29 49 29 67 29 79 33 84 45 89 61 82 72 68 76 56 80 37 81 25 75 16 71 11 59 15 44Z" {...screenProps} />
      <g className="agent-avatar__accessory" data-part="hood-ends"><path d="M15 45C11 60 15 71 28 75 37 78 43 77 45 83 48 91 42 93 36 92 22 91 12 84 9 73 7 63 10 52 15 45Z" {...detailProps} /><path d="M84 45C89 60 85 71 72 75 63 78 57 77 55 83 52 91 58 93 64 92 78 91 88 84 91 73 93 63 90 52 84 45Z" {...detailProps} /></g>
    </>;
    case 6: return <>
      <path className="agent-avatar__shell" d="M7 50C11 34 25 21 42 16 61 12 78 29 88 47 98 65 90 85 70 90 52 95 24 92 12 81 4 75 3 61 7 50Z" {...shellProps} />
      <path d="M18 49C22 38 40 38 55 39 66 39 77 47 80 60 84 74 72 82 55 83H35C21 83 16 74 16 64Q16 55 18 49Z" {...screenProps} />
      <g className="agent-avatar__accessory" data-part="fold"><path d="M26 22Q22 13 31 10L40 13 49 28 30 35Z" fill={edge} /><path d="M28 12C47 1 68 8 80 25 91 41 98 64 94 76 93 70 88 68 81 63 63 51 50 35 39 23 34 17 30 14 28 15Q24 17 26 22C23 18 24 15 28 12Z" {...detailProps} /></g>
    </>;
    default: return <>
      <g data-part="ears" fill={detail} stroke={edge} strokeWidth=".4"><ellipse cx="10" cy="56" rx="8" ry="15" /><ellipse cx="89" cy="56" rx="8" ry="15" /></g>
      <path className="agent-avatar__shell" d="M9 49C10 28 26 19 50 19 74 19 90 28 91 49V64C90 80 73 88 50 88 27 88 10 80 9 64Z" {...shellProps} />
      <path d="M17 44C19 36 31 34 50 34 71 34 80 37 82 47V58C81 73 71 77 50 77 28 77 17 73 16 60Q15 50 17 44Z" {...screenProps} />
      <g className="agent-avatar__accessory" data-part="cap"><path d="M16 27C17 15 27 9 48 9 68 9 81 14 83 27Q85 38 75 36C59 33 38 33 24 36Q15 38 16 27Z" {...detailProps} /></g>
    </>;
  }
}

function Eye({ presence, right = false, lens = false }: { presence: AgentPresence; right?: boolean; lens?: boolean }) {
  if (lens && !["paused", "unavailable", "service", "blocked", "done"].includes(presence)) return <circle className="agent-avatar__pupil" r={presence === "working" ? 3.3 : 4} />;
  if (["received", "waiting", "input", "listening", "human", "speaking"].includes(presence)) return <ellipse rx="2.8" ry="4.3" />;
  const d = presence === "done" ? "M-5 1Q0 -6 5 1"
    : presence === "paused" || presence === "unavailable" ? "M-5 1h10"
    : presence === "blocked" ? right ? "M-5 -2L5 1" : "M-5 1L5 -2"
    : presence === "thinking" ? right ? "M-5 0h10" : "M-5 -1Q0 -3 5 -1"
    : presence === "working" ? "M-5 0h10"
    : presence === "service" ? "M-4 1Q0 2 4 1"
    : "M-5 0Q0 3 5 0";
  return <path d={d} />;
}

export function AgentCharacter({ variant, color, expression }: { variant: number; color: string; expression: AgentPresence }) {
  const id = `character-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [lx, ly, rx, ry] = EYES[variant];
  const edge = mix(color, "#24243A", .23);
  return <svg className="agent-avatar__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-shell`} x1="16" y1="12" x2="75" y2="96" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor={mix(color, "#FFFFFF", .66)} /><stop offset=".4" stopColor={mix(color, "#FFFFFF", .2)} /><stop offset=".7" stopColor={color} /><stop offset="1" stopColor={edge} />
      </linearGradient>
      <linearGradient id={`${id}-detail`} x1="26" y1="10" x2="75" y2="88" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor={mix(color, "#FFFFFF", .68)} /><stop offset=".55" stopColor={mix(color, "#FFFFFF", .13)} /><stop offset="1" stopColor={edge} />
      </linearGradient>
      <radialGradient id={`${id}-screen`} cx=".3" cy="0" r="1">
        <stop offset="0" stopColor="#30394A" /><stop offset=".5" stopColor="#101623" /><stop offset="1" stopColor="#080C15" />
      </radialGradient>
    </defs>
    <g className="agent-avatar__head">
      <Artwork variant={variant} id={id} edge={edge} />
      <g className="agent-avatar__gaze" style={{ color: EYE_COLOURS[variant] }}>
        <g className="agent-avatar__eyes"><g className="agent-avatar__eye" transform={`translate(${lx} ${ly})`}><Eye presence={expression} lens={variant === 1} /></g><g className="agent-avatar__eye" transform={`translate(${rx} ${ry})`}><Eye presence={expression} right /></g></g>
        {expression === "speaking" ? <g transform={`translate(50 ${MOUTH_Y[variant]})`}><path className="agent-avatar__mouth" d="M-4 0v1m4-3v5m4-3v1" /></g> : null}
      </g>
    </g>
  </svg>;
}
