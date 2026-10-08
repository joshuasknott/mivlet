import { useEffect, useRef, useState } from "react";
import type {
  AutomationEventDraft,
  AutomationEventSource,
  EventTemplatePreview,
} from "@mivlet/protocol/domains/event-automations";
import type { SettingsRuntime } from "./settings-runtime";
import type { LocalSchedule } from "../../runtime/domains/local-schedules";
import {
  previewEventTemplate,
  saveEventTrigger,
} from "../../runtime/domains/event-automations";
import { resolveProviderModelOption } from "../../lib/provider-models";
import { permissionModeFor } from "../../lib/agent-run";
import { supportsSharedComputerTools } from "@mivlet/connectors/native-api/computer-vision";

export function EventAutomationEditor({
  runtime,
  workspaceId,
  schedule,
  initialAgentId,
  onClose,
  onSaved,
}: {
  runtime: SettingsRuntime;
  workspaceId: string;
  schedule: LocalSchedule | null;
  initialAgentId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const config =
    schedule?.trigger.kind === "event" ? schedule.trigger : undefined;
  const [id] = useState(schedule?.id ?? `event-${crypto.randomUUID()}`);
  const [agentId, setAgentId] = useState(
    schedule?.agentId ?? initialAgentId ?? "",
  );
  const [kind, setKind] = useState<AutomationEventSource["kind"]>(
    config?.source.kind ?? "signed-json",
  );
  const [sourceId, setSourceId] = useState(
    config?.source.kind === "signed-json" ? config.source.sourceId : "",
  );
  const [repository, setRepository] = useState(
    config && config.source.kind !== "signed-json"
      ? config.source.repository
      : "",
  );
  const [fields, setFields] = useState(config?.fields.join("\n") ?? "summary");
  const [prompt, setPrompt] = useState(
    schedule?.prompt ?? "Inspect this event: {{body.summary}}",
  );
  const [minutes, setMinutes] = useState(
    String((config?.maxAgeSeconds ?? 300) / 60),
  );
  const [expiry, setExpiry] = useState(
    new Date(config?.validUntil ?? Date.now() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 16),
  );
  const [keyId, setKeyId] = useState(config?.signingKeyId ?? "");
  const [rotate, setRotate] = useState(false);
  const [sample, setSample] = useState(
    '{"summary":"Example event — no secrets"}',
  );
  const [preview, setPreview] = useState<EventTemplatePreview>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const previewGeneration = useRef(0);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const actionControl = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pending) {
      if (document.activeElement === document.body)
        (error ? errorElement.current : actionControl.current)?.focus();
      actionControl.current = null;
    }
  }, [error, pending]);
  const agent = runtime.agents.find((candidate) => candidate.id === agentId);
  const route =
    schedule && agentId === schedule.agentId
      ? runtime.allModelOptions.find(
          (model) =>
            model.providerId === schedule.providerId &&
            model.modelId === schedule.model,
        )
      : agent
        ? resolveProviderModelOption(runtime.allModelOptions, agent.modelId)
        : undefined;
  const provider = runtime.backendProviders.find(
    (candidate) => candidate.id === route?.providerId,
  );
  const supported =
    !!agent &&
    !!route?.available &&
    route.capabilities?.tools !== false &&
    route.capabilities?.streaming !== false &&
    provider?.authState === "connected" &&
    supportsSharedComputerTools(provider);
  const event: AutomationEventDraft = {
    source: kind === "signed-json" ? { kind, sourceId } : { kind, repository },
    fields: fields
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    maxAgeSeconds: Number(minutes) * 60,
    validUntil: `${expiry}:00Z`,
  };
  const invalidate = () => {
    previewGeneration.current += 1;
    setPreview(undefined);
    setError("");
  };
  const act = async (operation: () => Promise<void>) => {
    actionControl.current = document.activeElement as HTMLElement;
    setPending(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The event trigger could not be saved.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="event-automations__editor local-schedules__editor"
      onSubmit={(submit) => {
        submit.preventDefault();
        if (
          !supported ||
          !route ||
          !agent ||
          !preview ||
          preview.missing.length > 0
        )
          return;
        void act(async () => {
          await saveEventTrigger({
            workspaceId,
            id,
            agentId,
            providerId: route.providerId,
            model: route.modelId,
            reasoningEffort: schedule?.reasoningEffort ?? agent.reasoningEffort,
            permissionMode:
              schedule?.permissionMode ??
              permissionModeFor(agent.permissionLabel),
            prompt,
            event,
            signingKeyId: keyId,
            expectedRevision: schedule?.revision,
            rotateEndpoint: rotate,
          });
          onSaved();
        });
      }}
    >
      <strong>{schedule ? "Edit event trigger" : "New event trigger"}</strong>
      <label>
        Agent
        <select
          className="input"
          required
          autoFocus
          value={agentId}
          onChange={(change) => {
            setAgentId(change.target.value);
            invalidate();
          }}
        >
          <option value="">Choose an agent</option>
          {runtime.agents.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      {agent ? (
        <small>
          {supported
            ? `${provider?.label} · ${route?.modelId} · ${schedule?.permissionMode ?? agent.permissionLabel}`
            : "Choose an agent with a connected provider and model that supports Mivlet tools."}
        </small>
      ) : null}
      <label>
        Event source
        <select
          className="input"
          value={kind}
          onChange={(change) => {
            setKind(change.target.value as AutomationEventSource["kind"]);
            invalidate();
          }}
        >
          <option value="signed-json">Signed JSON event</option>
          <option value="github-issues">GitHub issue events</option>
          <option value="github-workflow-run">
            GitHub workflow-run events
          </option>
        </select>
      </label>
      {kind === "signed-json" ? (
        <label>
          Source identity
          <input
            className="input"
            required
            maxLength={96}
            value={sourceId}
            placeholder="ci.example"
            onChange={(change) => {
              setSourceId(change.target.value);
              invalidate();
            }}
          />
        </label>
      ) : (
        <label>
          GitHub repository
          <input
            className="input"
            required
            maxLength={201}
            value={repository}
            placeholder="owner/repository"
            onChange={(change) => {
              setRepository(change.target.value);
              invalidate();
            }}
          />
        </label>
      )}
      <label>
        Selected JSON fields, one per line
        <textarea
          className="input"
          maxLength={2000}
          value={fields}
          onChange={(change) => {
            setFields(change.target.value);
            invalidate();
          }}
        />
      </label>
      <small>
        Select up to 12 scalar fields. Each field is limited to 2,048 bytes.
        Credentials and whole request bodies are excluded.
      </small>
      <label>
        Task template
        <textarea
          className="input"
          required
          maxLength={16000}
          value={prompt}
          onChange={(change) => {
            setPrompt(change.target.value);
            invalidate();
          }}
        />
      </label>
      <small>
        Use selected fields as {"{{body.summary}}"}. Substitutions are quoted,
        untrusted evidence. They never grant permission.
      </small>
      <div className="event-automations__pair">
        <label>
          Ignore events older than (minutes)
          <input
            className="input"
            type="number"
            required
            min={1}
            max={1440}
            step={1}
            value={minutes}
            onChange={(change) => {
              setMinutes(change.target.value);
              invalidate();
            }}
          />
        </label>
        <label>
          Trigger expires (UTC)
          <input
            className="input"
            type="datetime-local"
            required
            value={expiry}
            onChange={(change) => {
              setExpiry(change.target.value);
              invalidate();
            }}
          />
        </label>
      </div>
      <details>
        <summary>Protected signing-key setup</summary>
        <p>
          Ask the selected agent to request a protected signing secret and
          install it for the trigger target below. Native protected entry keeps
          the value out of chat. Use the returned key reference here.
        </p>
        <label>
          Exact trigger target
          <input
            className="input"
            readOnly
            value={id}
            onFocus={(focus) => focus.currentTarget.select()}
          />
        </label>
        <small>
          Consumer: webhook-signing-key · Purpose: verify-webhook-signature
        </small>
      </details>
      <label>
        Protected signing-key reference
        <input
          className="input"
          required
          value={keyId}
          placeholder="webhook-key:…"
          maxLength={160}
          onChange={(change) => setKeyId(change.target.value)}
        />
      </label>
      {schedule ? (
        <label className="event-automations__check">
          <input
            type="checkbox"
            checked={rotate}
            onChange={(change) => setRotate(change.target.checked)}
          />
          Rotate endpoint when saving
        </label>
      ) : (
        <small>
          New triggers are saved paused. Enable them after configuring their
          source.
        </small>
      )}
      <details>
        <summary>Preview the produced request</summary>
        <label>
          Example JSON payload
          <textarea
            className="input"
            maxLength={256 * 1024}
            value={sample}
            onChange={(change) => {
              setSample(change.target.value);
              invalidate();
            }}
          />
        </label>
        <small>
          Use synthetic data without credentials. Preview does not receive an
          event or start Work.
        </small>
        <button
          type="button"
          className="button button--secondary"
          disabled={pending}
          onClick={() => {
            const generation = previewGeneration.current;
            void act(async () => {
              const result = await previewEventTemplate({
                event,
                prompt,
                sampleJson: sample,
              });
              if (generation === previewGeneration.current) setPreview(result);
            });
          }}
        >
          Preview event task
        </button>
        {preview ? (
          <>
            <pre>{preview.prompt}</pre>
            {preview.missing.length > 0 ? (
              <p role="alert">
                Missing selected fields: {preview.missing.join(", ")}
              </p>
            ) : (
              <p role="status">
                Selected fields validated. Preview starts no work.
              </p>
            )}
          </>
        ) : null}
      </details>
      {error ? (
        <p role="alert" tabIndex={-1} ref={errorElement}>
          {error}
        </p>
      ) : null}
      <div className="profile-action-row">
        <button
          type="submit"
          className="button button--primary"
          disabled={
            pending ||
            !supported ||
            !preview ||
            preview.missing.length > 0 ||
            !keyId.startsWith("webhook-key:")
          }
        >
          {pending ? "Working…" : "Save event trigger"}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={pending}
          onClick={onClose}
        >
          Close event editor
        </button>
      </div>
    </form>
  );
}
