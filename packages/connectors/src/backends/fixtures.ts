/**
 * Fixture/preview catalogs for the agent-runtime backends.
 *
 * This is the *data* side of the logic/data split — static catalogs only. It
 * contains no credentials, live API responses, transport code, or user
 * secrets. Adapter *logic* (capability resolution, transport description)
 * lives in `codex.ts` / `acp.ts` / `copilot.ts`.
 *
 * Compliance constraints baked into these fixtures:
 *   - No claim that any tier includes Grok Build (entitlement detected
 *     post-login only).
 *   - No Claude or Gemini provider entries surfaced this goal.
 *   - Install hints name a user-installed CLI; nothing is redistributed.
 */

export interface BackendFixtureModel {
  id: string;
  label: string;
}

export interface CodexFixture {
  label: string;
  description: string;
  installHint: string;
  models: BackendFixtureModel[];
}

export type AcpProviderId = "cursor" | "grok";

export interface AcpFixture {
  providerId: AcpProviderId;
  label: string;
  description: string;
  installHint: string;
  models: BackendFixtureModel[];
}

export type CopilotAuthMode = "subscriber" | "oauth-app" | "automation-token" | "byok";

export interface CopilotFixture {
  label: string;
  description: string;
  installHint: string;
  models: BackendFixtureModel[];
}

export const codexFixtures: CodexFixture = {
  label: "Codex",
  description:
    "Continue with ChatGPT/Codex. Reaches your subscription through the Codex app-server; also supports an OpenAI API key.",
  installHint: "Requires the Codex CLI. Install it, then connect.",
  models: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-thinking", label: "GPT-5 Thinking" },
    { id: "gpt-4.1", label: "GPT-4.1" }
  ]
};

export const acpFixtures: AcpFixture[] = [
  {
    providerId: "cursor",
    label: "Cursor",
    description:
      "Reaches your Cursor subscription over ACP (stdio/JSON-RPC) using your installed Cursor CLI.",
    installHint: "Requires the Cursor CLI. Install it, then connect.",
    models: [
      { id: "cursor-default", label: "Cursor default" },
      { id: "cursor-composer", label: "Cursor composer" }
    ]
  },
  {
    providerId: "grok",
    label: "Grok",
    description:
      "Reaches your Grok account over ACP (stdio/JSON-RPC) using your installed Grok CLI. Entitlements are checked after login.",
    installHint: "Requires the Grok CLI. Install it, then connect.",
    // Note: no tier claims. Grok Build entitlement is resolved post-login only.
    models: [{ id: "grok-default", label: "Grok" }]
  }
];

export const copilotFixtures: CopilotFixture = {
  label: "GitHub Copilot",
  description:
    "Reaches Copilot through its SDK. Supports subscriber, OAuth app, automation token, and BYOK auth.",
  installHint: "Requires the Copilot SDK to be available in this build.",
  models: [
    { id: "copilot-default", label: "Copilot default" },
    { id: "copilot-claude", label: "Copilot + Claude" }
  ]
};

export type NativeProviderId = "openai" | "anthropic" | "gemini" | "xai" | "openrouter";

export interface NativeFixture {
  providerId: NativeProviderId;
  label: string;
  description: string;
  authLabel: string;
  models: BackendFixtureModel[];
}

/**
 * Native API provider catalogs — the providers Arden reaches directly over
 * HTTP/SSE, owning the entire agent loop. Compliance baked into copy:
 *   - Anthropic: API key / Vertex / Bedrock only — no Claude.ai subscription
 *     (Anthropic blocks third-party Claude.ai login without approval).
 *   - Gemini: API key / Vertex only — no Google AI Pro/Ultra subscription reuse
 *     (Google's CLI terms forbid third-party OAuth to its underlying services).
 *   - xAI/Grok: never assert any entitlement (carried over from goal 1).
 */
export const nativeFixtures: NativeFixture[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    description:
      "Reach GPT models directly with an OpenAI API key. Arden owns the agent loop, tool dispatch, and approvals.",
    authLabel: "OpenAI API key",
    models: [
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-thinking", label: "GPT-5 Thinking" },
      { id: "gpt-4.1", label: "GPT-4.1" }
    ]
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    description:
      "Reach Claude via an Anthropic API key, Vertex AI, or Amazon Bedrock. Arden owns the agent loop.",
    authLabel: "Anthropic API key / Vertex / Bedrock",
    models: [
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "claude-opus-4", label: "Claude Opus 4" }
    ]
  },
  {
    providerId: "gemini",
    label: "Google Gemini",
    description:
      "Reach Gemini via a Google AI API key or Vertex AI. Arden owns the agent loop.",
    authLabel: "Google AI API key / Vertex AI",
    models: [
      { id: "gemini-2-pro", label: "Gemini 2 Pro" },
      { id: "gemini-2-flash", label: "Gemini 2 Flash" }
    ]
  },
  {
    providerId: "xai",
    label: "xAI",
    description:
      "Reach Grok models directly with an xAI API key. Arden owns the agent loop, tool dispatch, and approvals.",
    authLabel: "xAI API key",
    models: [{ id: "grok-4", label: "Grok 4" }]
  },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    description:
      "Reach many models through OpenRouter with an OpenRouter API key. Arden owns the agent loop.",
    authLabel: "OpenRouter API key",
    models: [
      { id: "openrouter:auto", label: "OpenRouter Auto" },
      { id: "openrouter:claude", label: "OpenRouter Claude" }
    ]
  }
];
