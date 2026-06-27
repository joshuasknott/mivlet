import { Eye, EyeSlash, LockKey, UserCircle } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { profileFixture } from "../../data/workspace";
import { PageHeader } from "../PageHeader";

export function ProfilePage() {
  const [profile, setProfile] = useState(profileFixture);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [status, setStatus] = useState("Mock profile ready.");

  const initials = useMemo(() => {
    const parts = profile.name
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length === 0) {
      return profile.photoInitials;
    }

    return parts
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }, [profile.name, profile.photoInitials]);

  const saveProfile = () => {
    setProfile((current) => ({ ...current, photoInitials: initials }));
    setStatus("Profile saved locally for this mock session.");
  };

  const updatePassword = () => {
    if (!currentPassword || !newPassword) {
      setStatus("Current and new password are required.");
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setStatus("Password change mocked. No credentials were sent or stored.");
  };

  return (
    <>
      <PageHeader
        icon={UserCircle}
        title="Profile"
        description="Account details for Arden identity, sign-in, and provider ownership."
        meta={profile.passwordUpdatedAt}
      />

      <section className="context-panel profile-settings-layout" aria-label="Profile settings">
        <article className="profile-card profile-card--identity">
          <div className={`profile-photo profile-photo--${profile.photoTone}`} aria-hidden="true">
            {initials}
          </div>
          <div className="profile-photo-actions">
            <strong>{profile.name}</strong>
            <small>{profile.email}</small>
            <div className="profile-action-row">
              <button
                type="button"
                onClick={() => {
                  setProfile((current) => ({ ...current, photoTone: "sage" }));
                  setStatus("Photo color set to sage.");
                }}
                aria-pressed={profile.photoTone === "sage"}
              >
                Sage
              </button>
              <button
                type="button"
                onClick={() => {
                  setProfile((current) => ({ ...current, photoTone: "slate" }));
                  setStatus("Photo color set to slate.");
                }}
                aria-pressed={profile.photoTone === "slate"}
              >
                Slate
              </button>
            </div>
          </div>
        </article>

        <article className="settings-panel">
          <div className="settings-panel__heading">
            <span className="settings-panel__icon" aria-hidden="true">
              <UserCircle size={19} />
            </span>
            <span>
              <strong>Basic details</strong>
              <small>Name and email used across Arden.</small>
            </span>
          </div>
          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Name</span>
              <input
                value={profile.name}
                onChange={(event) =>
                  setProfile((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label className="settings-field">
              <span>Email</span>
              <input
                type="email"
                value={profile.email}
                onChange={(event) =>
                  setProfile((current) => ({ ...current, email: event.target.value }))
                }
              />
            </label>
          </div>
          <div className="profile-action-row">
            <button type="button" onClick={saveProfile}>
              Save profile
            </button>
          </div>
        </article>

        <article className="settings-panel">
          <div className="settings-panel__heading">
            <span className="settings-panel__icon" aria-hidden="true">
              <LockKey size={19} />
            </span>
            <span>
              <strong>Password</strong>
              <small>Mock password update surface for account security.</small>
            </span>
          </div>
          <div className="settings-form-grid">
            <label className="settings-field settings-field--secret">
              <span>Current password</span>
              <input
                type={passwordVisible ? "text" : "password"}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="settings-field settings-field--secret">
              <span>New password</span>
              <input
                type={passwordVisible ? "text" : "password"}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
          </div>
          <div className="profile-action-row">
            <button type="button" onClick={() => setPasswordVisible((visible) => !visible)}>
              {passwordVisible ? <EyeSlash size={15} /> : <Eye size={15} />}
              {passwordVisible ? "Hide" : "Show"}
            </button>
            <button type="button" onClick={updatePassword}>
              Update password
            </button>
          </div>
        </article>

        <p className="settings-status" role="status">
          {status}
        </p>
      </section>
    </>
  );
}
