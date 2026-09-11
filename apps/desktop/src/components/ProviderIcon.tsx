import { Cube } from "@phosphor-icons/react/dist/csr/Cube";
import { useId } from "react";

interface ProviderIconProps {
  provider: string;
  size?: number;
}

// OpenAI's current official symbol (2025 refresh), used verbatim; see
// public/brand/README.md for source and terms.
const openAiPath =
  "M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z";
const openAiViewBox = "1.68 1.75 16.65 16.5";

export function ProviderIcon({ provider, size = 20 }: ProviderIconProps) {
  const providerId = provider.toLowerCase();
  const gradientId = useId().replaceAll(":", "");

  if (providerId === "codex" || providerId === "openai") {
    const color = providerId === "codex" ? "#3941FF" : "var(--provider-monochrome)";
    return (
      <svg viewBox={openAiViewBox} width={size} height={size} fill="currentColor" style={{ color }} data-provider-brand={providerId} aria-hidden="true">
        <path d={openAiPath} />
      </svg>
    );
  }

  if (providerId === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ color: "#D97757" }} data-provider-brand="anthropic" aria-hidden="true">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
      </svg>
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
      <svg viewBox="0 0 24 24" width={size} height={size} data-provider-brand="gemini" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="3" y1="19" x2="20" y2="4" gradientUnits="userSpaceOnUse">
            <stop stopColor="#08B962" />
            <stop offset=".36" stopColor="#3186FF" />
            <stop offset=".7" stopColor="#F94543" />
            <stop offset="1" stopColor="#FABC12" />
          </linearGradient>
        </defs>
        <path d="M20.616 10.835a14.147 14.147 0 0 1-4.45-3.001 14.111 14.111 0 0 1-3.678-6.452.503.503 0 0 0-.975 0 14.134 14.134 0 0 1-3.679 6.452 14.155 14.155 0 0 1-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 0 0 0 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 0 1 4.45 3.001 14.112 14.112 0 0 1 3.679 6.453.502.502 0 0 0 .975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 0 1 3.001-4.45 14.113 14.113 0 0 1 6.453-3.678.503.503 0 0 0 0-.975 13.245 13.245 0 0 1-2.003-.678z" fill={`url(#${gradientId})`} />
      </svg>
    );
  }

  if (providerId === "xai") {
    return (
      <svg viewBox="0 0 512 512" width={size} height={size} data-provider-brand="grok" aria-hidden="true">
        <rect width="512" height="512" rx="96" fill="#050505" />
        <path d="M210.484 312.759 343.465 210.383c6.519-5.019 15.837-3.061 18.943 4.734 16.35 41.114 9.046 90.523-23.483 124.446-32.528 33.924-77.788 41.364-119.157 24.42l-45.191 21.82c64.817 46.205 143.527 34.778 192.712-16.552 39.014-40.687 51.097-96.147 39.799-146.16l.102.107c-16.383-73.472 4.028-102.839 45.84-162.891.99-1.424 1.98-2.848 2.97-4.307l-55.022 57.382v-.178L210.45 312.794" fill="#FCFCFC" />
        <path d="M183.042 337.641c-46.523-46.347-38.502-118.074 1.194-159.438 29.354-30.613 77.447-43.107 119.43-24.739l45.089-21.714c-8.123-6.123-18.534-12.708-30.48-17.336-53.998-23.173-118.645-11.64-162.54 34.102-42.222 44.033-55.499 111.738-32.699 169.511 17.033 43.179-10.888 73.721-39.013 104.548C74.056 433.503 64.055 444.431 56 456l127.007-118.323" fill="#FCFCFC" />
      </svg>
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
