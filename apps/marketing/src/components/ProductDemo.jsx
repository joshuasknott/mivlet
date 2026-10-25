import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Player } from "@remotion/player";
import { useCurrentFrame } from "remotion";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { ChatsCircle } from "@phosphor-icons/react/dist/csr/ChatsCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { getScenario } from "./demo-data";
import { agentCast } from "./agent-cast.js";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { PluginsIcon } from "./PluginsIcon.jsx";
import "./demo.css";

const FPS = 30;
const DURATION = 10 * FPS;
const CROSSFADE_FRAMES = 10;

const agentDetails = Object.fromEntries(
  agentCast.map(({ name, role, color }) => [name, { role, color }]),
);

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function ease(value) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function range(frame, start, end) {
  return ease((frame - start) / (end - start));
}

function Avatar({ name, size = "md" }) {
  const agent = agentDetails[name] ?? agentDetails.Nova;
  const pixelSize = size === "sm" ? 27 : 34;
  return (
    <span
      className={`demo-avatar demo-avatar--${size}`}
      style={{ "--avatar-color": agent.color }}
      aria-hidden="true"
    >
      <AgentAvatar name={name} size={pixelSize} className="demo-avatar__art" />
    </span>
  );
}

function Wordmark({ compact = false }) {
  return (
    <div
      className={`demo-wordmark${compact ? " demo-wordmark--compact" : ""}`}
      aria-label="mivlet"
    >
      <img src="/brand/mivlet-lockup-light.png" alt="mivlet" />
    </div>
  );
}

function FileCard({ scenario, visible = 1, compact = false }) {
  return (
    <div
      className={`demo-file-card${compact ? " demo-file-card--compact" : ""}`}
      style={{
        opacity: visible,
        translate: `0 ${Math.round((1 - visible) * 9)}px`,
      }}
    >
      <FileText
        className="demo-file-card__icon"
        size={22}
        weight="regular"
        aria-hidden="true"
      />
      <span className="demo-file-card__copy">
        <strong>{scenario.file}</strong>
        <small>{scenario.fileMeta}</small>
      </span>
    </div>
  );
}

function ThinkingDots({ opacity = 1 }) {
  return (
    <div
      className="demo-thinking"
      style={{ opacity }}
      aria-label="Agent is thinking"
    >
      <span />
      <span />
      <span />
    </div>
  );
}

function Activity({ scenario, frame }) {
  const complete = frame >= 130;
  const progress = complete ? 1 : clamp((frame - 60) / 70);
  return (
    <aside className="demo-activity" aria-label="Activity">
      <div className="demo-activity__body">
        <div className="demo-activity__topline">
          <h3>Activity</h3>
        </div>
        <div className="demo-activity__selector">
          <span>This chat</span>
          <CaretDown size={13} weight="bold" />
        </div>
        <div className="demo-activity__online">
          <span /> Up to date
        </div>
        <div className="demo-activity__rule" />
        <p className="demo-activity__eyebrow">LATEST WORK</p>
        <div className="demo-activity__latest">
          <span className="demo-activity__check">
            <Check size={15} weight="bold" />
          </span>
          <div>
            <strong>{complete ? "Ready to review" : "Working on it"}</strong>
            <small>{scenario.file}</small>
          </div>
          <ArrowRight size={15} />
        </div>
        <div className="demo-activity__timeline">
          {scenario.activity.map((item, index) => {
            const itemProgress = clamp(
              progress * scenario.activity.length - index,
            );
            return (
              <div className="demo-activity__event" key={item}>
                <span
                  className={`demo-activity__dot${itemProgress > 0.9 ? " is-complete" : ""}`}
                >
                  {itemProgress > 0.9 ? (
                    <Check size={11} weight="bold" />
                  ) : index === 0 ? (
                    <Clock size={11} />
                  ) : (
                    <span />
                  )}
                </span>
                <div>
                  <strong>{item}</strong>
                  <small>
                    {itemProgress > 0.9 ? "Just now" : "In progress"}
                  </small>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <nav className="demo-right-rail" aria-label="Workspace tools">
        <div
          className="demo-right-rail__sections"
          role="tablist"
          aria-label="Workspace sections"
          aria-orientation="vertical"
        >
          <button
            type="button"
            className="is-active"
            role="tab"
            aria-selected="true"
          >
            <span className="demo-right-rail__icon">
              <Clock size={22} />
            </span>
            <span>Activity</span>
          </button>
          <button type="button" role="tab" aria-selected="false">
            <span className="demo-right-rail__icon">
              <FileText size={22} />
            </span>
            <span>Files</span>
          </button>
          <button type="button" role="tab" aria-selected="false">
            <span className="demo-right-rail__icon">
              <BookOpen size={22} />
            </span>
            <span>Memory</span>
          </button>
          <button type="button" role="tab" aria-selected="false">
            <span className="demo-right-rail__icon">
              <ChatsCircle size={22} />
            </span>
            <span>Side Chat</span>
          </button>
          <button type="button" role="tab" aria-selected="false">
            <span className="demo-right-rail__icon">
              <CalendarBlank size={22} />
            </span>
            <span>Schedules</span>
          </button>
        </div>
      </nav>
    </aside>
  );
}

const Sidebar = memo(function Sidebar({ scenario }) {
  return (
    <aside className="demo-sidebar" aria-label="Mivlet workspace navigation">
      <Wordmark compact />
      <div className="demo-search">
        <MagnifyingGlass size={17} />
        <span>Search workspace</span>
        <kbd>Ctrl K</kbd>
      </div>
      <button className="demo-new-chat">
        <Plus size={19} weight="bold" /> New conversation
      </button>
      <div className="demo-sidebar__label">
        Projects <CaretDown size={13} weight="bold" />
      </div>
      <div className="demo-project">
        <FolderSimple size={21} weight="duotone" />
        <span>
          <strong>Mivlet launch</strong>
          <small>Workspace project</small>
        </span>
      </div>
      <div className="demo-sidebar__label">
        Agents <CaretDown size={13} weight="bold" />
      </div>
      <div className="demo-agents">
        {Object.keys(agentDetails).map((name) => {
          const active = name === scenario.agent;
          return (
            <div
              className={`demo-agent${active ? " is-active" : ""}`}
              key={name}
            >
              <Avatar name={name} size="sm" />
              <span>
                <strong>{name}</strong>
                <small>{agentDetails[name].role}</small>
              </span>
            </div>
          );
        })}
      </div>
      <button className="demo-plugins" type="button">
        <span className="demo-plugins__icon">
          <PluginsIcon size={21} />
        </span>
        <span>Plugins</span>
        <span className="demo-plugins__icons" aria-label="Connected plugins">
          <span>
            <img src="/plugins/notion.svg" alt="" />
          </span>
          <span>
            <img src="/plugins/linear.svg" alt="" />
          </span>
          <span>
            <img src="/plugins/github.svg" alt="" />
          </span>
        </span>
      </button>
      <div className="demo-sidebar__account">
        <span className="demo-account-avatar">A</span>
        <span>Alex</span>
        <CaretDown size={13} />
      </div>
    </aside>
  );
});

function Conversation({ scenario, frame }) {
  const responseProgress = range(frame, 70, 130);
  const responseChars = Math.max(
    0,
    Math.floor(responseProgress * scenario.response.length),
  );
  const response =
    frame >= 130
      ? scenario.response
      : scenario.response.slice(0, responseChars);
  const sent = frame >= 24;
  const thinking = frame >= 38 && frame < 76;
  const resultProgress = range(frame, 115, 155);
  const agent = agentDetails[scenario.agent];

  return (
    <section
      className="demo-conversation"
      aria-label={`${scenario.agent} conversation`}
    >
      <div className="demo-conversation__header">
        <Avatar name={scenario.agent} />
        <div>
          <strong>{scenario.agent}</strong>
          <small>{scenario.agentRole}</small>
        </div>
      </div>
      <div className="demo-conversation__body">
        <div className="demo-welcome">
          <div
            className="demo-welcome__line"
            style={{ scale: `${0.95 + range(frame, 0, 30) * 0.05}` }}
          >
            Hey Alex. How can I help today?
          </div>
        </div>
        {sent && (
          <div
            className="demo-message demo-message--user"
            style={{
              opacity: clamp((frame - 24) / 12),
              translate: `0 ${Math.round((1 - clamp((frame - 24) / 12)) * 8)}px`,
            }}
          >
            {scenario.prompt}
          </div>
        )}
        {thinking && (
          <ThinkingDots
            opacity={clamp((frame - 38) / 8) * clamp((76 - frame) / 8)}
          />
        )}
        {frame >= 65 && (
          <div
            className="demo-message demo-message--agent"
            style={{
              opacity: clamp((frame - 65) / 12),
              translate: `0 ${Math.round((1 - clamp((frame - 65) / 12)) * 8)}px`,
            }}
          >
            <div className="demo-message__agent-head">
              <Avatar name={scenario.agent} size="sm" />
              <strong>{scenario.agent}</strong>
              <span>Just now</span>
            </div>
            <p>
              {response}
              {frame < 130 && (
                <span className="demo-caret demo-caret--violet" />
              )}
            </p>
            <FileCard scenario={scenario} visible={resultProgress} />
          </div>
        )}
      </div>
      <div className="demo-conversation__composer" aria-label="Mivlet composer">
        <div className="demo-composer__draft">Message…</div>
        <div className="demo-composer__controls">
          <button
            type="button"
            className="demo-composer__add"
            aria-label="Add files and context"
          >
            <Plus size={20} />
          </button>
          <div className="demo-composer__model">
            <span>GPT-6.1 Sol High</span>
            <CaretDown size={13} />
          </div>
          <Microphone size={19} aria-hidden="true" />
          <button
            type="button"
            className="demo-send-button"
            aria-label="Send prompt"
          >
            <ArrowUp size={20} />
          </button>
        </div>
      </div>
      <div
        className="demo-conversation__ambient"
        style={{
          background: `radial-gradient(circle at 50% 0%, ${agent.color}0e, transparent 40%)`,
        }}
      />
    </section>
  );
}

export function MivletProductScene({
  scenario: scenarioId = "plan",
  compact = false,
  previousScene = null,
}) {
  const scenario = useMemo(() => getScenario(scenarioId), [scenarioId]);
  const frame = useCurrentFrame();
  const isCrossfading = previousScene && frame < CROSSFADE_FRAMES;
  const opacity = isCrossfading ? range(frame, 0, CROSSFADE_FRAMES) : 1;
  return (
    <div className="demo-scene-stack">
      {isCrossfading && (
        <WorkspaceScene
          scenario={getScenario(previousScene.scenario)}
          compact={compact}
          frame={previousScene.frame}
          layer="outgoing"
        />
      )}
      <WorkspaceScene
        scenario={scenario}
        compact={compact}
        frame={frame}
        layer="incoming"
        opacity={opacity}
      />
    </div>
  );
}

function WorkspaceScene({ scenario, compact, frame, layer, opacity = 1 }) {
  const layout = compact || "desktop";
  return (
    <div
      className={`mivlet-demo mivlet-demo--${layout}`}
      data-scene-layer={layer}
      style={{ opacity }}
      inert
      aria-hidden="true"
    >
      <Sidebar scenario={scenario} />
      <Conversation scenario={scenario} frame={frame} />
      <Activity scenario={scenario} frame={frame} />
    </div>
  );
}

export function ProductDemo({
  scenario = "plan",
  replayKey = 0,
  playbackEnabled = true,
}) {
  const playerRef = useRef(null);
  const rootRef = useRef(null);
  const lastScenarioRef = useRef(null);
  const selectionRef = useRef(null);
  const [previousScene, setPreviousScene] = useState(null);
  const [inView, setInView] = useState(false);
  const [layout, setLayout] = useState(() =>
    window.innerWidth <= 560
      ? "mobile"
      : window.innerWidth <= 900
        ? "tablet"
        : "desktop",
  );

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.14 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () =>
      setLayout(
        window.innerWidth <= 560
          ? "mobile"
          : window.innerWidth <= 900
            ? "tablet"
            : "desktop",
      );
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const syncPlayback = () => {
      const player = playerRef.current;
      if (!player) return;
      if (!playbackEnabled || !inView || document.visibilityState === "hidden")
        player.pause();
      else if (player.getCurrentFrame() >= DURATION - 1) player.pause();
      else player.play();
    };
    syncPlayback();
    document.addEventListener("visibilitychange", syncPlayback);
    return () => document.removeEventListener("visibilitychange", syncPlayback);
  }, [inView, playbackEnabled]);

  useLayoutEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const previousSelection = selectionRef.current;
    if (
      previousSelection?.scenario === scenario &&
      previousSelection.replayKey === replayKey
    )
      return;
    const isInitialCompletedScene = !previousSelection && replayKey === 0;
    selectionRef.current = { scenario, replayKey };

    // The first visit opens on a useful finished result. Do not seek it back
    // to frame zero, and let visibility changes keep that completed frame.
    if (isInitialCompletedScene) {
      lastScenarioRef.current = scenario;
      return;
    }

    // Capture the outgoing scene before seeking, including interrupted manual selections.
    setPreviousScene(
      lastScenarioRef.current
        ? {
            scenario: lastScenarioRef.current,
            frame: player.getCurrentFrame(),
          }
        : null,
    );
    lastScenarioRef.current = scenario;
    player.seekTo(0);
    if (playbackEnabled && inView && document.visibilityState !== "hidden")
      player.play();
  }, [replayKey, scenario]);

  const isMobile = layout === "mobile";
  const isTablet = layout === "tablet";
  const compositionWidth = isMobile ? 320 : isTablet ? 760 : 1100;
  const compositionHeight = isTablet ? 500 : 640;

  return (
    <div
      ref={rootRef}
      className={`product-demo-player product-demo-player--${layout}`}
      data-scenario={scenario}
      role="img"
      aria-label={`Mivlet workspace showing ${getScenario(scenario).agent} working on ${getScenario(scenario).label.toLowerCase()}, with Projects, Agents, Plugins and workspace tools.`}
    >
      <Player
        ref={playerRef}
        component={MivletProductScene}
        inputProps={{ scenario, compact: layout, previousScene }}
        durationInFrames={DURATION}
        compositionWidth={compositionWidth}
        compositionHeight={compositionHeight}
        fps={FPS}
        loop={false}
        initialFrame={replayKey === 0 ? DURATION - 1 : 0}
        moveToBeginningWhenEnded={false}
        autoPlay={false}
        initiallyMuted
        numberOfSharedAudioTags={0}
        controls={false}
        clickToPlay={false}
        doubleClickToFullscreen={false}
        spaceKeyToPlayOrPause={false}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
