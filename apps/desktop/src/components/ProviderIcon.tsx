import { Cube } from "@phosphor-icons/react/dist/csr/Cube";

interface ProviderIconProps {
  provider: string;
  size?: number;
}

// OpenAI's current official symbol (2025 refresh), used verbatim; see
// public/brand/README.md for source and terms.
const openAiViewBox = "1.68 1.75 16.65 16.5";
const additionalProviderMarks = new Set([
  "deepseek", "alibaba", "moonshot", "zai", "groq", "together",
  "fireworks", "cerebras", "mistral", "openrouter", "nvidia", "siliconflow", "cohere",
]);

export function ProviderIcon({ provider, size = 20 }: ProviderIconProps) {
  const providerId = provider.toLowerCase();
  if (providerId === "antigravity" || providerId === "cursor" || providerId === "opencode") {
    const src = providerId === "antigravity" ? "/brand/google-antigravity.png" : `/brand/${providerId}.svg`;
    return <img src={src} width={size} height={size} alt="" data-provider-brand={providerId} aria-hidden="true" />;
  }

  let brand = providerId;
  let symbol = providerId;
  let viewBox = "0 0 24 24";
  let colour: string | undefined;
  const additional = additionalProviderMarks.has(providerId);
  if (additional) {
    colour = providerId === "groq" ? "#F55036" : "var(--provider-monochrome)";
  } else if (providerId === "codex" || providerId === "openai") {
    symbol = "openai";
    viewBox = openAiViewBox;
    colour = providerId === "codex" ? "#3941FF" : "var(--provider-monochrome)";
  } else if (providerId === "anthropic" || providerId === "claude") {
    symbol = brand = "anthropic";
    viewBox = "0 0 125 125";
    colour = "#D97757";
  } else if (providerId === "gemini" || providerId === "google") {
    symbol = brand = "gemini";
  } else if (providerId === "xai") {
    brand = "grok";
    viewBox = "0 0 512 512";
  } else {
    return <Cube size={size} data-provider-brand={providerId === "custom" ? "custom" : undefined} aria-hidden="true" />;
  }
  const artwork = additional ? "additional-provider-artwork" : "provider-artwork";
  return <svg viewBox={viewBox} width={size} height={size} fill={colour ? "currentColor" : undefined} style={colour ? { color: colour } : undefined} data-provider-brand={brand} aria-hidden="true"><use href={`/brand/${artwork}.svg#${symbol}`} /></svg>;
}
