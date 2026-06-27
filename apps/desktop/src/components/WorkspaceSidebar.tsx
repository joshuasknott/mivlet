import {
  CaretDown,
  CaretRight,
  DeviceMobile,
  FolderOpen,
  Gear,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
  Stack,
  SignOut,
  User
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { ProjectWorkspace, ThreadSummary } from "@arden/protocol";

/**
 * Workspace sidebar / shell navigation.
 */

export interface UtilityNavItem {
  label: string;
  icon: Icon;
}

export function WorkspaceSidebar({
  workspaceName,
  utilityItems,
  activeItem,
  expandedCollections,
  expandedProjects,
  projects,
  chatThreads,
  mobileNavOpen,
  accountOpen,
  collapsed,
  onNewChat,
  onAddProject,
  onSearch,
  onSelectWorkspace,
  onToggleProjects,
  onToggleChats,
  onSelectUtility,
  onSelectProjectThread,
  onToggleProject,
  onToggleMobileNav,
  onToggleCollapsed,
  onOpenMobileConnection,
  onSelectThread,
  onToggleAccount,
  onAccountMenu
}: {
  workspaceName: string;
  utilityItems: readonly UtilityNavItem[];
  activeItem: string;
  expandedCollections: { projects: boolean; chats: boolean };
  expandedProjects: Record<string, boolean>;
  projects: ProjectWorkspace[];
  chatThreads: ThreadSummary[];
  mobileNavOpen: boolean;
  accountOpen: boolean;
  collapsed: boolean;
  onNewChat: () => void;
  onAddProject: () => void;
  onSearch: () => void;
  onSelectWorkspace: () => void;
  onToggleProjects: () => void;
  onToggleChats: () => void;
  onSelectUtility: (label: string) => void;
  onSelectProjectThread: (thread: ThreadSummary, projectTitle: string) => void;
  onToggleProject: (projectId: string, projectTitle: string, expanded: boolean) => void;
  onToggleMobileNav: () => void;
  onToggleCollapsed: () => void;
  onOpenMobileConnection: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onToggleAccount: () => void;
  onAccountMenu: (item: "profile" | "settings" | "logout") => void;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        className="sidebar-reopen-card"
        aria-label="Open sidebar"
        aria-pressed="true"
        onClick={onToggleCollapsed}
      >
        <SidebarSimple size={18} />
      </button>
    );
  }

  return (
    <aside className="sidebar" aria-label="Workspace navigation">
      <div className="sidebar-header">
        <span className="sidebar-brand">arden</span>
        <button
          type="button"
          className="sidebar-minimize"
          aria-label="Close sidebar"
          aria-pressed="false"
          onClick={onToggleCollapsed}
        >
          <SidebarSimple size={18} />
        </button>
      </div>

      <div className="workspace-scope" aria-label="Workspace scope">
        <button
          type="button"
          className="workspace-switcher"
          aria-label="Select workspace"
          onClick={onSelectWorkspace}
        >
          <span className="workspace-switcher__icon" aria-hidden="true">
            <Stack size={16} />
          </span>
          <span className="workspace-switcher__copy">
            <span>Workspace</span>
            <strong>{workspaceName}</strong>
          </span>
          <CaretDown size={14} />
        </button>
      </div>

          <button
            className="mobile-nav-toggle"
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            onClick={onToggleMobileNav}
          >
            <SidebarSimple size={20} />
          </button>

          <button
            className="new-chat-button"
            type="button"
            onClick={onNewChat}
            aria-keyshortcuts="Control+N Meta+N"
          >
            <Plus size={18} weight="bold" />
            <span>New chat</span>
          </button>

          <div className="sidebar-action-stack">
            <button
              className="sidebar-action-card sidebar-action-card--search"
              type="button"
              onClick={onSearch}
              aria-keyshortcuts="Control+K Meta+K"
            >
              <MagnifyingGlass size={16} />
              <span>Search</span>
            </button>
            <div className="sidebar-action-divider" aria-hidden="true" />
            <nav className="primary-utility-nav" aria-label="Tools">
              {utilityItems.map((item) => {
                const Icon = item.icon;
                const active = activeItem === item.label;
                return (
                  <button
                    key={item.label}
                    type="button"
                    className={`sidebar-action-card utility-row${
                      active ? " utility-row--active" : ""
                    }`}
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
              <div className="nav-group-heading-row">
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
                <button
                  type="button"
                  className="nav-group-add"
                  aria-label="Add project"
                  onClick={onAddProject}
                >
                  <Plus size={13} weight="bold" />
                </button>
              </div>
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
              <div className="nav-group-heading-row">
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
                <button
                  type="button"
                  className="nav-group-add"
                  aria-label="Add chat"
                  onClick={onNewChat}
                >
                  <Plus size={13} weight="bold" />
                </button>
              </div>
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
            <div className="account-menu-anchor">
              <button
                type="button"
                className={`account-row${accountOpen ? " account-row--open" : ""}`}
                onClick={onToggleAccount}
                aria-expanded={accountOpen}
                aria-haspopup="menu"
              >
                <span className="avatar">J</span>
                <span className="account-row__text">
                  <strong>Josh</strong>
                  <span className="account-row__email">josh@example.com</span>
                </span>
              </button>
              {accountOpen ? (
                <div className="account-popover" role="menu" aria-label="Josh account menu">
                  <button type="button" role="menuitem" onClick={() => onAccountMenu("profile")}>
                    <span className="account-popover__icon" aria-hidden="true">
                      <User size={16} />
                    </span>
                    <span>Profile</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => onAccountMenu("settings")}>
                    <span className="account-popover__icon" aria-hidden="true">
                      <Gear size={16} />
                    </span>
                    <span>Settings</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="account-popover__logout"
                    onClick={() => onAccountMenu("logout")}
                  >
                    <span className="account-popover__icon" aria-hidden="true">
                      <SignOut size={16} />
                    </span>
                    <span>Log out</span>
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="mobile-connection-card"
              onClick={onOpenMobileConnection}
              aria-label="Mobile connection"
              title="Mobile connection"
            >
              <DeviceMobile size={18} />
            </button>
          </div>

          {mobileNavOpen ? (
            <div className="mobile-drawer" aria-label="Mobile navigation">
              <button className="mobile-new-chat" type="button" onClick={onNewChat}>
                <Plus size={16} weight="bold" />
                <span>New chat</span>
              </button>

              <section className="mobile-drawer-section" aria-label="Tools">
                <strong>Tools</strong>
                <nav className="mobile-utilities" aria-label="Mobile tools">
                  {utilityItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => onSelectUtility(item.label)}
                      >
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
