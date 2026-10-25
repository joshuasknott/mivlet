import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { getScenario, scenarioOrder } from "./demo-data.js";
import { AgentPortraits } from "./UseCaseNav.jsx";

const examples = scenarioOrder.map(getScenario);

export function AnimatedPromptComposer({ onSubmitPrompt, playbackEnabled }) {
  const formRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [selectedExample, setSelectedExample] = useState(false);
  const [selectionKey, setSelectionKey] = useState(0);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [typing, setTyping] = useState({ index: 0, length: 0, phase: "type" });
  const example = examples[typing.index];
  const showingExample = !focused && (selectedExample || !draft);
  const running = showingExample && visible && pageVisible && playbackEnabled;

  const chooseExample = (id) => {
    setTyping({
      index: examples.findIndex((item) => item.id === id),
      length: 0,
      phase: "type",
    });
    setSelectionKey((key) => key + 1);
    setSelectedExample(true);
    setFocused(false);
  };

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return () =>
        document.removeEventListener("visibilitychange", onVisibility);
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.25 },
    );
    observer.observe(formRef.current);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const { length, phase } = typing;
    // The composer introduces one selected example and then holds it. Agents
    // change only when a visitor selects a portrait, so the orange section
    // never silently moves to another agent while someone is reading it.
    if (phase === "hold") return;
    const delay =
      length === 0
        ? 120
        : /[,.;!?]/.test(example.prompt[length - 1])
          ? 100
          : 28;
    const timer = window.setTimeout(() => {
      setTyping((current) => {
        const nextLength = current.length + 1;
        return {
          ...current,
          length: nextLength,
          phase: nextLength === example.prompt.length ? "hold" : "type",
        };
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [running, typing, example]);

  return (
    <section className="prompt-band" aria-labelledby="prompt-title">
      <div>
        <h2 id="prompt-title">
          Start with <br />
          what you need.
        </h2>
        <AgentPortraits
          className="prompt-agents"
          activeAgent={showingExample ? example.agent : null}
          isTyping={running && typing.phase === "type"}
          onSelect={chooseExample}
          replayKey={selectionKey}
        />
      </div>
      <div className="prompt-interaction">
        <form
          ref={formRef}
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            // Animated text is only a suggestion; never submit a partial phrase.
            const prompt =
              showingExample || !draft ? example.prompt : draft.trim();
            if (prompt) onSubmitPrompt(prompt);
          }}
        >
          <label className="sr-only" htmlFor="demo-prompt">
            Your next idea
          </label>
          <p id="prompt-hint" className="sr-only">
            Write your own prompt, or explore this example: {example.prompt}
          </p>
          <div className={`prompt-input ${showingExample ? "is-example" : ""}`}>
            <textarea
              id="demo-prompt"
              rows="2"
              value={showingExample ? "" : draft}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => {
                setFocused(true);
                // Keep a custom draft available when returning from an example.
                setSelectedExample(false);
              }}
              onBlur={() => setFocused(false)}
              aria-describedby="prompt-hint"
              placeholder="What would you like to get done?"
              maxLength="400"
            />
            {showingExample && (
              <div className="prompt-typewriter" aria-hidden="true">
                <span>{example.prompt.slice(0, typing.length)}</span>
                <span
                  className={`prompt-caret ${running ? "is-running" : ""}`}
                />
              </div>
            )}
          </div>
          <div className="prompt-form-bottom">
            <Plus size={20} aria-hidden="true" />
            <span className="prompt-model">GPT-6.1 Sol High</span>
            <Microphone size={19} aria-hidden="true" />
            <button
              type="submit"
              aria-label="Explore this prompt"
              disabled={!showingExample && !!draft && !draft.trim()}
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
