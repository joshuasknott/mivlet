import { useId } from "react";
import characters from "../../assets/agent-characters.webp";

/** Map the source's magenta body to the chosen colour, preserving black pupils,
 * white faces and the original alpha. The SVG is only a colour filter; artwork
 * comes from the original raster asset, with no background tile. */
export function AgentCharacter({ variant, color }: { variant: number; color: string }) {
  const id = `agent-ink-${useId().replaceAll(":", "")}`;
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const row = (channel: number) => `${channel / 2} ${1 - channel} ${channel / 2} 0 0`;
  return <>
    <svg width="0" height="0" aria-hidden="true" className="ink-character__filter">
      <defs><filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values={`${row(red)} ${row(green)} ${row(blue)} 0 0 0 1 0`} />
      </filter></defs>
    </svg>
    <span className="ink-character__head">
      <span className="ink-character__artwork" style={{
        backgroundImage: `url(${characters})`,
        backgroundPosition: `${(variant % 3) * 50}% ${Math.floor(variant / 3) * 100}%`,
        filter: `url(#${id})`,
      }} />
    </span>
  </>;
}
