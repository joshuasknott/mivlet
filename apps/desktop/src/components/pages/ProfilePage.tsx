import { Eye, EyeSlash, LockKey, Trash, UploadSimple, UserCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { profileFixture } from "../../data/workspace";
import type { ProfileFixture } from "../../data/workspace";
import { PageHeader } from "../PageHeader";

export function ProfilePage({
  profile: externalProfile,
  onProfileChange
}: {
  profile?: ProfileFixture;
  onProfileChange?: (profile: ProfileFixture) => void;
}) {
  const [profile, setProfile] = useState(externalProfile || profileFixture);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(profile.photoUrl);
  const [status, setStatus] = useState("Profile changes are saved locally in this mock session.");
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (externalProfile) {
      setProfile(externalProfile);
      setPhotoPreview(externalProfile.photoUrl);
    }
  }, [externalProfile]);

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

  const handlePhotoUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : undefined;
      setPhotoPreview(result);
      setProfile((current) => ({ ...current, photoUrl: result }));
      setStatus(`${file.name} selected for this mock profile.`);
    });
    reader.readAsDataURL(file);
  };

  const removePhoto = () => {
    setPhotoPreview(undefined);
    setProfile((current) => ({ ...current, photoUrl: undefined }));
    if (photoInputRef.current) {
      photoInputRef.current.value = "";
    }
    setStatus("Profile photo removed for this mock session.");
  };

  const saveProfile = () => {
    const updated = { ...profile, photoInitials: initials, photoUrl: photoPreview };
    setProfile(updated);
    if (onProfileChange) {
      onProfileChange(updated);
    }
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
        description="Manage your personal details and sign-in security."
      />

      <section
        className="context-panel profile-settings-layout profile-settings-layout--clean"
        aria-label="Profile settings"
      >
        <article className="profile-clean-card">
          <div className="profile-clean-card__identity">
            <div className="profile-photo" aria-hidden="true">
              {photoPreview ? (
                <img src={photoPreview} alt="" />
              ) : (
                <UserCircle size={58} weight="regular" />
              )}
            </div>
            <div className="profile-identity-copy">
              <strong>{profile.name || "Josh"}</strong>
              <small>{profile.email || "josh@example.com"}</small>
            </div>
            <div className="profile-photo-buttons">
              <input
                ref={photoInputRef}
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Upload profile photo"
                onChange={handlePhotoUpload}
              />
              <button type="button" onClick={() => photoInputRef.current?.click()}>
                <UploadSimple size={16} />
                <span>{photoPreview ? "Change photo" : "Upload photo"}</span>
              </button>
              <button
                type="button"
                className="profile-photo-buttons__danger button button--destructive"
                onClick={removePhoto}
                disabled={!photoPreview}
              >
                <Trash size={16} />
                <span>Remove</span>
              </button>
            </div>
          </div>

          <div className="profile-clean-card__content">
            <section className="profile-section" aria-labelledby="profile-details-title">
              <div className="profile-section__heading">
                <span className="settings-panel__icon" aria-hidden="true">
                  <UserCircle size={19} />
                </span>
                <span>
                  <strong id="profile-details-title">Profile details</strong>
                  <small>Name and email used across Fable.</small>
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
            </section>

            <section className="profile-section" aria-labelledby="profile-security-title">
              <div className="profile-section__heading">
                <span className="settings-panel__icon" aria-hidden="true">
                  <LockKey size={19} />
                </span>
                <span>
                  <strong id="profile-security-title">Security</strong>
                  <small>Password controls for this account.</small>
                </span>
              </div>
              <p className="profile-security-note">
                Password {profile.passwordUpdatedAt.toLowerCase()}
              </p>
              <div className="settings-form-grid">
                <label className="settings-field settings-field--secret">
                  <span>Current password</span>
                  <span className="profile-secret-input">
                    <input
                      type={passwordVisible ? "text" : "password"}
                      value={currentPassword}
                      placeholder="Enter current password"
                      onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={passwordVisible ? "Hide passwords" : "Show passwords"}
                      onClick={() => setPasswordVisible((visible) => !visible)}
                    >
                      {passwordVisible ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </button>
                  </span>
                </label>
                <label className="settings-field settings-field--secret">
                  <span>New password</span>
                  <span className="profile-secret-input">
                    <input
                      type={passwordVisible ? "text" : "password"}
                      value={newPassword}
                      placeholder="Enter new password"
                      onChange={(event) => setNewPassword(event.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={passwordVisible ? "Hide passwords" : "Show passwords"}
                      onClick={() => setPasswordVisible((visible) => !visible)}
                    >
                      {passwordVisible ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </button>
                  </span>
                </label>
              </div>
              <div className="profile-action-row profile-action-row--end">
                <button type="button" className="profile-button button button--secondary" onClick={updatePassword}>
                  Update password
                </button>
              </div>
            </section>
          </div>

          <footer className="profile-clean-card__footer">
            <p className="settings-status" role="status">
              {status}
            </p>
            <div className="profile-action-row">
              <button
                type="button"
                className="profile-button button button--secondary"
                onClick={() => {
                  setProfile(externalProfile || profileFixture);
                  setPhotoPreview((externalProfile || profileFixture).photoUrl);
                  setCurrentPassword("");
                  setNewPassword("");
                  setStatus("Profile changes reset for this mock session.");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="profile-button profile-button--primary button button--primary"
                aria-label="Save profile"
                onClick={saveProfile}
              >
                Save changes
              </button>
            </div>
          </footer>
        </article>
      </section>
    </>
  );
}
