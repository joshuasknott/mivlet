import {
  CheckCircle,
  CreditCard,
  GearSix,
  Key,
  Plus,
  Robot,
  ShieldCheck,
  WarningCircle
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  modelOptions,
  modelPreferences,
  settingsToggles,
  subscriptionProviders,
  type SubscriptionProvider
} from "../../data/workspace";
import { PageHeader } from "../PageHeader";

type SettingsTab = "onboarding" | "providers" | "models";

const tabs: { id: SettingsTab; label: string }[] = [
  { id: "onboarding", label: "Onboarding" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" }
];

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("onboarding");
  const [providers, setProviders] = useState(subscriptionProviders);
  const [modelSelections, setModelSelections] = useState<Record<string, string>>(
    () =>
      Object.fromEntries(
        modelPreferences.map((preference) => [preference.id, preference.selectedModel])
      ) as Record<string, string>
  );
  const [toggles, setToggles] = useState(settingsToggles);
  const [status, setStatus] = useState("Settings are mocked locally.");

  const connectedCount = providers.filter((provider) => provider.status === "connected").length;
  const ready = connectedCount > 0;

  const connectProvider = (provider: SubscriptionProvider) => {
    setProviders((current) =>
      current.map((item) =>
        item.id === provider.id
          ? {
              ...item,
              status: "connected",
              accountLabel: item.credentialType === "subscription" ? "Subscription connected" : "API key added",
              maskedCredential:
                item.credentialType === "subscription"
                  ? "Connected through hosted account"
                  : `${item.id.slice(0, 3)}-key-...mock`
            }
          : item
      )
    );
    setStatus(`${provider.name} connected for this mock session.`);
  };

  const selectedModels = useMemo(
    () =>
      modelPreferences.map((preference) => ({
        ...preference,
        selectedModel: modelSelections[preference.id] ?? preference.selectedModel
      })),
    [modelSelections]
  );

  return (
    <>
      <PageHeader
        icon={GearSix}
        title="Settings"
        description="Provider access, model routing, and local safety defaults."
        meta={ready ? `${connectedCount} provider connected` : "Setup required"}
      />

      <section className="context-panel settings-page" aria-label="Settings">
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "onboarding" ? (
          <OnboardingSettings
            ready={ready}
            providers={providers}
            connectedCount={connectedCount}
            onConnect={connectProvider}
          />
        ) : null}

        {activeTab === "providers" ? (
          <ProviderSettings providers={providers} onConnect={connectProvider} />
        ) : null}

        {activeTab === "models" ? (
          <ModelSettings
            selectedModels={selectedModels}
            modelSelections={modelSelections}
            onSelectModel={(slotId, modelId) => {
              setModelSelections((current) => ({ ...current, [slotId]: modelId }));
              setStatus("Model preference saved for this mock session.");
            }}
            toggles={toggles}
            onToggle={(toggleId) => {
              setToggles((current) =>
                current.map((toggle) =>
                  toggle.id === toggleId ? { ...toggle, enabled: !toggle.enabled } : toggle
                )
              );
              setStatus("Model setting updated.");
            }}
          />
        ) : null}

        <p className="settings-status" role="status">
          {status}
        </p>
      </section>
    </>
  );
}

function OnboardingSettings({
  ready,
  providers,
  connectedCount,
  onConnect
}: {
  ready: boolean;
  providers: SubscriptionProvider[];
  connectedCount: number;
  onConnect: (provider: SubscriptionProvider) => void;
}) {
  const primaryProvider = providers.find((provider) => provider.status === "connected") ?? providers[0];

  return (
    <div className="settings-stack">
      <article className={`settings-panel onboarding-panel${ready ? " onboarding-panel--ready" : ""}`}>
        <div className="settings-panel__heading">
          <span className="settings-panel__icon" aria-hidden="true">
            {ready ? <CheckCircle size={19} /> : <WarningCircle size={19} />}
          </span>
          <span>
            <strong>{ready ? "Ready to run model tasks" : "Connect one provider to start"}</strong>
            <small>
              {ready
                ? `${connectedCount} provider is available for chats, coding, and automations.`
                : "Arden needs a subscription connection or API key before provider-backed work can run."}
            </small>
          </span>
        </div>
        <div className="onboarding-checklist">
          <span data-complete={ready}>
            <CheckCircle size={16} />
            Provider access
          </span>
          <span data-complete={ready}>
            <CheckCircle size={16} />
            Default model
          </span>
          <span data-complete="true">
            <CheckCircle size={16} />
            Local safety defaults
          </span>
        </div>
      </article>

      <ProviderCard provider={primaryProvider} compact onConnect={onConnect} />
    </div>
  );
}

function ProviderSettings({
  providers,
  onConnect
}: {
  providers: SubscriptionProvider[];
  onConnect: (provider: SubscriptionProvider) => void;
}) {
  return (
    <div className="settings-grid">
      {providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} onConnect={onConnect} />
      ))}
    </div>
  );
}

function ProviderCard({
  provider,
  compact,
  onConnect
}: {
  provider: SubscriptionProvider;
  compact?: boolean;
  onConnect: (provider: SubscriptionProvider) => void;
}) {
  const connected = provider.status === "connected";

  return (
    <article
      className={`settings-panel provider-card${compact ? " provider-card--compact" : ""}`}
      data-provider-id={provider.id}
    >
      <div className="settings-panel__heading">
        <span className="settings-panel__icon" aria-hidden="true">
          {provider.credentialType === "subscription" ? <CreditCard size={19} /> : <Key size={19} />}
        </span>
        <span>
          <strong>{provider.name}</strong>
          <small>{provider.description}</small>
        </span>
        <span className={`provider-state provider-state--${connected ? "connected" : "needs-key"}`}>
          {connected ? "connected" : provider.credentialType === "subscription" ? "connect" : "key needed"}
        </span>
      </div>

      <dl className="provider-details">
        <div>
          <dt>Access</dt>
          <dd>{provider.accountLabel}</dd>
        </div>
        <div>
          <dt>Credential</dt>
          <dd>{provider.maskedCredential}</dd>
        </div>
      </dl>

      <div className="permission-list">
        {provider.includedModels.map((model) => (
          <span key={model}>{model}</span>
        ))}
      </div>

      <div className="profile-action-row">
        <button type="button" onClick={() => onConnect(provider)}>
          {connected ? <CheckCircle size={15} /> : <Plus size={15} />}
          {connected ? "Refresh" : provider.credentialType === "subscription" ? "Connect" : "Add key"}
        </button>
      </div>
    </article>
  );
}

function ModelSettings({
  selectedModels,
  modelSelections,
  onSelectModel,
  toggles,
  onToggle
}: {
  selectedModels: typeof modelPreferences;
  modelSelections: Record<string, string>;
  onSelectModel: (slotId: string, modelId: string) => void;
  toggles: typeof settingsToggles;
  onToggle: (toggleId: string) => void;
}) {
  return (
    <div className="settings-stack">
      <div className="model-preference-list">
        {selectedModels.map((preference) => (
          <article className="settings-panel model-row" key={preference.id} data-model-slot={preference.id}>
            <div className="settings-panel__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <Robot size={19} />
              </span>
              <span>
                <strong>{preference.label}</strong>
                <small>{preference.description}</small>
              </span>
            </div>
            <label className="settings-field">
              <span>Model</span>
              <select
                value={modelSelections[preference.id] ?? preference.selectedModel}
                onChange={(event) => onSelectModel(preference.id, event.target.value)}
              >
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} - {model.provider}
                  </option>
                ))}
              </select>
            </label>
          </article>
        ))}
      </div>

      <article className="settings-panel">
        <div className="settings-panel__heading">
          <span className="settings-panel__icon" aria-hidden="true">
            <ShieldCheck size={19} />
          </span>
          <span>
            <strong>Model behavior</strong>
            <small>Defaults that apply before a task chooses a provider.</small>
          </span>
        </div>
        <div className="toggle-list">
          {toggles.map((toggle) => (
            <button
              key={toggle.id}
              type="button"
              className="toggle-row"
              aria-pressed={toggle.enabled}
              onClick={() => onToggle(toggle.id)}
            >
              <span>
                <strong>{toggle.label}</strong>
                <small>{toggle.description}</small>
              </span>
              <span className="toggle-switch" aria-hidden="true">
                <span />
              </span>
            </button>
          ))}
        </div>
      </article>
    </div>
  );
}
