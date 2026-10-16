/** Body colours for the ink character family. */
export const AGENT_COLOURS = [
  ["Blue", "#3659E3"], ["Jade", "#008577"], ["Violet", "#7761C5"],
  ["Amber", "#D69A32"], ["Coral", "#E4684B"], ["Slate", "#63758C"],
  ["Rose", "#C25A88"], ["Ink", "#18191C"],
] as const;

/** Choose a legible checkmark for each colour swatch. */
export function usesLightInk(colour: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(colour.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 < .18;
}
