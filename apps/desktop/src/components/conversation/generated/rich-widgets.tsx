import {
  createLibrary,
  defineComponent,
  reactive,
  useStateField,
  useTriggerAction,
  action,
} from "@openuidev/react-lang";
import { Card as CardControl } from "@openuidev/react-ui/Card";
import {
  Tabs as TabsControl,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@openuidev/react-ui/Tabs";
import { BarChart as BarControl } from "@openuidev/react-ui/Charts/BarChart";
import { LineChart as LineControl } from "@openuidev/react-ui/Charts/LineChart";
import { z } from "zod/v4";
import { MessageMarkdown } from "../MessageMarkdown";

const children = z.array(z.unknown()).max(64);
const Stack = defineComponent({
  name: "Stack",
  description: "Responsive vertical or horizontal layout.",
  props: z.object({
    children,
    direction: z.enum(["row", "column"]).default("column"),
  }),
  component: ({ props, renderNode }) => (
    <div className={`rich-stack rich-stack--${props.direction}`}>
      {renderNode(props.children)}
    </div>
  ),
});
const Card = defineComponent({
  name: "Card",
  description: "Group related content in one quiet card.",
  props: z.object({ children }),
  component: ({ props, renderNode }) => (
    <CardControl width="full">{renderNode(props.children)}</CardControl>
  ),
});
const TextContent = defineComponent({
  name: "TextContent",
  description: "Markdown text, optionally emphasized.",
  props: z.object({
    text: z.string().max(16000),
    size: z
      .enum(["small", "default", "large", "small-heavy", "large-heavy"])
      .default("default"),
  }),
  component: ({ props }) => (
    <div className={`rich-text rich-text--${props.size}`}>
      <MessageMarkdown content={props.text} />
    </div>
  ),
});
const TabItem = defineComponent({
  name: "TabItem",
  description: "One tab: value, label and child components.",
  props: z.object({
    value: z.string().max(64),
    trigger: z.string().max(160),
    content: children,
  }),
  component: () => null,
});
const Tabs = defineComponent({
  name: "Tabs",
  description: "Keyboard accessible tabs with a persistent $variable.",
  props: z.object({
    name: z.string().max(64),
    items: z.array(TabItem.ref).min(1).max(12),
    value: reactive(z.string().max(64)),
  }),
  component: ({ props, renderNode }) => {
    const field = useStateField(props.name, props.value);
    return (
      <TabsControl value={String(field.value)} onValueChange={field.setValue}>
        <TabsList>
          {props.items.map((item) => (
            <TabsTrigger
              key={item.props.value}
              value={item.props.value}
              text={item.props.trigger}
            />
          ))}
        </TabsList>
        {props.items.map((item) => (
          <TabsContent key={item.props.value} value={item.props.value}>
            {renderNode(item.props.content)}
          </TabsContent>
        ))}
      </TabsControl>
    );
  },
});
// OpenUI tags schemas with component identity. Each chart needs its own schema
// instance, otherwise registering LineChart overwrites BarChart's catalogue id.
const chartProps = () =>
  z.object({
    title: z.string().max(500),
    labels: z.array(z.string().max(160)).min(1).max(100),
    values: z.array(z.number().finite().min(-1e12).max(1e12)).min(1).max(100),
  });
const ChartView = ({
  props,
  line = false,
}: {
  props: z.infer<ReturnType<typeof chartProps>>;
  line?: boolean;
}) => {
  if (props.labels.length !== props.values.length)
    return <p role="alert">The chart labels and values must match.</p>;
  const data = props.labels.map((label, i) => ({
    label,
    Value: props.values[i],
  }));
  return (
    <figure className="rich-chart" aria-label={props.title}>
      <figcaption>{props.title}</figcaption>
      {line ? (
        <LineControl
          data={data}
          categoryKey="label"
          height={240}
          condensed
          isAnimationActive={false}
        />
      ) : (
        <BarControl
          data={data}
          categoryKey="label"
          height={240}
          condensed
          isAnimationActive={false}
        />
      )}
      <details>
        <summary>Chart data</summary>
        <ul>
          {data.map((row, i) => (
            <li key={i}>
              {row.label}: {row.Value}
            </li>
          ))}
        </ul>
      </details>
    </figure>
  );
};
const BarChart = defineComponent({
  name: "BarChart",
  description: "Interactive bar chart with accessible data.",
  props: chartProps(),
  component: ({ props }) => <ChartView props={props} />,
});
const LineChart = defineComponent({
  name: "LineChart",
  description: "Interactive line chart with accessible data.",
  props: chartProps(),
  component: ({ props }) => <ChartView props={props} line />,
});
const Button = defineComponent({
  name: "Button",
  description:
    "Local @Set/@Reset or an explicit @ToAssistant follow-up. No tools.",
  props: z.object({ label: z.string().max(500), action: action().optional() }),
  component: ({ props }) => {
    const trigger = useTriggerAction();
    return (
      <button
        type="button"
        onClick={() => trigger(props.label, undefined, props.action)}
      >
        {props.label}
      </button>
    );
  },
});
export const richWidgets = createLibrary({
  root: "Stack",
  components: [
    Stack,
    Card,
    TextContent,
    TabItem,
    Tabs,
    BarChart,
    LineChart,
    Button,
  ],
});
