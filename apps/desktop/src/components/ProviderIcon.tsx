import { Cube } from "@phosphor-icons/react/dist/csr/Cube";

interface ProviderIconProps {
  provider: string;
  size?: number;
}

// OpenAI's current official symbol (2025 refresh), used verbatim; see
// public/brand/README.md for source and terms.
const openAiViewBox = "1.68 1.75 16.65 16.5";

export function ProviderIcon({ provider, size = 20 }: ProviderIconProps) {
  const providerId = provider.toLowerCase();

  if (providerId === "codex" || providerId === "openai") {
    const color = providerId === "codex" ? "#3941FF" : "var(--provider-monochrome)";
    return (
      <svg viewBox={openAiViewBox} width={size} height={size} fill="currentColor" style={{ color }} data-provider-brand={providerId} aria-hidden="true"><use href="/brand/provider-artwork.svg#openai" /></svg>
    );
  }

  if (providerId === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ color: "#D97757" }} data-provider-brand="anthropic" aria-hidden="true"><use href="/brand/provider-artwork.svg#anthropic" /></svg>
    );
  }

  if (providerId === "antigravity") {
    return (
      <img
        src="/brand/google-antigravity.png"
        width={size}
        height={size}
        alt=""
        data-provider-brand="antigravity"
        aria-hidden="true"
      />
    );
  }

  if (providerId === "gemini" || providerId === "google") {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} data-provider-brand="gemini" aria-hidden="true"><use href="/brand/provider-artwork.svg#gemini" /></svg>
    );
  }

  if (providerId === "xai") {
    return (
      <svg viewBox="0 0 512 512" width={size} height={size} data-provider-brand="grok" aria-hidden="true"><use href="/brand/provider-artwork.svg#xai" /></svg>
    );
  }

  if (providerId === "cursor") {
    return (
      <img
        src="/brand/cursor.svg"
        width={size}
        height={size}
        alt=""
        data-provider-brand="cursor"
        aria-hidden="true"
      />
    );
  }

  if (providerId === "opencode") {
    return (
      <img
        src="/brand/opencode.svg"
        width={size}
        height={size}
        alt=""
        data-provider-brand="opencode"
        aria-hidden="true"
      />
    );
  }

  return <Cube size={size} data-provider-brand={providerId === "custom" ? "custom" : undefined} aria-hidden="true" />;
}
