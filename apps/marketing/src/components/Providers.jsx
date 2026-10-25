import "./providers.css";

const providers = [
  {
    id: "chatgpt",
    name: "ChatGPT",
  },
  {
    id: "claude",
    name: "Claude",
  },
  {
    id: "gemini",
    name: "Gemini",
  },
  {
    id: "antigravity",
    name: "Antigravity",
  },
  {
    id: "grok",
    name: "Grok",
  },
  {
    id: "cursor",
    name: "Cursor",
  },
  {
    id: "opencode",
    name: "OpenCode",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
  },
  {
    id: "qwen",
    name: "Qwen",
  },
  {
    id: "kimi",
    name: "Kimi",
  },
  {
    id: "mistral",
    name: "Mistral",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
  },
];

function ProviderMark({ id }) {
  if (
    id === "cursor" ||
    id === "opencode" ||
    id === "antigravity" ||
    id === "openrouter" ||
    id === "gemini"
  ) {
    const source =
      id === "antigravity"
        ? "/brand/google-antigravity.png"
        : id === "gemini"
          ? "/brand/gemini.svg"
          : `/brand/${id}.svg`;
    return (
      <img
        className="provider-mark__image"
        src={source}
        alt=""
        aria-hidden="true"
      />
    );
  }

  const additional = ["deepseek", "qwen", "kimi", "mistral"].includes(id);
  const sprite = additional
    ? "additional-provider-artwork"
    : "provider-artwork";
  const symbol =
    id === "chatgpt"
      ? "openai"
      : id === "claude"
        ? "anthropic"
        : id === "grok"
          ? "xai"
          : id === "qwen"
            ? "alibaba"
            : id === "kimi"
              ? "moonshot"
              : id;
  const viewBox =
    id === "chatgpt"
      ? "1.68 1.75 16.65 16.5"
      : id === "claude"
        ? "0 0 125 125"
        : id === "grok"
          ? "0 0 512 512"
          : "0 0 24 24";
  return (
    <svg
      className={`provider-mark provider-mark--${id}`}
      viewBox={viewBox}
      aria-hidden="true"
    >
      <use href={`/brand/${sprite}.svg#${symbol}`} />
    </svg>
  );
}

export default function Providers() {
  return (
    <section
      id="connections"
      className="providers-section"
      aria-labelledby="providers-heading"
    >
      <div className="providers-section__intro">
        <h2 id="providers-heading">
          Your favourite AI.
          <br />A place of its own.
        </h2>
        <p className="providers-section__copy">
          Connect the models you already trust and move between them without
          moving your work.
        </p>
        <p className="providers-section__requirements">
          Use a supported provider account or your own API key. Provider
          subscriptions and usage are separate.
        </p>
      </div>
      <div
        className="providers-marquee"
        role="region"
        aria-label="AI providers"
      >
        <div className="providers-marquee__track">
          <ul className="providers-marquee__list">
            {providers.map((provider) => (
              <li className="providers-marquee__item" key={provider.id}>
                <span
                  className="provider-logo"
                  role="img"
                  aria-label={provider.name}
                >
                  <ProviderMark id={provider.id} />
                </span>
              </li>
            ))}
          </ul>
          <ul className="providers-marquee__list" aria-hidden="true">
            {providers.map((provider) => (
              <li
                className="providers-marquee__item"
                key={`duplicate-${provider.id}`}
              >
                <span className="provider-logo">
                  <ProviderMark id={provider.id} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
