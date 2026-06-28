import { LockKey, Trash, UploadSimple, UserCircle } from "@phosphor-icons/react";
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
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(profile.photoUrl);
  const [status, setStatus] = useState("Profile changes are local to this desktop workspace.");
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
      setStatus(`${file.name} selected for this local profile.`);
    });
    reader.readAsDataURL(file);
  };

  const removePhoto = () => {
    setPhotoPreview(undefined);
    setProfile((current) => ({ ...current, photoUrl: undefined }));
    if (photoInputRef.current) {
      photoInputRef.current.value = "";
    }
    setStatus("Profile photo removed locally.");
  };

  const saveProfile = () => {
    const updated = { ...profile, photoInitials: initials, photoUrl: photoPreview };
    setProfile(updated);
    if (onProfileChange) {
      onProfileChange(updated);
    }
    setStatus("Profile saved locally on this device.");
  };

  return (
    <>
      <PageHeader
        icon={UserCircle}
        title="Profile"
        description="Manage local display details for this workspace."
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
                  <small>Name and email used for local display.</small>
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
                  <strong id="profile-security-title">Provider credentials</strong>
                  <small>API keys are managed in Settings and stored by the local credential boundary.</small>
                </span>
              </div>
              <p className="profile-security-note">
                This local profile is not a hosted Fable account.
              </p>
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
                  setStatus("Profile changes reset locally.");
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
