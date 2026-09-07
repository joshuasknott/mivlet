import { Fragment, createElement, memo, useState, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import { getRuntimeAdapter, hasNativeRuntimeAdapter } from "../../runtime/adapters/select";

type StandardToken = Tokens.Space | Tokens.Code | Tokens.Blockquote | Tokens.HTML | Tokens.Heading | Tokens.Hr | Tokens.List | Tokens.Paragraph | Tokens.Table | Tokens.Strong | Tokens.Em | Tokens.Codespan | Tokens.Br | Tokens.Del | Tokens.Link | Tokens.Image | Tokens.Text | Tokens.Escape | Tokens.Def;

function decodeEntities(text: string) {
  // Only isolated character references reach the decoder, never source HTML.
  return text.replace(/&(?:[a-zA-Z]{1,32}|#\d{1,8}|#x[\da-fA-F]{1,8});/g,
    (entity) => new DOMParser().parseFromString(entity, "text/html").body.textContent ?? entity);
}

function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((value, index) => {
    const token = value as StandardToken;
    let node: ReactNode = null;
    switch (token.type) {
      case "space": case "def": case "html": break;
      case "heading": node = createElement(`h${Math.min(6, Math.max(1, token.depth))}`, null, renderTokens(token.tokens)); break;
      case "paragraph": node = <p>{renderTokens(token.tokens)}</p>; break;
      case "text": node = token.tokens ? renderTokens(token.tokens) : decodeEntities(token.text); break;
      case "escape": node = token.text; break;
      case "strong": node = <strong>{renderTokens(token.tokens)}</strong>; break;
      case "em": node = <em>{renderTokens(token.tokens)}</em>; break;
      case "del": node = <del>{renderTokens(token.tokens)}</del>; break;
      case "codespan": node = <code>{token.text}</code>; break;
      case "code": node = <pre tabIndex={0}><code>{token.text}</code></pre>; break;
      case "br": node = <br />; break;
      case "hr": node = <hr />; break;
      case "blockquote": node = <blockquote>{renderTokens(token.tokens)}</blockquote>; break;
      case "link": node = /^(https?:\/\/|mailto:)/i.test(token.href)
        ? <ConversationLink href={decodeEntities(token.href)}>{renderTokens(token.tokens)}</ConversationLink>
        : <span>{renderTokens(token.tokens)}</span>; break;
      case "image": node = <span>{token.text || "Image"}</span>; break;
      case "list": {
        const items = token.items.map((item, i) => <li key={i}>{item.task ? <input type="checkbox" checked={Boolean(item.checked)} disabled aria-label={item.checked ? "Completed" : "Not completed"} /> : null}{renderTokens(item.tokens)}</li>);
        node = token.ordered ? <ol start={typeof token.start === "number" ? token.start : undefined}>{items}</ol> : <ul>{items}</ul>;
        break;
      }
      case "table": node = <div className="message-markdown__table" role="region" aria-label="Table" tabIndex={0}><table>
        <thead><tr>{token.header.map((cell, i) => <th key={i} style={{ textAlign: token.align[i] ?? undefined }}>{renderTokens(cell.tokens)}</th>)}</tr></thead>
        <tbody>{token.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} style={{ textAlign: token.align[j] ?? undefined }}>{renderTokens(cell.tokens)}</td>)}</tr>)}</tbody>
      </table></div>; break;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}

function ConversationLink({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState("");
  return <><a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
    if (!hasNativeRuntimeAdapter()) return;
    event.preventDefault(); setError("");
    void getRuntimeAdapter().invoke<void>("open_conversation_link", { url: href }).catch(() => setError("Could not open this link. Copy the link address to open it in your browser."));
  }}>{children}</a>{error ? <span className="turn-warning" role="alert"> {error}</span> : null}</>;
}

/** No HTML, embedded remote media, or arbitrary URI schemes from model text. */
export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return <div className="message-markdown">{renderTokens(Lexer.lex(content, { gfm: true }))}</div>;
});
