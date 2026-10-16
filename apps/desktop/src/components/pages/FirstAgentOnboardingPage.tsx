import type { MivletAgentProfile } from "@mivlet/protocol";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand } from "../Brand";
import { AgentAvatar } from "../agents/agent-icons";
import { AgentAppearancePicker } from "../agents/AgentAppearancePicker";

import "../../styles/routes/first-agent-onboarding.css";

export type FirstAgentSetup = {
  name: string;
  instructions: string;
  avatarSeed: string;
  iconColor: string;
};

export function FirstAgentOnboardingPage({
  agent,
  onSave,
}: {
  agent: MivletAgentProfile;
  onSave: (setup: FirstAgentSetup) => void | Promise<void>;
}) {
  const [name, setName] = useState(agent.name || "Chief of Staff");
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [avatarSeed, setAvatarSeed] = useState(
    agent.avatarSeed ?? `blob-v1:${agent.id}`,
  );
  const [iconColor, setIconColor] = useState(agent.iconColor);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: name.trim() || "Chief of Staff",
        instructions: instructions.trim(),
        avatarSeed,
        iconColor,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save your first agent. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="first-agent-setup" aria-label="Set up your first agent">
      <Brand compact className="first-agent-onboarding__brand" />
      <section
        className="first-agent-onboarding__card"
        aria-labelledby="first-agent-title"
      >
        <div className="first-agent-onboarding__intro">
          <div className="first-agent-onboarding__avatar" aria-hidden="true">
            <AgentAvatar
              seed={avatarSeed}
              color={iconColor}
              iconSize={86}
              motion="expressive"
            />
          </div>
          <p className="first-agent-onboarding__eyebrow">Your first agent</p>
          <h1 ref={headingRef} tabIndex={-1} id="first-agent-title">
            Make your first agent.
          </h1>
          <p className="first-agent-onboarding__lede">
            Choose a name, an icon, and a colour.
          </p>
        </div>

        <form className="first-agent-onboarding__form" onSubmit={submit}>
          <label className="first-agent-onboarding__field" htmlFor="first-agent-name">
            <span>Name</span>
            <input
              id="first-agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Chief of Staff"
              autoComplete="off"
              required
              maxLength={80}
              aria-required="true"
              aria-describedby="first-agent-name-hint"
            />
            <small id="first-agent-name-hint">
              You can change this later.
            </small>
          </label>

          <label className="first-agent-onboarding__field" htmlFor="first-agent-instructions">
            <span>What should they help with?</span>
            <textarea
              id="first-agent-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Keep my priorities clear and turn ideas into next steps."
              rows={2}
            />
            <small>Optional. A sentence is enough.</small>
          </label>

          <AgentAppearancePicker
            seed={avatarSeed}
            color={iconColor}
            onChange={({ avatarSeed: nextSeed, iconColor: nextColor }) => {
              setAvatarSeed(nextSeed);
              setIconColor(nextColor);
            }}
          />

          {error ? (
            <p className="first-agent-onboarding__feedback" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="first-agent-onboarding__submit"
            disabled={saving || !name.trim()}
          >
            {saving ? (
              <>
                <Spinner size={18} className="first-agent-onboarding__spinner" />
                Saving your agent
              </>
            ) : (
              <>
                <Check size={18} weight="bold" />
                Enter workspace
              </>
            )}
          </button>
        </form>
      </section>
    </main>
  );
}
