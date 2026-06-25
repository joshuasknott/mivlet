import {
  ArrowUp,
  Bell,
  CaretDown,
  CaretRight,
  ChatCircle,
  FileText,
  Folder,
  Gear,
  Lightning,
  MagnifyingGlass,
  Microphone,
  Paperclip,
  Plus,
  PuzzlePiece,
  SidebarSimple,
  Sparkle,
  Stack,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";

const projects = [
  {
    id: "praxis",
    title: "Praxis",
    threads: [
      { id: "initial-build", title: "Initial build" },
      { id: "memory", title: "Memory and approvals" },
      { id: "connectors", title: "Connector recovery" },
    ],
  },
  {
    id: "website",
    title: "Website",
    threads: [
      { id: "launch-page", title: "Launch page" },
      { id: "security-copy", title: "Security copy" },
    ],
  },
];

const chats = [
  { id: "daily-catchup", title: "Daily catch-up" },
  { id: "market-notes", title: "Market research notes" },
  { id: "voice-drafts", title: "Voice drafts" },
];

const directives = [
  {
    id: "launch-plan",
    icon: FileText,
    title: "Turn Codex notes into a launch plan",
    context: "OpenAI Codex Manual + PRD",
    prompt:
      "Turn the Codex notes and PRD into a launch plan with milestones, risks, and the next three implementation steps.",
  },
  {
    id: "review-pr",
    icon: PuzzlePiece,
    title: "Review the draft PR before publishing",
    context: "Praxis repository - initial-build",
    prompt:
      "Review the current Praxis draft PR. Check tests, screenshots, permissions, and anything that should be resolved before publishing.",
  },
  {
    id: "research",
    icon: Stack,
    title: "Summarize market research into decisions",
    context: "market-research.pdf - added 2 days ago",
    prompt:
      "Summarize market-research.pdf into product decisions, unresolved assumptions, and citations to keep attached.",
  },
  {
    id: "digest",
    icon: Lightning,
    title: "Prepare this week's workspace digest",
    context: "Memory + active projects",
    prompt:
      "Prepare a concise weekly digest covering active projects, new knowledge, approvals, and the next actions.",
  },
];

function CollectionHeader({ children, open, onClick }) {
  return (
    <button className="collection-header" type="button" aria-expanded={open} onClick={onClick}>
      <span>{children}</span>
      <CaretRight className="collection-caret" size={13} weight="bold" />
    </button>
  );
}

function ThreadButton({ children, active, nested = false, onClick }) {
  return (
    <button
      className={`thread-button${nested ? " thread-button--nested" : ""}${
        active ? " thread-button--active" : ""
      }`}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function App() {
  const [composer, setComposer] = useState("");
  const [activeThread, setActiveThread] = useState("initial-build");
  const [collections, setCollections] = useState({ projects: true, chats: true });
  const [openProjects, setOpenProjects] = useState({ praxis: true, website: false });
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [status, setStatus] = useState("Ready");
  const composerRef = useRef(null);

  const selectThread = (id, title) => {
    setActiveThread(id);
    setStatus(title);
  };

  const useDirective = (directive) => {
    setComposer(directive.prompt);
    setStatus(`Drafting from ${directive.context}`);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const startChat = () => {
    setComposer("");
    setActiveThread("new-chat");
    setStatus("New chat");
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Praxis navigation">
        <div className="window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div className="brand">
          <span className="brand-image">
            <img src="/praxis-mark.png" alt="" />
          </span>
          <span>Praxis</span>
        </div>

        <button
          className="mobile-nav-toggle"
          type="button"
          aria-label="Open navigation"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          <SidebarSimple size={20} />
        </button>

        <button className="new-chat-button" type="button" onClick={startChat}>
          <ChatCircle size={16} />
          <span>New chat</span>
          <Plus size={14} />
        </button>

        <div className="sidebar-scroll">
          <section className="nav-collection" aria-label="Projects">
            <CollectionHeader
              open={collections.projects}
              onClick={() =>
                setCollections((current) => ({ ...current, projects: !current.projects }))
              }
            >
              Projects
            </CollectionHeader>

            {collections.projects && (
              <div className="collection-content">
                {projects.map((project) => {
                  const open = openProjects[project.id];
                  return (
                    <div className="project" key={project.id}>
                      <button
                        className="project-button"
                        type="button"
                        aria-expanded={open}
                        onClick={() =>
                          setOpenProjects((current) => ({ ...current, [project.id]: !open }))
                        }
                      >
                        <CaretRight className="project-caret" size={12} weight="bold" />
                        <Folder size={15} />
                        <span>{project.title}</span>
                      </button>
                      {open && (
                        <div className="project-threads">
                          {project.threads.map((thread) => (
                            <ThreadButton
                              key={thread.id}
                              nested
                              active={activeThread === thread.id}
                              onClick={() => selectThread(thread.id, thread.title)}
                            >
                              {thread.title}
                            </ThreadButton>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="nav-collection" aria-label="Chats">
            <CollectionHeader
              open={collections.chats}
              onClick={() => setCollections((current) => ({ ...current, chats: !current.chats }))}
            >
              Chats
            </CollectionHeader>

            {collections.chats && (
              <div className="collection-content">
                {chats.map((chat) => (
                  <ThreadButton
                    key={chat.id}
                    active={activeThread === chat.id}
                    onClick={() => selectThread(chat.id, chat.title)}
                  >
                    {chat.title}
                  </ThreadButton>
                ))}
              </div>
            )}
          </section>
        </div>

        <nav className="utility-links" aria-label="Workspace tools">
          <button type="button">
            <Stack size={16} />
            <span>Knowledge</span>
          </button>
          <button type="button">
            <PuzzlePiece size={16} />
            <span>Plugins</span>
          </button>
          <button type="button">
            <Lightning size={16} />
            <span>Automations</span>
          </button>
        </nav>

        <div className="account">
          <button
            className="account-button"
            type="button"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((open) => !open)}
          >
            <span className="avatar">J</span>
            <span className="account-name">Josh</span>
            <CaretDown size={14} />
          </button>
          {accountOpen && (
            <div className="account-menu">
              <button type="button">
                <Gear size={15} />
                Profile & settings
              </button>
              <small>Read-only by default</small>
            </div>
          )}
        </div>

        {mobileNavOpen && (
          <div className="mobile-drawer" aria-label="Mobile navigation">
            <button
              className="mobile-new-chat"
              type="button"
              onClick={() => {
                startChat();
                setMobileNavOpen(false);
              }}
            >
              <ChatCircle size={16} />
              New chat
              <Plus size={14} />
            </button>

            <div className="mobile-drawer-section">
              <strong>Projects</strong>
              {projects.map((project) => (
                <div className="mobile-project" key={project.id}>
                  <span>
                    <Folder size={14} />
                    {project.title}
                  </span>
                  {project.threads.map((thread) => (
                    <ThreadButton
                      key={thread.id}
                      nested
                      active={activeThread === thread.id}
                      onClick={() => {
                        selectThread(thread.id, thread.title);
                        setMobileNavOpen(false);
                      }}
                    >
                      {thread.title}
                    </ThreadButton>
                  ))}
                </div>
              ))}
            </div>

            <div className="mobile-drawer-section">
              <strong>Chats</strong>
              {chats.map((chat) => (
                <ThreadButton
                  key={chat.id}
                  active={activeThread === chat.id}
                  onClick={() => {
                    selectThread(chat.id, chat.title);
                    setMobileNavOpen(false);
                  }}
                >
                  {chat.title}
                </ThreadButton>
              ))}
            </div>

            <nav className="mobile-utilities" aria-label="Mobile workspace tools">
              <button type="button">
                <Stack size={15} />
                Knowledge
              </button>
              <button type="button">
                <PuzzlePiece size={15} />
                Plugins
              </button>
              <button type="button">
                <Lightning size={15} />
                Automations
              </button>
            </nav>
          </div>
        )}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="search" type="button">
            <MagnifyingGlass size={17} />
            <span>Search</span>
            <kbd>⌘ K</kbd>
          </button>
          <button className="icon-button notification" type="button" aria-label="Notifications">
            <Bell size={20} />
            <span />
          </button>
          <button className="top-avatar" type="button" aria-label="Open profile">
            J
          </button>
        </header>

        <div className="workspace-content">
          <section className="welcome">
            <div className="greeting">
              <Sparkle size={18} weight="fill" />
              <span>Good evening, Josh</span>
            </div>
            <h1>Bring the work into one place</h1>
            <p>Ask Praxis to work with your tools, knowledge, and files.</p>
          </section>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              setStatus(composer.trim() ? "Ready to work" : "Add a prompt or choose a suggestion");
            }}
          >
            <label className="sr-only" htmlFor="praxis-composer">
              Ask Praxis
            </label>
            <textarea
              ref={composerRef}
              id="praxis-composer"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Ask anything, attach context, or run a command..."
            />
            <div className="composer-toolbar">
              <div className="composer-actions">
                <button
                  className={`voice-button${voiceActive ? " voice-button--active" : ""}`}
                  type="button"
                  aria-pressed={voiceActive}
                  onClick={() => {
                    setVoiceActive((active) => !active);
                    setStatus(voiceActive ? "Voice paused" : "Listening");
                  }}
                >
                  <Microphone size={17} />
                  <span>Voice</span>
                </button>
                <button type="button">
                  <Paperclip size={18} />
                  <span>Attach</span>
                </button>
                <button type="button">
                  <span className="at-mark">@</span>
                  <span>tools</span>
                </button>
                <button type="button">
                  <span className="slash-mark">/</span>
                  <span>commands</span>
                </button>
              </div>
              <button className="send-button" type="submit" aria-label="Send">
                <ArrowUp size={20} weight="bold" />
              </button>
            </div>
          </form>

          <div className="composer-status" aria-live="polite">
            {status}
          </div>

          <section className="directives" aria-label="Suggested actions">
            {directives.map((directive) => {
              const Icon = directive.icon;
              return (
                <button
                  className="directive"
                  key={directive.id}
                  type="button"
                  onClick={() => useDirective(directive)}
                >
                  <span className="directive-icon">
                    <Icon size={18} />
                  </span>
                  <span className="directive-copy">
                    <strong>{directive.title}</strong>
                    <small>{directive.context}</small>
                  </span>
                  <CaretRight size={15} />
                </button>
              );
            })}
          </section>
        </div>
      </section>
    </main>
  );
}
