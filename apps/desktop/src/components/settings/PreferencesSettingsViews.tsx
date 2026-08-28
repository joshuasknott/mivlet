import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { Sun } from "@phosphor-icons/react/dist/csr/Sun";
import type {
  CustomApprovalSettings,
  VoiceCapability,
} from "@fable/protocol";
import {
  CUSTOM_APPROVAL_SECTION,
  CUSTOM_APPROVAL_TOGGLE_ORDER,
  customApprovalToggleHelper,
  customApprovalToggleLabel,
} from "../../lib/approval-copy";
import { PERMISSION_PROFILES } from "../../lib/agent-run";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

export function ApprovalsSettingsView({
  runtime,
  onStatus,
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const handleToggle = (key: keyof CustomApprovalSettings, value: boolean) => {
    runtime.updateCustomApprovalSetting(key, value);
    onStatus(`${customApprovalToggleLabel(key)} ${value ? "on" : "off"}.`);
  };

  return (
    <div className="settings-page__body approvals-settings">
      <div className="settings-section-heading">
        <p>Choose how often Fable should stop and ask before it acts.</p>
      </div>

      <section
        className="approvals-settings__section"
        aria-labelledby="approval-choice-title"
      >
        <div className="profile-section__heading">
          <span className="settings-panel__icon" aria-hidden="true">
            <ShieldCheck size={19} />
          </span>
          <span>
            <strong id="approval-choice-title">How Fable should work</strong>
            <small>Ask Me is the recommended starting point.</small>
          </span>
        </div>
        <div
          className="approval-preset-grid"
          role="radiogroup"
          aria-labelledby="approval-choice-title"
        >
          {PERMISSION_PROFILES.map((profile) => (
            <button
              key={profile.label}
              type="button"
              className="approval-preset-option"
              role="radio"
              aria-checked={runtime.permissionLabel === profile.label}
              data-selected={
                runtime.permissionLabel === profile.label || undefined
              }
              onClick={() => {
                runtime.selectPermissionLabel(profile.label);
                onStatus(`${profile.label} selected.`);
              }}
            >
              <strong>{profile.label}</strong>
              <span>{profile.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section
        className="approvals-settings__section"
        aria-labelledby="custom-approvals-title"
      >
        <div className="profile-section__heading">
          <span className="settings-panel__icon" aria-hidden="true">
            <GearSix size={19} />
          </span>
          <span>
            <strong id="custom-approvals-title">
              {CUSTOM_APPROVAL_SECTION.heading}
            </strong>
            <small>{CUSTOM_APPROVAL_SECTION.intro}</small>
          </span>
        </div>
        <div
          className="custom-approvals-list"
          role="group"
          aria-labelledby="custom-approvals-title"
        >
          {CUSTOM_APPROVAL_TOGGLE_ORDER.map((key) => {
            const checked = runtime.customApprovalSettings[key];
            return (
              <button
                key={key}
                type="button"
                className="toggle-row custom-approval-toggle"
                aria-pressed={checked}
                onClick={() => handleToggle(key, !checked)}
              >
                <span>
                  <strong>{customApprovalToggleLabel(key)}</strong>
                  <small>{customApprovalToggleHelper(key)}</small>
                </span>
                <span className="toggle-switch" aria-hidden="true">
                  <span />
                </span>
              </button>
            );
          })}
        </div>
        <p className="approvals-settings__note">
          {CUSTOM_APPROVAL_SECTION.reassurance}
        </p>
      </section>

    </div>
  );
}

export function DictationPrivacySettings({
  runtime,
  capability,
  onStatus,
}: {
  runtime: ShellRuntime;
  capability: VoiceCapability;
  onStatus: (message: string) => void;
}) {
  const available = capability.status === "supported";
  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>
          Control optional input features that can access sensitive device data.
        </p>
      </div>
      <div className="provider-access-list" style={{ padding: "14px 20px" }}>
        <button
          type="button"
          className="toggle-row"
          aria-pressed={runtime.voiceEnabled}
          disabled={!available && !runtime.voiceEnabled}
          onClick={() => {
            const enabled = !runtime.voiceEnabled;
            runtime.setVoiceEnabled(enabled);
            onStatus(enabled ? "Dictation enabled." : "Dictation disabled.");
          }}
        >
          <span>
            <strong>Enable dictation</strong>
            <small>
              Starts only when you choose the microphone. Fable does not retain
              raw audio or persist a separate dictation transcript. Recognized
              text is added to your normal composer draft. Speech processing may
              use an operating-system or browser service.
            </small>
            {!available ? (
              <small>{capability.reason} Text input remains available.</small>
            ) : null}
          </span>
          <span className="toggle-switch" aria-hidden="true">
            <span />
          </span>
        </button>
      </div>
    </div>
  );
}

export function AppearanceSettingsView({
  theme,
  onThemeChange,
  onStatus,
}: {
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>Customize the look and feel of the Fable interface.</p>
      </div>

      <div className="provider-access-list" style={{ padding: "20px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <strong
              style={{
                display: "block",
                color: "var(--ink)",
                fontSize: "var(--text-14)",
                fontWeight: 500,
              }}
            >
              Interface Theme
            </strong>
            <span
              style={{
                display: "block",
                color: "var(--ink-muted)",
                fontSize: "var(--text-12)",
                marginTop: "4px",
              }}
            >
              Choose between Light and Dark color schemes.
            </span>
          </div>
          <div
            className="theme-toggle theme-toggle--settings"
            role="group"
            aria-label="Theme"
          >
            <button
              type="button"
              className={`theme-toggle__button${theme === "light" ? " theme-toggle__button--active" : ""}`}
              aria-pressed={theme === "light"}
              onClick={() => {
                onThemeChange("light");
                onStatus("Light theme applied.");
              }}
            >
              <Sun size={17} />
              <span>Light</span>
            </button>
            <button
              type="button"
              className={`theme-toggle__button${theme === "dark" ? " theme-toggle__button--active" : ""}`}
              aria-pressed={theme === "dark"}
              onClick={() => {
                onThemeChange("dark");
                onStatus("Dark theme applied.");
              }}
            >
              <Moon size={17} />
              <span>Dark</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
