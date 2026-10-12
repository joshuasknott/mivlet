import { createContext, useContext, useEffect, useState } from "react";
import {
  createLibrary,
  defineComponent,
  reactive,
  useStateField,
} from "@openuidev/react-lang";
import { richWidgets } from "./rich-widgets";
import { z } from "zod/v4";
import { previewComputerArtifact } from "../../../lib/computer-artifacts";
import { mivletInterfaceLibrary } from "./catalogue";

export const RichOwner = createContext<{
  workspaceId: string;
  agentId: string;
  generation?: number;
}>({ workspaceId: "", agentId: "" });
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const label = z
  .string()
  .max(500)
  .refine(
    (value) =>
      !/(password|passphrase|api.?key|access.?token|secret|private.?key|credential|recovery.?code)/i.test(
        value,
      ),
    "Connect credentials in Settings.",
  );
const ScalarInput = defineComponent({
  name: "Input",
  description:
    "Labelled text or numeric input, bound to a $variable. Never request credentials.",
  props: z.object({
    name: key,
    label,
    value: reactive(
      z.union([z.string().max(2000), z.number().finite().min(-1e12).max(1e12)]),
    ),
    type: z.enum(["text", "number"]).default("text"),
  }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    if (
      !label.safeParse(props.label).success ||
      !label.safeParse(props.name).success
    )
      return (
        <p role="alert">
          Connect credentials in Settings. Generated forms cannot request
          secrets.
        </p>
      );
    return (
      <label className="generated-field">
        {props.label}
        <input
          type={props.type}
          value={String(field.value ?? "")}
          maxLength={2000}
          onChange={(event) =>
            field.setValue(
              props.type === "number"
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        />
      </label>
    );
  },
});
const Choice = defineComponent({
  name: "Choice",
  description:
    "Labelled dropdown; changing it updates a $variable immediately.",
  props: z.object({
    name: key,
    label,
    choices: z.array(z.string().max(500)).min(1).max(24),
    value: reactive(z.string().max(500)),
  }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    if (
      !label.safeParse(props.label).success ||
      !label.safeParse(props.name).success
    )
      return (
        <p role="alert">
          Connect credentials in Settings. Generated forms cannot request
          secrets.
        </p>
      );
    return (
      <label className="generated-field">
        {props.label}
        <select
          value={String(field.value ?? "")}
          onChange={(event) => field.setValue(event.target.value)}
        >
          {props.choices.map((choice) => (
            <option key={choice}>{choice}</option>
          ))}
        </select>
      </label>
    );
  },
});
const NumericSlider = defineComponent({
  name: "Slider",
  description:
    "Numeric slider with a scalar $variable; min must be less than max and step positive.",
  props: z.object({
    name: key,
    label,
    value: reactive(z.number().finite()),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().positive().default(1),
  }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    if (
      !label.safeParse(props.label).success ||
      !label.safeParse(props.name).success
    )
      return (
        <p role="alert">
          Connect credentials in Settings. Generated forms cannot request
          secrets.
        </p>
      );
    if (props.min >= props.max || props.step > props.max - props.min)
      return <p role="alert">This slider has an invalid range.</p>;
    const value = Math.max(
      props.min,
      Math.min(props.max, Number(field.value ?? props.min)),
    );
    return (
      <label className="generated-field">
        {props.label}: {value}
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={value}
          aria-label={props.label}
          onChange={(event) => field.setValue(Number(event.target.value))}
        />
      </label>
    );
  },
});
const Photo = defineComponent({
  name: "Photo",
  description:
    "A real published image, using its exact artifact id. No invented URLs or image data. If no image artifact is available, use text.",
  props: z.object({
    artifactId: z.string().regex(/^artifact-[a-f0-9]{64}$/),
    alt: z.string().min(1).max(500),
    caption: z.string().max(1000).optional(),
  }),
  component: function PublishedPhoto({ props }) {
    const owner = useContext(RichOwner);
    const [preview, setPreview] = useState<{ image?: string; error?: string }>(
      {},
    );
    useEffect(() => {
      let current = true;
      setPreview({});
      if (owner.generation === undefined) {
        setPreview({ error: "Open the agent computer to preview this image." });
        return;
      }
      void previewComputerArtifact({
        workspaceId: owner.workspaceId,
        agentId: owner.agentId,
        artifactId: props.artifactId,
        expectedGeneration: owner.generation,
      })
        .then((result) => {
          if (current)
            setPreview(
              result.imageDataUrl
                ? { image: result.imageDataUrl }
                : { error: "This published file is not an available image." },
            );
        })
        .catch(() => {
          if (current)
            setPreview({
              error:
                "This image is unavailable. Ask the agent to publish it again.",
            });
        });
      return () => {
        current = false;
      };
    }, [owner.workspaceId, owner.agentId, owner.generation, props.artifactId]);
    return (
      <figure className="generated-photo">
        {preview.image ? (
          <img src={preview.image} alt={props.alt} loading="lazy" />
        ) : (
          <p role="status">{preview.error ?? "Loading image…"}</p>
        )}
        {props.caption && <figcaption>{props.caption}</figcaption>}
      </figure>
    );
  },
});

// Reuse upstream rendering, layout, chart and tab implementations. The small
// input/media adapters preserve Mivlet's credential and native asset boundaries.
export const richInterfaceLibrary = createLibrary({
  root: "Stack",
  components: [
    ...Object.values(richWidgets.components),
    mivletInterfaceLibrary.components.Table,
    ScalarInput,
    NumericSlider,
    Choice,
    Photo,
  ],
});

export const richPromptOptions = {
  bindings: true,
  toolCalls: false,
  inlineMode: false,
  additionalRules: [
    "In Mivlet, put the interface in one fenced openui-v2 block. Text outside it remains normal Markdown. Prefer ordinary text when interaction adds no value.",
    "Use reactive inputs and arithmetic for instant local changes: calculators, quizzes, filters and planners. Use @ToAssistant only for a deliberate follow-up; Mivlet stages it for user review.",
    "No Query, Mutation, @Run, @OpenUrl, @Each, member access, credentials, URLs, HTML or executable JavaScript. Use only listed components, local state, arithmetic, comparisons, ternaries and approved math/data functions.",
    "Use Photo only with a real published image artifact id from tool output. Do not invent images, source references or tool results.",
    "Limits: 48000 characters, 128 statements, depth 12, 2048 nodes, 96 state fields. No recursion. Arrays/objects and references must remain bounded.",
  ],
};
