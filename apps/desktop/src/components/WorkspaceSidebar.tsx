import {
  CaretDown,
  CaretRight,
  ChatCircle,
  FolderOpen,
  MagnifyingGlass,
  Plus,
  SidebarSimple
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { ProjectWorkspace, ThreadSummary } from "@arden/protocol";
import { ArdenLogo } from "./ArdenLogo";

/**
 * Workspace sidebar / shell navigation.
 *
 * Knowledge, Automations, and Plugins are first-class top-level nav items
 * (no "Utilities" grouping). Projects and Chats keep their collapsible groups
 * but with plain-text labels (no icons). The profile + settings control lives
 * in one bottom-left dropdown.
 */

export interface UtilityNavItem {
  label: string;
  icon: Icon;
}

export function WorkspaceSidebar({
  utilityItems,
  activeItem,
  expandedCollections,
  expandedProjects,
  projects,
  chatThreads,
  mobileNavOpen,
  accountOpen,
  onNewChat,
  onSearch,
  onToggleProjects,
  onToggleChats,
  onSelectUtility,
  onSelectProjectThread,
  onToggleProject,
  onToggleMobileNav,
  onSelectThread,
  onToggleAccount,
  onAccountMenu
}: {
  utilityItems: readonly UtilityNavItem[];
  activeItem: string;
  expandedCollections: { projects: boolean; chats: boolean };
  expandedProjects: Record<string, boolean>;
  projects: ProjectWorkspace[];
  chatThreads: ThreadSummary[];
  mobileNavOpen: boolean;
  accountOpen: boolean;
  onNewChat: () => void;
  onSearch: () => void;
  onToggleProjects: () => void;
  onToggleChats: () => void;
  onSelectUtility: (label: string) => void;
  onSelectProjectThread: (thread: ThreadSummary, projectTitle: string) => void;
  onToggleProject: (projectId: string, projectTitle: string, expanded: boolean) => void;
  onToggleMobileNav: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onToggleAccount: () => void;
  onAccountMenu: (item: "profile" | "settings") => void;
}) {
  return (
    <aside className="sidebar" aria-label="Workspace navigation">
      <ArdenLogo />

      <button
        className="mobile-nav-toggle"
        type="button"
        aria-label="Open navigation"
        aria-expanded={mobileNavOpen}
        onClick={onToggleMobileNav}
      >
        <SidebarSimple size={20} />
      </button>

      <button className="new-chat-button" type="button" onClick={onNewChat}>
        <ChatCircle size={16} />
        <span>New chat</span>
        <Plus size={14} />
      </button>

      <div className="sidebar-action-stack">
        <button
          className="sidebar-action-card sidebar-action-card--search"
          type="button"
          onClick={onSearch}
        >
          <MagnifyingGlass size={16} />
          <span>Search</span>
          <kbd>Ctrl</kbd>
          <kbd>K</kbd>
        </button>

        <nav className="primary-utility-nav" aria-label="Workspace tools">
          {utilityItems.map((item) => {
            const Icon = item.icon;
            const active = activeItem === item.label;
            return (
              <button
                key={item.label}
                type="button"
                className={`sidebar-action-card utility-row${active ? " utility-row--active" : ""}`}
                onClick={() => onSelectUtility(item.label)}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="sidebar-body">
        <section className="nav-group" aria-labelledby="projects-heading">
          <button
            type="button"
            className="nav-group-heading nav-group-heading--plain"
            id="projects-heading"
            aria-expanded={expandedCollections.projects}
            onClick={onToggleProjects}
          >
            <span className="nav-group-title nav-group-title--plain">
              <span>Projects</span>
            </span>
            <CaretRight className="collection-caret" size={13} weight="bold" />
          </button>
          {expandedCollections.projects ? (
            <div className="project-list">
              {projects.map((project) => {
                const expanded = expandedProjects[project.id];
                return (
                  <div className="project-block" key={project.id}>
                    <button
                      type="button"
                      className="project-row"
                      aria-expanded={expanded}
                      onClick={() => onToggleProject(project.id, project.title, expanded)}
                    >
                      <CaretRight className="project-caret" size={12} weight="bold" />
                      <FolderOpen size={15} />
                      <span>{project.title}</span>
                    </button>
                    {expanded ? (
                      <div className="nested-thread-list">
                        {project.threads.map((thread) => (
                          <button
                            key={thread.id}
                            type="button"
                            className={`thread-row thread-row--nested${
                              activeItem === thread.id ? " thread-row--active" : ""
                            }`}
                            onClick={() => onSelectProjectThread(thread, project.title)}
                          >
                            {thread.title}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>

        <section className="nav-group" aria-labelledby="chats-heading">
          <button
            type="button"
            className="nav-group-heading nav-group-heading--plain"
            id="chats-heading"
            aria-expanded={expandedCollections.chats}
            onClick={onToggleChats}
          >
            <span className="nav-group-title nav-group-title--plain">
              <span>Chats</span>
            </span>
            <CaretRight className="collection-caret" size={13} weight="bold" />
          </button>
          {expandedCollections.chats ? (
            <div className="thread-list">
              {chatThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={`thread-row${activeItem === thread.id ? " thread-row--active" : ""}`}
                  onClick={() => onSelectThread(thread)}
                >
                  {thread.title}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`account-row${accountOpen ? " account-row--open" : ""}`}
          onClick={onToggleAccount}
          aria-expanded={accountOpen}
          aria-haspopup="menu"
        >
          <span className="avatar">J</span>
          <strong>Josh</strong>
          <CaretDown size={16} weight="bold" />
        </button>
        {accountOpen ? (
          <div className="account-popover" role="menu" aria-label="Josh account menu">
            <button type="button" role="menuitem" onClick={() => onAccountMenu("profile")}>
              Profile
            </button>
            <button type="button" role="menuitem" onClick={() => onAccountMenu("settings")}>
              Settings
            </button>
          </div>
        ) : null}
      </div>

      {mobileNavOpen ? (
        <div className="mobile-drawer" aria-label="Mobile navigation">
          <button className="mobile-new-chat" type="button" onClick={onNewChat}>
            <ChatCircle size={16} />
            <span>New chat</span>
            <Plus size={14} />
          </button>

          <section className="mobile-drawer-section" aria-label="Workspace tools">
            <strong>Workspace</strong>
            <nav className="mobile-utilities" aria-label="Mobile workspace tools">
              {utilityItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.label} type="button" onClick={() => onSelectUtility(item.label)}>
                    <Icon size={15} />
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </section>

          <section className="mobile-drawer-section" aria-label="Projects">
            <strong>Projects</strong>
            {projects.map((project) => (
              <div className="mobile-project" key={project.id}>
                <span>
                  <FolderOpen size={14} />
                  {project.title}
                </span>
                {project.threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`thread-row thread-row--nested${
                      activeItem === thread.id ? " thread-row--active" : ""
                    }`}
                    onClick={() => onSelectProjectThread(thread, project.title)}
                  >
                    {thread.title}
                  </button>
                ))}
              </div>
            ))}
          </section>

          <section className="mobile-drawer-section" aria-label="Chats">
            <strong>Chats</strong>
            {chatThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={`thread-row${activeItem === thread.id ? " thread-row--active" : ""}`}
                onClick={() => onSelectThread(thread)}
              >
                {thread.title}
              </button>
            ))}
          </section>
        </div>
      ) : null}
    </aside>
  );
}
