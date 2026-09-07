import { Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { Sun } from "@phosphor-icons/react/dist/csr/Sun";
import type { VoiceCapability } from "@fable/protocol";
import { PERMISSION_PROFILES } from "../../lib/agent-run";
import type { SettingsRuntime } from "./settings-runtime";

export function ApprovalsSettingsView({
  runtime,
  onStatus,
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-preference-row">
      <label htmlFor="approval-preset">
        <strong>Approvals</strong>
        <small>Choose when agents ask before acting.</small>
      </label>
      <select
        id="approval-preset"
        aria-label="Approvals"
        value={runtime.permissionLabel}
        onChange={(event) => {
          runtime.selectPermissionLabel(event.target.value);
          onStatus(
            event.target.options[event.target.selectedIndex].text +
              " selected.",
          );
        }}
      >
        {PERMISSION_PROFILES.filter((profile) => !profile.custom).map(
          (profile) => (
            <option key={profile.label} value={profile.label}>
              {
                {
                  "Read Only": "Read only",
                  "Ask Me": "Ask first",
                  "Work Freely": "Full access",
                }[profile.label as "Read Only" | "Ask Me" | "Work Freely"]
              }
            </option>
          ),
        )}
        {runtime.permissionLabel === "Custom" && (
          <option value="Custom" disabled>
            Custom (current)
          </option>
        )}
      </select>
    </div>
  );
}

export function DictationPrivacySettings({
  runtime,
  capability,
  onStatus,
}: {
  runtime: SettingsRuntime;
  capability: VoiceCapability;
  onStatus: (message: string) => void;
}) {
  const available = capability.status === "supported";
  return (
    <div className="settings-page__body">
      <button
        type="button"
        className="toggle-row settings-preference-row"
        aria-pressed={runtime.voiceEnabled}
        disabled={!available && !runtime.voiceEnabled}
        onClick={() => {
          const enabled = !runtime.voiceEnabled;
          runtime.setVoiceEnabled(enabled);
          onStatus(enabled ? "Dictation enabled." : "Dictation disabled.");
        }}
      >
        <span>
          <strong>Dictation</strong>
          <small>Turn speech into text.</small>
        </span>
        <span className="toggle-switch" aria-hidden="true">
          <span />
        </span>
      </button>
      <p className="settings-input-note">
        {!available ? capability.reason + " " : ""}Fable does not save raw
        audio.
      </p>
      <details className="settings-disclosure">
        <summary>Speech processing</summary>
        <p>
          Your browser or operating system may process speech remotely. Fable
          keeps the text you send.
        </p>
      </details>
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
    <div className="settings-preference-row">
      <span>
        <strong>Appearance</strong>
        <small>Choose how Fable looks.</small>
      </span>
      <div
        className="theme-toggle theme-toggle--settings"
        role="group"
        aria-label="Theme"
      >
        {(["light", "dark"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={
              "theme-toggle__button" +
              (theme === option ? " theme-toggle__button--active" : "")
            }
            aria-pressed={theme === option}
            onClick={() => {
              onThemeChange(option);
              onStatus(
                option === "light"
                  ? "Light theme applied."
                  : "Dark theme applied.",
              );
            }}
          >
            {option === "light" ? <Sun size={17} /> : <Moon size={17} />}
            <span>{option === "light" ? "Light" : "Dark"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
