import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Player } from "@remotion/player";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { agentCast } from "./agent-cast.js";

const FPS = 30;
const DURATION_SECONDS = 11;

const contributions = [
  {
    agent: "Nova",
    startSeconds: -0.4,
    message: "I’ll bring everyone’s work into one launch brief.",
  },
  {
    agent: "Sage",
    startSeconds: 0.7,
    message: "Audience research is ready.",
  },
  {
    agent: "Kit",
    startSeconds: 1.7,
    message: "The launch story is drafted.",
  },
  {
    agent: "Otto",
    startSeconds: 2.7,
    message: "Technical checks are complete.",
  },
  {
    agent: "Fern",
    startSeconds: 3.7,
    message: "The visual direction is ready.",
  },
  {
    agent: "Pip",
    startSeconds: 4.7,
    message: "Release checklist reviewed.",
  },
];

const briefSections = [
  {
    icon: UsersThree,
    title: "Who it’s for",
    copy: "Independent teams doing ambitious work.",
    color: "violet",
    startSeconds: 0,
  },
  {
    icon: FileText,
    title: "The story",
    copy: "One place for your AI agents.",
    color: "blue",
    startSeconds: 1.5,
  },
  {
    icon: CheckCircle,
    title: "Ready for launch",
    copy: "Plan, copy, visuals and checks in one place.",
    color: "green",
    startSeconds: 4.9,
  },
];

function reveal(frame, start, duration = 16) {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function AgentStrip({ className = "" }) {
  return (
    <div
      className={`project-agent-strip ${className}`}
      aria-label="Project contributors"
    >
      {agentCast.map((agent) => (
        <AgentAvatar key={agent.name} name={agent.name} size={25} />
      ))}
    </div>
  );
}

function ConversationMessage({ contribution, index, frame, fps, resetFade }) {
  const start = Math.round(contribution.startSeconds * fps);
  const visible =
    contribution.startSeconds <= 0 ? 1 : reveal(frame, start, 16) * resetFade;
  const agent = agentCast.find((item) => item.name === contribution.agent);
  return (
    <div
      className="project-message"
      style={{
        opacity: visible,
        translate: `0 ${Math.round((1 - visible) * 8)}px`,
      }}
    >
      <AgentAvatar name={contribution.agent} size={31} />
      <div className="project-message-copy">
        <div className="project-message-meta">
          <strong>{contribution.agent}</strong>
          <span>{agent?.role}</span>
        </div>
        <p
          className={`project-message-bubble project-message-bubble--${index}`}
          style={{ "--bubble-color": agent?.color }}
        >
          {contribution.message}
        </p>
      </div>
    </div>
  );
}

function BriefSection({ section, frame, fps, resetFade }) {
  const Icon = section.icon;
  const visible =
    section.startSeconds <= 0
      ? 1
      : reveal(frame, Math.round(section.startSeconds * fps), 18) * resetFade;
  return (
    <div
      className="project-brief-section"
      style={{
        opacity: visible,
        translate: `0 ${Math.round((1 - visible) * 9)}px`,
      }}
    >
      <span className={`project-brief-section-icon is-${section.color}`}>
        <Icon
          size={20}
          weight={section.color === "green" ? "fill" : "duotone"}
        />
      </span>
      <span className="project-brief-section-copy">
        <strong>{section.title}</strong>
        <small>{section.copy}</small>
      </span>
    </div>
  );
}

function LaunchBrief({ frame, fps, resetFade = 1 }) {
  const ready = reveal(frame, Math.round(5.1 * fps), 20);
  return (
    <article className="project-brief-card">
      <header className="project-brief-header">
        <span className="project-brief-file-icon">
          <FileText size={23} weight="duotone" />
        </span>
        <span className="project-brief-title">
          <strong>Launch brief.md</strong>
          <small>Built together</small>
        </span>
        <AgentStrip />
      </header>
      <div className="project-brief-divider" />
      <div className="project-brief-body">
        {briefSections.map((section) => (
          <BriefSection
            key={section.title}
            section={section}
            frame={frame}
            fps={fps}
            resetFade={resetFade}
          />
        ))}
      </div>
      <footer
        className="project-brief-footer"
        style={{ opacity: ready * resetFade }}
      >
        <span className="project-brief-ready">
          <CheckCircle size={21} weight="fill" /> Ready to review
        </span>
        <AgentStrip />
      </footer>
    </article>
  );
}

export function ProjectCollabScene({ layout = "desktop" }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durationInFrames = DURATION_SECONDS * fps;
  const loopFade =
    frame > durationInFrames - 24
      ? 1 - reveal(frame, durationInFrames - 24, 24)
      : 1;

  return (
    <div
      className={`project-demo-scene project-demo-scene--${layout}`}
      role="img"
      aria-label="Mivlet launch project with six agents handing work into a shared launch brief."
    >
      <header className="project-demo-header">
        <div className="project-demo-title">
          <FolderSimple size={24} weight="duotone" />
          <span>
            <strong>Mivlet launch</strong>
            <small>Workspace project</small>
          </span>
        </div>
        <AgentStrip />
      </header>
      <div className="project-demo-content">
        <section
          className="project-conversation"
          aria-label="Agent contributions"
        >
          <div className="project-root-prompt">
            <span className="project-root-prompt-icon">A</span>
            <p>
              Prepare the launch. Bring the plan, research, copy and checks
              together.
            </p>
          </div>
          <div className="project-conversation-list">
            {contributions.map((contribution, index) => (
              <ConversationMessage
                key={contribution.agent}
                contribution={contribution}
                index={index}
                frame={frame}
                fps={fps}
                resetFade={loopFade}
              />
            ))}
          </div>
        </section>
        <section
          className="project-brief-wrap"
          aria-label="Shared launch brief"
        >
          <LaunchBrief frame={frame} fps={fps} resetFade={loopFade} />
        </section>
      </div>
    </div>
  );
}

function getInitialLayout() {
  if (typeof window === "undefined") return "desktop";
  return window.innerWidth <= 640
    ? "mobile"
    : window.innerWidth <= 980
      ? "tablet"
      : "desktop";
}

export function ProjectDemo({ playbackEnabled = true }) {
  const rootRef = useRef(null);
  const [player, setPlayer] = useState(null);
  const [inView, setInView] = useState(false);
  const [layout, setLayout] = useState(getInitialLayout);
  const [sceneSize, setSceneSize] = useState({ width: 900, height: 650 });

  // Keep UI text at its native CSS size instead of shrinking a canvas on phones.
  useLayoutEffect(() => {
    const stage = rootRef.current;
    if (!stage) return;
    let sceneNode;
    let pendingFrame;
    const measure = () => {
      const scene = stage.querySelector(".project-demo-scene");
      if (!scene) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = requestAnimationFrame(measure);
        return;
      }
      if (sceneNode !== scene) {
        if (sceneNode) observer.unobserve(sceneNode);
        sceneNode = scene;
        observer.observe(scene);
      }
      const width = Math.round(stage.clientWidth);
      const height = scene?.scrollHeight;
      if (width && height)
        setSceneSize((current) =>
          current.width === width && current.height === height
            ? current
            : { width, height },
        );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => {
      cancelAnimationFrame(pendingFrame);
      observer.disconnect();
    };
  }, [layout, sceneSize.width]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.08 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setLayout(getInitialLayout());
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const sync = () => {
      if (!player) return;
      if (playbackEnabled && inView && document.visibilityState !== "hidden")
        player.play();
      else player.pause();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [inView, playbackEnabled, player]);

  const compositionWidth = sceneSize.width;
  const compositionHeight = sceneSize.height;

  return (
    <div
      ref={rootRef}
      className="projects-player"
      style={{ aspectRatio: `${compositionWidth} / ${compositionHeight}` }}
      role="img"
      aria-label="Animated Mivlet project collaboration demo"
    >
      <Player
        ref={setPlayer}
        component={ProjectCollabScene}
        inputProps={{ layout }}
        durationInFrames={DURATION_SECONDS * FPS}
        compositionWidth={compositionWidth}
        compositionHeight={compositionHeight}
        fps={FPS}
        loop
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
