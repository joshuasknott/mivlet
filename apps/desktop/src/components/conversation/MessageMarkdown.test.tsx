import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_MARKDOWN_CHARS,
  TRUNCATION_MARKER,
} from "../../lib/safe-output";
import { MessageMarkdown } from "./MessageMarkdown";

/**
 * Conversation Markdown regressions. Model, connector, and tool text is
 * untrusted: it must render useful prose without ever executing markup,
 * loading remote media, opening a non-web scheme, or letting a model-supplied
 * path reach a local file. Encoded links must be judged by their decoded
 * target, matching the native opener boundary.
 */
describe("MessageMarkdown link safety", () => {
  it("drops a scheme hidden behind a character reference", () => {
    const view = render(<MessageMarkdown content={'[click](jav&#x61;script:alert(1))'} />);
    expect(screen.queryByRole("link", { name: "click" })).toBeNull();
    expect(view.container).toHaveTextContent("click");
  });

  it("rejects an authority encoded to point at a different host", () => {
    const view = render(<MessageMarkdown content={'[verify](https://trusted.example&#x40;evil.example)'} />);
    expect(screen.queryByRole("link", { name: "verify" })).toBeNull();
    expect(view.container).toHaveTextContent("verify");
  });

  it("rejects embedded credentials", () => {
    render(<MessageMarkdown content={"[login](https://user:pass@example.com)"} />);
    expect(screen.queryByRole("link", { name: "login" })).toBeNull();
  });

  it("rejects a model-supplied filesystem path", () => {
    render(<MessageMarkdown content={"[open](C:\\Users\\me\\.ssh\\id_rsa)"} />);
    expect(screen.queryByRole("link", { name: "open" })).toBeNull();
  });

  it("keeps ordinary web and email links safe to open", () => {
    render(<MessageMarkdown content={"[Safe](https://example.com/report) [Mail](mailto:person@example.com)"} />);
    expect(screen.getByRole("link", { name: "Safe" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Mail" })).toHaveAttribute("href", "mailto:person@example.com");
  });

  it("reveals a destination that a misleading label hides", () => {
    render(<MessageMarkdown content={"[https://trusted.example](https://evil.example/phish)"} />);
    const link = screen.getByRole("link", { name: "https://trusted.example" });
    expect(link).toHaveAttribute("href", "https://evil.example/phish");
    expect(link).toHaveAttribute("title", "https://evil.example/phish");
  });
});

describe("MessageMarkdown bounds", () => {
  it("decodes many encoded references without stalling", () => {
    const view = render(<MessageMarkdown content={"&amp;".repeat(5_000)} />);
    expect(view.container.textContent).toHaveLength(5_000);
  });

  it("does not overflow on deeply nested blockquotes", () => {
    const view = render(<MessageMarkdown content={"> ".repeat(2_000) + "deep"} />);
    expect(view.container).toHaveTextContent("deep");
  });

  it("falls back to literal text when the lexer cannot bound nesting", () => {
    const content = "> ".repeat(6_000) + "deep";
    const view = render(<MessageMarkdown content={content} />);
    expect(view.container).toHaveTextContent("deep");
  });

  it("truncates oversized content and marks it", () => {
    const view = render(<MessageMarkdown content={"a".repeat(MAX_CONVERSATION_MARKDOWN_CHARS + 1_000)} />);
    const text = view.container.textContent ?? "";
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_CONVERSATION_MARKDOWN_CHARS + TRUNCATION_MARKER.length + 4);
  });
});

describe("MessageMarkdown preserves normal content", () => {
  it("keeps prose, lists, tables, code, and citation links", () => {
    const content = [
      "See [the report][1] and [example](https://example.com).",
      "",
      "- **First**",
      "- Second",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| A | 1 |",
      "",
      "```js",
      "const answer = 42;",
      "```",
      "",
      "[1]: https://example.org/report",
    ].join("\n");
    const view = render(<MessageMarkdown content={content} />);
    expect(screen.getByRole("link", { name: "the report" })).toHaveAttribute("href", "https://example.org/report");
    expect(screen.getByRole("table")).toBeVisible();
    expect(view.container.querySelector("pre code")).toHaveTextContent("const answer = 42;");
    expect(screen.getByText("First")).toBeVisible();
  });

  it("renders a partially streamed link without throwing", () => {
    const view = render(<MessageMarkdown content={"Streaming [link](https://example.com/partial"} />);
    expect(view.container).toHaveTextContent("Streaming");
  });

  it("renders a partially streamed code fence without throwing", () => {
    const view = render(<MessageMarkdown content={"```js\nconst x = 1"} />);
    expect(view.container.querySelector("pre code")).toHaveTextContent("const x = 1");
  });
});
