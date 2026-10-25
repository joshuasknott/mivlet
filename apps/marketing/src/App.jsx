import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { GithubLogo } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { List } from "@phosphor-icons/react/dist/csr/List";
import { WindowsLogo } from "@phosphor-icons/react/dist/csr/WindowsLogo";
import { X } from "@phosphor-icons/react/dist/csr/X";
import Providers from "./components/Providers.jsx";
import { Plugins } from "./components/Plugins.jsx";
import { PluginBriefing } from "./components/PluginDemo.jsx";
import { getScenario, scenarios } from "./components/demo-data.js";
import {
  ExampleDocument,
  exampleDocuments,
} from "./components/ExampleDocument.jsx";
import { AgentAvatar } from "./components/AgentAvatar.jsx";
import { AgentPortraits, UseCaseNav } from "./components/UseCaseNav.jsx";
import { AnimatedPromptComposer } from "./components/AnimatedPromptComposer.jsx";
import "./components/project-demo.css";

const ProjectDemo = lazy(() =>
  import("./components/ProjectDemo.jsx").then((m) => ({
    default: m.ProjectDemo,
  })),
);

const ProductDemo = lazy(() =>
  import("./components/ProductDemo.jsx").then((m) => ({
    default: m.ProductDemo,
  })),
);
const repository = "https://github.com/joshuasknott/mivlet";
const setupUrl = `${repository}#development`;

function Logo() {
  return (
    <img
      className="brand"
      src="/brand/mivlet-lockup-light.png"
      width="160"
      height="32"
      alt="Mivlet"
    />
  );
}
function Dialog({ children, title, onClose, className = "", labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const element = ref.current;
    if (!element.open) element.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      previous?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={labelledBy || "dialog-title"}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <button
          className="icon-button dialog-close"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={22} />
        </button>
        {title && <h2 id="dialog-title">{title}</h2>}
        {children}
      </div>
    </dialog>
  );
}
function Reveal({ children, className = "", as: Element = "div" }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!("IntersectionObserver" in window)) {
      node.dataset.visible = "true";
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          node.dataset.visible = "true";
          observer.disconnect();
        }
      },
      { threshold: 0, rootMargin: "160px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <Element ref={ref} className={`reveal ${className}`}>
      {children}
    </Element>
  );
}
const questions = [
  [
    "What is Mivlet?",
    "Mivlet is an independent desktop workspace for your AI agents. Give an agent a name, connect your AI provider, and bring your conversations, files and work together in one place.",
  ],
  [
    "Can I use my existing AI provider?",
    "Connect an existing provider account where supported, or use your own API key. Each provider has its own requirements and usage limits. Provider subscriptions and API usage are separate from Mivlet.",
  ],
  [
    "Where does my work live?",
    "Conversations and workspace data are stored locally on your device. Connected AI providers and apps receive the context they need to handle your requests. Local-first does not mean that AI requests stay offline.",
  ],
  [
    "How do plugins work?",
    "Connect an app in Mivlet's Plugins section, then ask your agent to work with context from that app. Each connection has its own sign-in, permissions and availability requirements.",
  ],
  [
    "How do I get started?",
    "Mivlet is an experimental Windows app, available as a source release. Follow the build and service-configuration instructions on GitHub, sign in, then connect a supported AI provider. The demo on this page needs no account or installation.",
  ],
];
export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scenario, setScenario] = useState("plan");
  const [replayKey, setReplayKey] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const active = getScenario(scenario);
  const closeDialog = () => setDialog(null);
  useEffect(() => {
    let frame;
    const scrollToInitialSection = () => {
      frame = requestAnimationFrame(() => {
        const target = document.getElementById(window.location.hash.slice(1));
        target?.scrollIntoView({ behavior: "instant", block: "start" });
      });
    };
    if (document.readyState === "complete") scrollToInitialSection();
    else
      window.addEventListener("load", scrollToInitialSection, { once: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("load", scrollToInitialSection);
    };
  }, []);
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const chooseScenario = (id) => {
    setScenario(id);
    setReplayKey((key) => key + 1);
    setAnnouncement(
      `Showing the ${getScenario(id).eyebrow.toLowerCase()} example.`,
    );
  };
  const showDemo = () => {
    setMenuOpen(false);
    document.getElementById("product").scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };
  const submitPrompt = (prompt) => {
    const match = scenarios.find(
      (item) => item.prompt.toLowerCase() === prompt.trim().toLowerCase(),
    );
    if (match) {
      chooseScenario(match.id);
      showDemo();
    } else setDialog({ type: "custom" });
  };
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a
          href="#"
          className="brand-link"
          aria-label="Mivlet home"
          onClick={() => setMenuOpen(false)}
        >
          <Logo />
        </a>
        <nav
          className={menuOpen ? "navigation is-open" : "navigation"}
          aria-label="Main navigation"
          id="main-navigation"
        >
          <a href="#product" onClick={() => setMenuOpen(false)}>
            Agents
          </a>
          <a href="#projects" onClick={() => setMenuOpen(false)}>
            Projects
          </a>
          <a href="#connections" onClick={() => setMenuOpen(false)}>
            Connections
          </a>
          <a href="#plugins" onClick={() => setMenuOpen(false)}>
            Plugins
          </a>
        </nav>
        <a
          className="button button-dark nav-cta"
          href="#product"
          onClick={() => setMenuOpen(false)}
        >
          Try the demo <ArrowRight size={16} />
        </a>
        <button
          className="icon-button menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={24} /> : <List size={24} />}
        </button>
      </header>
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <img
            className="hero-ribbon"
            src="/images/mivlet-ribbon.png"
            width="500"
            height="500"
            alt=""
            fetchPriority="high"
          />
          <div className="hero-content">
            <h1 id="hero-title">
              One place for
              <br />
              your{" "}
              <span className="hero-highlight">
                AI agents.
                <img
                  src="/images/hero-underline.png"
                  width="350"
                  height="44"
                  alt=""
                />
              </span>
            </h1>
            <p className="hero-description">
              Plan projects, research questions and create useful work
              <br className="desktop-break" /> with the AI providers and tools
              you choose.
            </p>
            <div className="hero-actions">
              <a className="button button-dark" href="#product">
                Try the demo <ArrowRight size={18} />
              </a>
              <a
                className="button button-white"
                href={setupUrl}
                target="_blank"
                rel="noreferrer"
              >
                Set up on Windows <ArrowUpRight size={18} />
              </a>
            </div>
            <p className="availability">
              <WindowsLogo size={17} weight="fill" /> Experimental · Source
              setup on GitHub
            </p>
          </div>
          <div className="hero-proof">
            <div className="hero-proof-prompt">
              <div className="hero-proof-agent">
                <AgentAvatar name={active.agent} size={36} />
                <span>
                  {active.agent} <span>· {active.agentRole}</span>
                </span>
              </div>
              <p>{active.prompt}</p>
            </div>
            <button
              className="hero-proof-result"
              onClick={() => setDialog({ type: "result" })}
              aria-label={`Read ${active.agent}’s ${active.file.replace(/\.md$/, "").toLowerCase()}`}
            >
              <span className="hero-proof-file">
                <FileText size={20} /> {active.file}
              </span>
              <span className="hero-proof-body">
                {exampleDocuments[scenario][1][1]}
              </span>
              <span className="hero-proof-open">
                Read the example <ArrowUpRight size={16} />
              </span>
            </button>
          </div>
        </section>
        <section
          className="product-section wide-container"
          id="product"
          aria-label="Mivlet interactive product demo"
        >
          <div className="agents-intro">
            <h2>Choose an agent. See what they make.</h2>
          </div>
          <UseCaseNav scenario={scenario} onChange={chooseScenario} />
          <div
            className="product-stage"
            id="product-scene"
            role="tabpanel"
            aria-labelledby={`use-case-${scenario}`}
          >
            <Suspense
              fallback={
                <div className="demo-loading">
                  <Logo />
                  <p>Making a little room for your ideas…</p>
                </div>
              }
            >
              <ProductDemo
                scenario={scenario}
                replayKey={replayKey}
                playbackEnabled={!dialog}
              />
            </Suspense>
          </div>
          <div className="demo-caption">
            <p>
              An example workspace. Your own work starts in the Windows app.
            </p>
            <button
              className="text-button"
              onClick={() => setDialog({ type: "result" })}
            >
              Open example document <ArrowUpRight size={17} />
            </button>
          </div>
          <p className="sr-only" aria-live="polite">
            {announcement}
          </p>
        </section>
        <Reveal className="wide-container">
          <section
            className="projects-section"
            id="projects"
            aria-labelledby="projects-title"
          >
            <div className="projects-copy">
              <h2 id="projects-title">
                One project.
                <br />
                Everyone in the loop.
              </h2>
              <p className="projects-description">
                Share the context. Divide the work. Bring the results together.
              </p>
            </div>
            <Suspense
              fallback={<div className="projects-player" aria-hidden="true" />}
            >
              <ProjectDemo playbackEnabled={!dialog} />
            </Suspense>
          </section>
        </Reveal>
        <Reveal className="content-container providers-reveal">
          <Providers />
        </Reveal>
        <Reveal className="wide-container">
          <Plugins
            onReadBriefing={() => setDialog({ type: "plugin-result" })}
            playbackEnabled={!dialog}
          />
        </Reveal>
        <section
          className="trust-section content-container"
          aria-labelledby="trust-title"
        >
          <Reveal>
            <h2 id="trust-title">
              Your work stays close.
              <br />
              You stay in control.
            </h2>
          </Reveal>
          <div className="trust-grid">
            <Reveal as="article">
              <h3>Saved on your device.</h3>
              <p>
                Conversations, files and workspace data live locally. Connected
                providers and apps receive the context needed for your requests.
              </p>
            </Reveal>
            <Reveal as="article">
              <h3>Credentials kept private.</h3>
              <p>
                Provider credentials stay in native secure storage, separate
                from your conversations and account identity.
              </p>
            </Reveal>
            <Reveal as="article">
              <h3>Approve the important steps.</h3>
              <p>
                Review and approve consequential actions before they happen.
                Inspect the history and stop work when you need to.
              </p>
            </Reveal>
          </div>
          <a
            className="text-button"
            href={`${repository}/blob/main/SECURITY.md`}
            target="_blank"
            rel="noreferrer"
          >
            Read the security notes <ArrowUpRight size={17} />
          </a>
        </section>
        <Reveal className="wide-container">
          <AnimatedPromptComposer
            onSubmitPrompt={submitPrompt}
            playbackEnabled={!dialog}
          />
        </Reveal>
        <Reveal className="setup-section content-container" as="section">
          <div>
            <h2>
              Make room for
              <br />
              your first agent.
            </h2>
            <p>
              Mivlet is an experimental Windows app you build from source. Setup
              needs developer tools, account configuration and a supported AI
              provider.
            </p>
            <a
              className="button button-dark"
              href={setupUrl}
              target="_blank"
              rel="noreferrer"
            >
              Set up on Windows <ArrowUpRight size={18} />
            </a>
          </div>
          <ol className="setup-steps">
            <li>
              <h3>Build your workspace.</h3>
              <p>
                Follow the source setup and service configuration on GitHub.
              </p>
            </li>
            <li>
              <h3>Connect your AI.</h3>
              <p>
                Sign in, then connect a supported provider account or your own
                API key.
              </p>
            </li>
            <li>
              <h3>Make an agent yours.</h3>
              <p>
                Choose a name, bring in your files and start with what you need.
              </p>
            </li>
          </ol>
        </Reveal>
        <section
          className="details-section content-container"
          aria-labelledby="details-title"
        >
          <Reveal className="details-intro">
            <AgentPortraits className="details-agents" />
            <h2 id="details-title">
              Your workspace.
              <br />
              Your choice.
            </h2>
            <p>A place for your work, with you in control.</p>
            <a
              className="text-button"
              href={repository}
              target="_blank"
              rel="noreferrer"
            >
              Built in the open <GithubLogo size={18} />
            </a>
          </Reveal>
          <div className="faq">
            {questions.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <CaretDown size={19} />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="site-footer wide-container">
        <a href="#" aria-label="Back to top">
          <Logo />
        </a>
        <p className="footer-tagline">Your workspace. Your choice.</p>
        <div className="footer-links">
          <button
            className="text-button"
            onClick={() => setDialog({ type: "privacy" })}
          >
            Privacy
          </button>
          <a href={repository} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={14} />
          </a>
          <span className="copyright">© {new Date().getFullYear()} Mivlet</span>
        </div>
      </footer>
      {dialog?.type === "result" && (
        <Dialog title={active.file} onClose={closeDialog}>
          <p className="example-label">
            <FileText size={16} /> Example output · {active.agent}
          </p>
          <ExampleDocument scenario={scenario} />
          <button className="button button-dark" onClick={closeDialog}>
            Back to the page <ArrowRight size={17} />
          </button>
        </Dialog>
      )}
      {dialog?.type === "custom" && (
        <Dialog title="Your next idea belongs here." onClose={closeDialog}>
          <p className="dialog-lead">
            This page shows example workspaces. To work with your own prompts
            and files, set up the Windows app and connect your AI provider.
          </p>
          <AgentPortraits className="details-agents" />
          <a
            className="button button-dark"
            href={setupUrl}
            target="_blank"
            rel="noreferrer"
          >
            Set up Mivlet <ArrowUpRight size={18} />
          </a>
        </Dialog>
      )}
      {dialog?.type === "plugin-result" && (
        <Dialog title="Launch briefing" onClose={closeDialog}>
          <p className="example-label">
            <FileText size={16} /> Example output · Nova
          </p>
          <PluginBriefing />
          <button className="button button-dark" onClick={closeDialog}>
            Back to the page <ArrowRight size={17} />
          </button>
        </Dialog>
      )}
      {dialog?.type === "privacy" && (
        <Dialog title="A little space. Just for you." onClose={closeDialog}>
          <p className="dialog-lead">
            This page does not send your input to an AI provider or save it to a
            server.
          </p>
          <p>
            Mivlet stores conversations and workspace data locally. When you
            connect a provider or an app, it receives the context needed for
            your request. Provider credentials stay behind native secure
            storage.
          </p>
          <a
            className="text-button"
            href={`${repository}/blob/main/SECURITY.md`}
            target="_blank"
            rel="noreferrer"
          >
            Read the project’s security notes <ArrowUpRight size={17} />
          </a>
        </Dialog>
      )}
    </>
  );
}
