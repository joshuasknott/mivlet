import { createContext, useContext, useId, useState } from "react";
import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";

export interface InterfaceInteraction {
  state: Record<string, string | boolean>;
  disabled: boolean;
  change: (key: string, value: string | boolean) => void;
  review: (label: string) => void;
}
export const InterfaceContext = createContext<InterfaceInteraction>({
  state: {},
  disabled: true,
  change: () => {},
  review: () => {},
});
const short = z.string().max(500);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const safeFieldLabel = (value: string) =>
  !/(?:password|passphrase|api.?key|access.?token|secret|private.?key|credential|recovery.?code)/i.test(
    value,
  );
const Text = defineComponent({
  name: "Text",
  description: "Plain text",
  props: z.object({ text: z.string().max(8000) }),
  component: ({ props }) => <p>{props.text}</p>,
});
const comparisonProps = z.object({
  title: short,
  options: z
    .array(z.object({ label: short, detail: z.string().max(4000) }))
    .min(1)
    .max(24),
});
const Comparison = defineComponent({
  name: "Comparison",
  description: "Comparison",
  props: comparisonProps,
  component: ({ props }) => {
    if (!comparisonProps.safeParse(props).success) return <Invalid />;
    return (
      <section aria-label={props.title}>
        <h4>{props.title}</h4>
        <dl className="generated-comparison">
          {props.options.map((option, i) => (
            <div key={i} className="generated-comparison-card">
              <dt>{option.label}</dt>
              <dd>{option.detail}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  },
});
const optionsProps = z.object({
  name: key,
  title: short,
  options: z.array(short).min(1).max(24),
});
const Options = defineComponent({
  name: "Options",
  description: "Selectable options",
  props: optionsProps,
  component: ({ props }) => {
    const interaction = useContext(InterfaceContext);
    const id = useId();
    if (!optionsProps.safeParse(props).success) return <Invalid />;
    return (
      <fieldset disabled={interaction.disabled}>
        <legend>{props.title}</legend>
        <div className="generated-options">
          {props.options.map((option, i) => (
            <label key={i} data-selected={interaction.state[props.name] === option}>
              <input
                type="radio"
                name={id}
                checked={interaction.state[props.name] === option}
                onChange={() => interaction.change(props.name, option)}
              />
              {option}
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={
            !props.options.includes(String(interaction.state[props.name] ?? ""))
          }
          onClick={() => interaction.review(props.title)}
        >
          Review selection in composer
        </button>
      </fieldset>
    );
  },
});
const formProps = z.object({
  name: key,
  title: short,
  fields: z
    .array(z.object({ name: key, label: short, required: z.boolean() }))
    .min(1)
    .max(24),
  submitLabel: short,
});
const Form = defineComponent({
  name: "Form",
  description: "Validated clarification fields",
  props: formProps,
  component: ({ props }) => {
    const interaction = useContext(InterfaceContext);
    const id = useId();
    const [attempted, setAttempted] = useState(false);
    if (
      !formProps.safeParse(props).success ||
      new Set(props.fields.map((f) => f.name)).size !== props.fields.length
    )
      return <Invalid />;
    if (
      !safeFieldLabel(props.title) ||
      props.fields.some(
        (field) => !safeFieldLabel(field.name) || !safeFieldLabel(field.label),
      )
    )
      return (
        <p role="alert">
          Connect credentials in Settings. Generated forms cannot request
          secrets.
        </p>
      );
    const missing = props.fields.filter(
      (field) =>
        field.required &&
        !String(interaction.state[`${props.name}.${field.name}`] ?? "").trim(),
    );
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (!missing.length && !interaction.disabled)
            interaction.review(props.title);
        }}
      >
        <fieldset disabled={interaction.disabled}>
          <legend>{props.title}</legend>
          {props.fields.map((field, index) => (
            <label
              className="generated-field"
              key={field.name}
              htmlFor={`${id}-${index}`}
            >
              {field.label}
              {field.required ? " (required)" : ""}
              <input
                id={`${id}-${index}`}
                maxLength={2000}
                required={field.required}
                value={String(
                  interaction.state[`${props.name}.${field.name}`] ?? "",
                )}
                onChange={(event) =>
                  interaction.change(
                    `${props.name}.${field.name}`,
                    event.target.value,
                  )
                }
              />
            </label>
          ))}
          {attempted && missing.length ? (
            <p role="alert">Complete the required fields.</p>
          ) : null}
          <button type="submit">{props.submitLabel || "Review answers"}</button>
          <small>Review your answers in the composer before sending.</small>
        </fieldset>
      </form>
    );
  },
});
const tableProps = z.object({
  title: short,
  columns: z.array(short).min(1).max(12),
  rows: z.array(z.array(z.string().max(2000)).max(12)).max(100),
});
const Table = defineComponent({
  name: "Table",
  description: "Searchable, sortable data",
  props: tableProps,
  component: ({ props }) => {
    const [filter, setFilter] = useState("");
    const [sort, setSort] = useState<{ column: number; reverse: boolean }>();
    if (
      !tableProps.safeParse(props).success ||
      props.rows.some((row) => row.length !== props.columns.length)
    )
      return <Invalid />;
    const rows = props.rows.filter((row) =>
      row.join(" ").toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    );
    if (sort)
      rows.sort(
        (a, b) =>
          (a[sort.column] ?? "").localeCompare(
            b[sort.column] ?? "",
            undefined,
            { numeric: true },
          ) * (sort.reverse ? -1 : 1),
      );
    return (
      <section aria-label={props.title}>
        <h4>{props.title}</h4>
        <input
          type="search"
          aria-label={`Filter ${props.title}`}
          placeholder="Filter rows…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div
          className="generated-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={`${props.title} table`}
        >
          <table>
            <thead>
              <tr>
                {props.columns.map((column, index) => (
                  <th
                    key={index}
                    scope="col"
                    aria-sort={
                      sort?.column === index
                        ? sort.reverse
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setSort({
                          column: index,
                          reverse: sort?.column === index && !sort.reverse,
                        })
                      }
                    >
                      {column}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} className={cell.length > 40 ? "generated-cell-long" : undefined}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <small>
          {rows.length} of {props.rows.length} rows
        </small>
      </section>
    );
  },
});
const chartProps = z.object({
  title: short,
  labels: z.array(short).min(1).max(40),
  values: z.array(z.number().finite().min(-1e12).max(1e12)).min(1).max(40),
});
const Chart = defineComponent({
  name: "Chart",
  description: "Labelled bar chart",
  props: chartProps,
  component: ({ props }) => {
    if (
      !chartProps.safeParse(props).success ||
      props.labels.length !== props.values.length
    )
      return <Invalid />;
    const largest = Math.max(1, ...props.values.map(Math.abs));
    return (
      <figure className="generated-chart">
        <figcaption><ChartBar size={20} aria-hidden />{props.title}</figcaption>
        {props.labels.map((label, i) => (
          <div key={i}>
            <span>{label}</span>
            <span className="generated-chart-track" aria-hidden="true">
              <span className="generated-bar" style={{ width: `${(Math.abs(props.values[i]) / largest) * 100}%` }} />
            </span>
            <strong>{props.values[i].toLocaleString()}</strong>
          </div>
        ))}
      </figure>
    );
  },
});
const planProps = z.object({
  name: key,
  title: short,
  steps: z.array(z.string().max(2000)).min(1).max(40),
});
const Plan = defineComponent({
  name: "Plan",
  description:
    "User checklist; no automatic actions",
  props: planProps,
  component: ({ props }) => {
    const interaction = useContext(InterfaceContext);
    if (!planProps.safeParse(props).success) return <Invalid />;
    return (
      <fieldset disabled={interaction.disabled}>
        <legend>{props.title}</legend>
        <ol className="generated-plan">
          {props.steps.map((step, i) => (
            <li key={i}>
              <label>
                <input
                  type="checkbox"
                  checked={interaction.state[`${props.name}.${i}`] === true}
                  onChange={(event) =>
                    interaction.change(
                      `${props.name}.${i}`,
                      event.target.checked,
                    )
                  }
                />
                {step}
              </label>
            </li>
          ))}
        </ol>
        <small>Checked by you; no action runs automatically.</small>
      </fieldset>
    );
  },
});
const draftProps = z.object({ title: short, text: z.string().max(16000) });
const Draft = defineComponent({
  name: "Draft",
  description: "Draft with review action",
  props: draftProps,
  component: ({ props }) => {
    const interaction = useContext(InterfaceContext);
    if (!draftProps.safeParse(props).success) return <Invalid />;
    return (
      <section aria-label={props.title}>
        <h4><FileText size={20} aria-hidden />{props.title}</h4>
        <pre className="generated-draft">{props.text}</pre>
        <button
          type="button"
          disabled={interaction.disabled}
          onClick={() => interaction.review(`Refine draft: ${props.title}`)}
        >
          Request a revision
        </button>
      </section>
    );
  },
});
const Stack = defineComponent({
  name: "Stack",
  description: "Component group",
  props: z.object({
    children: z
      .array(
        z.union([
          Text.ref,
          Comparison.ref,
          Options.ref,
          Form.ref,
          Table.ref,
          Chart.ref,
          Plan.ref,
          Draft.ref,
        ]),
      )
      .max(24),
  }),
  component: ({ props, renderNode }) => (
    <div className="generated-stack">{renderNode(props.children)}</div>
  ),
});
function Invalid() {
  return (
    <p role="alert">
      This component contains invalid data. Ask the agent to correct it.
    </p>
  );
}
export const mivletInterfaceLibrary = createLibrary({
  root: "Stack",
  components: [
    Stack,
    Text,
    Comparison,
    Options,
    Form,
    Table,
    Chart,
    Plan,
    Draft,
  ],
});
