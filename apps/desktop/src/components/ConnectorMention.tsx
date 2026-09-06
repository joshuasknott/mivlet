import { Fragment } from "react";
import { ConnectorIcon } from "./ConnectorIcon";

export type MentionConnector = { id: string; name: string };

export function mentionParts(
  text: string,
  connectors: readonly MentionConnector[],
) {
  const parts: { text: string; connector?: MentionConnector }[] = [];
  const pattern = /(^|\s)(@[a-z0-9]+(?:-[a-z0-9]+)*)(?=$|\s|[.,!?;:])/gi;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const connector = connectors.find(
      (item) => `@${item.id}` === match[2].toLowerCase(),
    );
    if (!connector) continue;
    const start = match.index + match[1].length;
    parts.push({ text: text.slice(end, start) }, { text: match[2], connector });
    end = start + match[2].length;
  }
  parts.push({ text: text.slice(end) });
  return parts;
}

export function ConnectorMention({
  connector,
}: {
  connector: MentionConnector;
}) {
  return (
    <span
      className="connector-mention"
      data-mention={`@${connector.id}`}
      contentEditable={false}
    >
      <span aria-hidden="true">
        <ConnectorIcon id={connector.id} />
      </span>
      {connector.name}
    </span>
  );
}

export function ConnectorMentionText({
  text,
  connectors,
}: {
  text: string;
  connectors: readonly MentionConnector[];
}) {
  return (
    <>
      {mentionParts(text, connectors).map((part, index) => (
        <Fragment key={index}>
          {part.connector ? (
            <ConnectorMention connector={part.connector} />
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </>
  );
}
