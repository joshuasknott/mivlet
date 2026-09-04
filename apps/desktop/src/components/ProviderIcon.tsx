import { Cube } from "@phosphor-icons/react/dist/csr/Cube";
import { CursorClick } from "@phosphor-icons/react/dist/csr/CursorClick";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { useId } from "react";

interface ProviderIconProps {
  provider: string;
  size?: number;
}

const openAiPath =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

export function ProviderIcon({ provider, size = 20 }: ProviderIconProps) {
  const providerId = provider.toLowerCase();
  const gradientId = useId().replaceAll(":", "");

  if (providerId === "codex" || providerId === "openai") {
    const color = providerId === "codex" ? "#3941FF" : "var(--provider-monochrome)";
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ color }} data-provider-brand={providerId} aria-hidden="true">
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
    return <CursorClick size={size} weight="duotone" data-provider-brand="cursor" aria-hidden="true" />;
  }

  if (providerId === "opencode") {
    return <TerminalWindow size={size} weight="duotone" data-provider-brand="opencode" aria-hidden="true" />;
  }

  return <Cube size={size} data-provider-brand={providerId === "custom" ? "custom" : undefined} aria-hidden="true" />;
}
