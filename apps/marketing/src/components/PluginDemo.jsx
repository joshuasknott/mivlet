import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { AgentAvatar } from "./AgentAvatar.jsx";
import "./plugin-demo.css";

const EXAMPLE_PROMPT =
  "Read our launch plan in Notion and check Linear for blockers.";
const SCENE_LENGTH = 11000;
const TYPE_LENGTH = 2000;
const SOURCE_START = 1700;
const RESULT_START = 3600;

const sourceCards = [
  {
    name: "Launch plan",
    provider: "Notion",
    icon: "/plugins/notion.svg",
    alt: "Notion",
  },
  {
    name: "2 open issues",
    provider: "Linear",
    icon: "/plugins/linear.svg",
    alt: "Linear",
  },
];

function phaseFor(elapsed) {
  if (elapsed >= RESULT_START) return "result";
  if (elapsed >= SOURCE_START) return "sources";
  return "typing";
}

function promptFor(elapsed) {
  if (elapsed >= TYPE_LENGTH) return EXAMPLE_PROMPT;
  const count = Math.floor((elapsed / TYPE_LENGTH) * EXAMPLE_PROMPT.length);
  return EXAMPLE_PROMPT.slice(0, count);
}

function SourceCard({ source, visible }) {
  return (
    <div className={`plugin-source-card${visible ? " is-visible" : ""}`}>
      <img src={source.icon} alt="" aria-hidden="true" />
      <div className="plugin-source-card__copy">
        <strong>{source.name}</strong>
        <span>{source.provider}</span>
        <span className="plugin-source-card__line" aria-hidden="true" />
        <span
          className="plugin-source-card__line plugin-source-card__line--short"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

function BriefingCard({ visible, onReadBriefing, onResultFocusChange }) {
  return (
    <article
      className={`plugin-briefing-card${visible ? " is-visible" : ""}`}
      aria-hidden={!visible}
    >
      <header className="plugin-briefing-card__header">
        <div>
          <h3>Launch briefing</h3>
          <p className="plugin-briefing-card__prepared">
            <AgentAvatar name="Nova" size={25} />
            Prepared by Nova
          </p>
        </div>
      </header>
      <div className="plugin-briefing-card__rows">
        <div className="plugin-briefing-row">
          <CheckCircle weight="fill" aria-hidden="true" />
          <strong>Ready</strong>
          <span>Design and launch copy approved.</span>
        </div>
        <div className="plugin-briefing-row">
          <WarningCircle weight="fill" aria-hidden="true" />
          <strong>Needs attention</strong>
          <span>Two onboarding issues to resolve.</span>
        </div>
        <div className="plugin-briefing-row">
          <ArrowRight aria-hidden="true" />
          <strong>Next up</strong>
          <span>Confirm owners and the release checklist.</span>
        </div>
      </div>
      <footer className="plugin-briefing-card__footer">
        <div className="plugin-briefing-card__sources" aria-label="Sources">
          <span>
            <img src="/plugins/notion.svg" alt="" aria-hidden="true" /> Notion
          </span>
          <span>
            <img src="/plugins/linear.svg" alt="" aria-hidden="true" /> Linear
          </span>
        </div>
        <button
          type="button"
          tabIndex={visible ? 0 : -1}
          disabled={!visible}
          onFocus={() => onResultFocusChange?.(true)}
          onBlur={() => onResultFocusChange?.(false)}
          onClick={onReadBriefing}
        >
          <span>Read the briefing</span>
          <ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
}

export function PluginDemo({ playbackEnabled = true, onReadBriefing }) {
  const [elapsed, setElapsed] = useState(0);
  const [isInView, setIsInView] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [resultHasFocus, setResultHasFocus] = useState(false);
  const rootRef = useRef(null);
  const elapsedRef = useRef(0);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setIsInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) =>
        setIsInView(entry.isIntersecting || entry.intersectionRatio > 0),
      { threshold: 0.01 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () =>
      setIsDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    let frame;
    let last = performance.now();
    let lastSignature = `${phaseFor(elapsedRef.current)}:${promptFor(elapsedRef.current)}`;

    if (!playbackEnabled || !isInView || !isDocumentVisible || resultHasFocus)
      return undefined;

    const tick = (now) => {
      const value = (elapsedRef.current + now - last) % SCENE_LENGTH;
      last = now;
      elapsedRef.current = value;
      const signature = `${phaseFor(value)}:${promptFor(value)}`;
      // The result holds for reading: don't rerender the whole scene every frame.
      if (signature !== lastSignature) {
        lastSignature = signature;
        setElapsed(value);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playbackEnabled, isInView, isDocumentVisible, resultHasFocus]);

  const phase = phaseFor(elapsed);
  const prompt = promptFor(elapsed);
  const sourceVisible = elapsed >= SOURCE_START;
  const resultVisible = phase === "result";

  return (
    <section
      ref={rootRef}
      id="plugin-example"
      className="plugin-demo"
      aria-labelledby="plugin-demo-title"
      data-phase={phase}
      data-playing={
        playbackEnabled && isInView && isDocumentVisible && !resultHasFocus
      }
    >
      <div className="plugin-demo__copy">
        <h2 id="plugin-demo-title">
          Ask once. <br />
          Bring the context together.
        </h2>
        <p>
          Ask Nova to read your project plan and check your issues. Get a
          briefing you can work from.
        </p>
        <p className="plugin-demo__sr-prompt sr-only">
          Example prompt: {EXAMPLE_PROMPT}
        </p>
        <div className="plugin-composer" aria-label="Example Mivlet prompt">
          <div className="plugin-composer__agent">
            <AgentAvatar name="Nova" size={34} />
            <span>
              <strong>Nova</strong>
              <small>Research &amp; planning</small>
            </span>
          </div>
          <div className="plugin-composer__prompt" aria-hidden="true">
            {prompt || "\u00a0"}
            <span className="plugin-composer__caret" />
          </div>
          <div className="plugin-composer__toolbar">
            <span className="plugin-plugin-badge">
              <img src="/plugins/notion.svg" alt="" aria-hidden="true" />
              Notion
              <span className="plugin-plugin-badge__remove" aria-hidden="true">
                <X size={11} weight="bold" />
              </span>
            </span>
            <span className="plugin-plugin-badge">
              <img src="/plugins/linear.svg" alt="" aria-hidden="true" />
              Linear
              <span className="plugin-plugin-badge__remove" aria-hidden="true">
                <X size={11} weight="bold" />
              </span>
            </span>
            <span className="plugin-composer__model">
              GPT-6.1 Sol High <CaretDown size={13} />
            </span>
            <Microphone size={19} aria-hidden="true" />
            <span className="plugin-composer__send" aria-hidden="true">
              <ArrowUp size={20} />
            </span>
          </div>
        </div>
      </div>
      <div className="plugin-demo__visual">
        <div className="plugin-source-grid">
          {sourceCards.map((source) => (
            <SourceCard
              key={source.provider}
              source={source}
              visible={sourceVisible}
            />
          ))}
        </div>
        <BriefingCard
          visible={resultVisible}
          onReadBriefing={onReadBriefing}
          onResultFocusChange={setResultHasFocus}
        />
      </div>
    </section>
  );
}

export function PluginBriefing() {
  return (
    <article className="plugin-briefing-document">
      <header className="plugin-briefing-document__header">
        <div>
          <p>Prepared from your Notion launch plan and Linear workspace.</p>
        </div>
        <AgentAvatar name="Nova" size={48} />
      </header>
      <div className="plugin-briefing-document__body">
        <p>
          The launch plan is in good shape. Design and launch copy are approved;
          two onboarding issues need owners before the release checklist is
          finalised.
        </p>
        <div className="plugin-document-item plugin-document-item--ready">
          <CheckCircle weight="fill" aria-hidden="true" />
          <div>
            <strong>Ready</strong>
            <span>Design and launch copy approved.</span>
          </div>
        </div>
        <div className="plugin-document-item plugin-document-item--attention">
          <WarningCircle weight="fill" aria-hidden="true" />
          <div>
            <strong>Needs attention</strong>
            <span>Two onboarding issues to resolve.</span>
          </div>
        </div>
        <div className="plugin-document-item">
          <ArrowRight aria-hidden="true" />
          <div>
            <strong>Next up</strong>
            <span>Confirm owners and the release checklist.</span>
          </div>
        </div>
      </div>
      <footer className="plugin-briefing-document__footer">
        <span>
          <img src="/plugins/notion.svg" alt="" aria-hidden="true" /> Notion
        </span>
        <span>
          <img src="/plugins/linear.svg" alt="" aria-hidden="true" /> Linear
        </span>
      </footer>
    </article>
  );
}
