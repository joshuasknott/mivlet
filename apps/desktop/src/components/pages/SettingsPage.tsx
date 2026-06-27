import { CheckCircle, GearSix, Key, LockKey, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";

type SettingsTab = "account" | "providers" | "privacy" | "notifications";

type ProviderAccess = {
  id: string;
  name: string;
  detail: string;
  status: "connected" | "not-connected";
  action: "Manage" | "Connect";
  icon: "sparkle" | "key";
};

const tabs: { id: SettingsTab; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "providers", label: "Providers" },
  { id: "privacy", label: "Privacy" },
  { id: "notifications", label: "Notifications" }
];

const initialProviders: ProviderAccess[] = [
  {
    id: "fable-pro",
    name: "Fable Pro",
    detail: "Subscription access",
    status: "connected",
    action: "Manage",
    icon: "sparkle"
  },
  {
    id: "openai",
    name: "OpenAI",
    detail: "API key",
    status: "connected",
    action: "Manage",
    icon: "key"
  },
  {
    id: "anthropic",
    name: "Anthropic",
    detail: "API key",
    status: "not-connected",
    action: "Connect",
    icon: "key"
  }
];

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers");
  const [providers, setProviders] = useState(initialProviders);
  const [status, setStatus] = useState("");

  const connectProvider = (providerId: string) => {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerId
          ? { ...provider, status: "connected", action: "Manage" }
          : provider
      )
    );

    const provider = providers.find((item) => item.id === providerId);
    setStatus(`${provider?.name ?? "Provider"} connected for this mock session.`);
  };

  return (
    <section className="settings-single-pane" aria-labelledby="settings-title">
      <div className="settings-single-pane__header">
        <h1 id="settings-title">Settings</h1>
      </div>

      <div className="settings-single-pane__tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              setStatus(`${tab.label} settings selected.`);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "providers" ? (
        <ProviderAccessView providers={providers} onConnect={connectProvider} />
      ) : (
        <QuietPlaceholder tab={activeTab} />
      )}

      {status ? (
        <p className="settings-status settings-status--single-pane" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

function ProviderAccessView({
  providers,
  onConnect
}: {
  providers: ProviderAccess[];
  onConnect: (providerId: string) => void;
}) {
  return (
    <div className="settings-single-pane__content">
      <div className="settings-section-heading">
        <h2>Provider access</h2>
        <p>Connect and manage your AI provider access.</p>
      </div>

      <div className="provider-access-list" aria-label="Provider access">
        {providers.map((provider) => (
          <article className="provider-access-row" key={provider.id}>
            <span className="provider-access-row__icon" aria-hidden="true">
              {provider.icon === "sparkle" ? <Sparkle size={23} /> : <Key size={23} />}
            </span>

            <div className="provider-access-row__name">
              <strong>{provider.name}</strong>
              <span>{provider.detail}</span>
            </div>

            <span
              className={`provider-access-state provider-access-state--${provider.status}`}
              aria-label={`${provider.name} is ${provider.status === "connected" ? "connected" : "not connected"}`}
            >
              {provider.status === "connected" ? (
                <CheckCircle size={14} weight="fill" />
              ) : (
                <WarningCircle size={14} />
              )}
              {provider.status === "connected" ? "Connected" : "Not connected"}
            </span>

            <button type="button" onClick={() => onConnect(provider.id)}>
              {provider.action}
            </button>
          </article>
        ))}
      </div>

      <div className="settings-local-storage">
        <span aria-hidden="true">
          <LockKey size={18} />
        </span>
        <div>
          <strong>Local storage</strong>
          <p>Your credentials and preferences are stored only on this device.</p>
        </div>
        <button type="button">Learn more</button>
      </div>
    </div>
  );
}

function QuietPlaceholder({ tab }: { tab: Exclude<SettingsTab, "providers"> }) {
  const copy = {
    account: {
      title: "Account",
      description: "Profile and plan controls will live here."
    },
    privacy: {
      title: "Privacy",
      description: "Local defaults and data controls will live here."
    },
    notifications: {
      title: "Notifications",
      description: "Notification preferences will live here."
    }
  };

  return (
    <div className="settings-single-pane__content">
      <div className="settings-section-heading">
        <h2>{copy[tab].title}</h2>
        <p>{copy[tab].description}</p>
      </div>
      <div className="settings-empty-row">
        <GearSix size={18} />
        <span>Nothing to configure yet.</span>
      </div>
    </div>
  );
}
