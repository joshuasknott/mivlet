import { useId } from "react";
import characters from "../../assets/agent-characters.webp";

/** Filter at the artwork's intrinsic resolution, then scale the isolated cell.
 * CSS background filters rasterize the tiny on-screen box before recolouring,
 * which loses edge detail at sidebar sizes and fractional display scaling. */
export function AgentCharacter({ variant, color }: { variant: number; color: string }) {
  const id = `agent-ink-${useId().replaceAll(":", "")}`;
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const row = (channel: number) => `${channel / 2} ${1 - channel} ${channel / 2} 0 0`;
  return <span className="ink-character__head">
    <svg className="ink-character__artwork" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs><filter id={id} colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
        <feColorMatrix type="matrix" values={`${row(red)} ${row(green)} ${row(blue)} 0 0 0 1 0`} />
      </filter></defs>
      <image href={characters} width="1536" height="1024" x={-(variant % 3) * 512} y={-Math.floor(variant / 3) * 512} filter={`url(#${id})`} />
    </svg>
  </span>;
}
