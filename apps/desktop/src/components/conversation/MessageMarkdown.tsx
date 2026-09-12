import { Fragment, createElement, memo, useState, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import {
  MAX_CONVERSATION_MARKDOWN_CHARS,
  TRUNCATION_MARKER,
  decodeHtmlEntities,
  safeConversationLink,
} from "../../lib/safe-output";
import { getRuntimeAdapter, hasNativeRuntimeAdapter } from "../../runtime/adapters/select";
import { CopyButton } from "../CopyButton";

type StandardToken = Tokens.Space | Tokens.Code | Tokens.Blockquote | Tokens.HTML | Tokens.Heading | Tokens.Hr | Tokens.List | Tokens.Paragraph | Tokens.Table | Tokens.Strong | Tokens.Em | Tokens.Codespan | Tokens.Br | Tokens.Del | Tokens.Link | Tokens.Image | Tokens.Text | Tokens.Escape | Tokens.Def;

/** Bound renderer recursion so deeply nested untrusted blocks cannot overflow the stack. */
const MAX_RENDER_DEPTH = 64;

function renderTokens(tokens: Token[], depth = 0): ReactNode {
  if (depth > MAX_RENDER_DEPTH) {
    return tokens.map((token, index) => <Fragment key={index}>{token.raw}</Fragment>);
  }
  return tokens.map((value, index) => {
    const token = value as StandardToken;
    let node: ReactNode = null;
    switch (token.type) {
      case "space": case "def": case "html": break;
      case "heading": node = createElement(`h${Math.min(6, Math.max(1, token.depth))}`, null, renderTokens(token.tokens, depth + 1)); break;
      case "paragraph": node = <p>{renderTokens(token.tokens, depth + 1)}</p>; break;
      case "text": node = token.tokens ? renderTokens(token.tokens, depth + 1) : decodeHtmlEntities(token.text); break;
      case "escape": node = token.text; break;
      case "strong": node = <strong>{renderTokens(token.tokens, depth + 1)}</strong>; break;
      case "em": node = <em>{renderTokens(token.tokens, depth + 1)}</em>; break;
      case "del": node = <del>{renderTokens(token.tokens, depth + 1)}</del>; break;
      case "codespan": node = <code>{token.text}</code>; break;
      case "code": node = <div className="message-code"><header><span>{token.lang?.split(/\s/)[0]?.slice(0, 32) || "Text"}</span><CopyButton text={token.text} label="Copy code" /></header><pre tabIndex={0}><code>{token.text}</code></pre></div>; break;
      case "br": node = <br />; break;
      case "hr": node = <hr />; break;
      case "blockquote": node = <blockquote>{renderTokens(token.tokens, depth + 1)}</blockquote>; break;
      case "link": {
        const target = safeConversationLink(token.href);
        const children = renderTokens(token.tokens, depth + 1);
        node = target
          ? <ConversationLink href={target}>{children}</ConversationLink>
          : <span>{children}</span>;
        break;
      }
      case "image": node = <span>{token.text || "Image"}</span>; break;
      case "list": {
        const items = token.items.map((item, i) => <li key={i}>{item.task ? <input type="checkbox" checked={Boolean(item.checked)} disabled aria-label={item.checked ? "Completed" : "Not completed"} /> : null}{renderTokens(item.tokens, depth + 1)}</li>);
        node = token.ordered ? <ol start={typeof token.start === "number" ? token.start : undefined}>{items}</ol> : <ul>{items}</ul>;
        break;
      }
      case "table": node = <div className="message-markdown__table" role="region" aria-label="Table" tabIndex={0}><table>
        <thead><tr>{token.header.map((cell, i) => <th key={i} style={{ textAlign: token.align[i] ?? undefined }}>{renderTokens(cell.tokens, depth + 1)}</th>)}</tr></thead>
        <tbody>{token.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} style={{ textAlign: token.align[j] ?? undefined }}>{renderTokens(cell.tokens, depth + 1)}</td>)}</tr>)}</tbody>
      </table></div>; break;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}

function ConversationLink({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState("");
  return <><a href={href} title={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
    if (!hasNativeRuntimeAdapter()) return;
    event.preventDefault(); setError("");
    void getRuntimeAdapter().invoke<void>("open_conversation_link", { url: href }).catch(() => setError("Could not open this link. Copy the link address to open it in your browser."));
  }}>{children}</a>{error ? <span className="turn-warning" role="alert"> {error}</span> : null}</>;
}

/** No HTML, embedded remote media, or arbitrary URI schemes from model text. */
export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  const bounded = content.length > MAX_CONVERSATION_MARKDOWN_CHARS
    ? `${content.slice(0, MAX_CONVERSATION_MARKDOWN_CHARS)}\n\n${TRUNCATION_MARKER}`
    : content;
  let rendered: ReactNode;
  try {
    rendered = renderTokens(Lexer.lex(bounded, { gfm: true }));
  } catch {
    // Pathologically nested Markdown can exhaust the lexer's stack; fall back
    // to literal text rather than crashing the conversation.
    rendered = <pre tabIndex={0}>{bounded}</pre>;
  }
  return <div className="message-markdown">{rendered}</div>;
});
