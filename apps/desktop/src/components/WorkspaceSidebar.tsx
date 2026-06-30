import { useState, useEffect, useRef } from "react";
import {
  CaretDown,
  CaretRight,
  Clock,
  DeviceMobile,
  FolderOpen,
  Gear,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
  CaretLeft,
  UserCircle,
  Plugs,
  Moon,
  LockKey,
  WarningCircle,
  SignOut
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { ProjectWorkspace, ThreadSummary } from "@fable/protocol";
import type { SettingsTab } from "./pages/SettingsPage";

/**
 * Workspace sidebar / shell navigation.
 */

export interface UtilityNavItem {
  label: string;
  icon: Icon;
}

const userSettingsTabs = [
  { id: "profile" as const, label: "Profile", icon: UserCircle },
  { id: "providers" as const, label: "Providers", icon: Plugs },
  { id: "appearance" as const, label: "Appearance", icon: Moon },
  { id: "privacy" as const, label: "Privacy", icon: LockKey },
  { id: "history" as const, label: "History", icon: Clock },
  { id: "notifications" as const, label: "Notifications", icon: WarningCircle }
];

export function WorkspaceSidebar({
  workspaceName,
  utilityItems,
  activeItem,
  expandedCollections,
  expandedProjects,
  projects,
  chatThreads,
  mobileNavOpen,
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
  onAccountMenu,
  loadingItemIds = [],
  profile,
  isSettingsActive = false,
  activeSettingsTab,
  onSelectSettingsTab,
  onCloseSettings
}: {
  workspaceName: string;
  utilityItems: readonly UtilityNavItem[];
  activeItem: string;
  expandedCollections: { projects: boolean; chats: boolean };
  expandedProjects: Record<string, boolean>;
  projects: ProjectWorkspace[];
  chatThreads: ThreadSummary[];
  mobileNavOpen: boolean;
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
  onAccountMenu: (item: "profile" | "settings" | "logout") => void;
  loadingItemIds?: string[];
  profile?: { name: string; email: string; photoInitials?: string; photoUrl?: string };
  isSettingsActive?: boolean;
  activeSettingsTab?: SettingsTab;
  onSelectSettingsTab?: (tab: SettingsTab) => void;
  onCloseSettings?: () => void;
}) {
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setWorkspaceDropdownOpen(false);
      }
    }
    if (workspaceDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [workspaceDropdownOpen]);

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
        <div className="sidebar-top-row">
          {isSettingsActive ? (
            <button
              type="button"
              className="workspace-switcher"
              aria-label="Settings"
              onClick={onCloseSettings}
            >
              <span className="workspace-switcher__name">
                Settings
              </span>
              <CaretLeft size={14} aria-hidden="true" />
            </button>
          ) : (
            <div className="workspace-switcher-container" ref={dropdownRef}>
              <button
                type="button"
                className="workspace-switcher workspace-switcher--workspace"
                aria-label="Select workspace"
                onClick={() => {
                  setWorkspaceDropdownOpen(!workspaceDropdownOpen);
                  onSelectWorkspace();
                }}
              >
                <span className="workspace-switcher__name">
                  {workspaceName}
                </span>
                <CaretDown size={12} className="workspace-switcher__caret" />
              </button>

              {workspaceDropdownOpen && (
                <div className="workspace-dropdown" role="menu">
                  <div className="workspace-dropdown__item workspace-dropdown__item--active">
                    <span className="workspace-dropdown__name">{workspaceName}</span>
                    <button
                      type="button"
                      className="workspace-dropdown__settings-btn"
                      aria-label="Workspace Settings"
                      title="Workspace Settings"
                      onClick={(e) => {
                        e.stopPropagation();
                        setWorkspaceDropdownOpen(false);
                        onAccountMenu("settings");
                        onSelectSettingsTab?.("workspace");
                      }}
                    >
                      <Gear size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
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
      </div>

      {isSettingsActive ? (
        <div className="sidebar-body">
          <section className="nav-group" aria-labelledby="personal-settings-nav-heading">
            <div className="nav-group-heading-row">
              <span className="nav-group-title nav-group-title--plain" id="personal-settings-nav-heading">
                <span>Personal</span>
              </span>
            </div>
            <div className="settings-sidebar-list" style={{ display: "grid", gap: "2px", marginTop: "8px" }}>
              {userSettingsTabs.map((tab) => {
                const active = activeSettingsTab === tab.id;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`sidebar-action-card utility-row${
                      active ? " utility-row--active" : ""
                    }`}
                    onClick={() => onSelectSettingsTab?.(tab.id)}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon size={17} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="nav-group" aria-labelledby="workspace-settings-nav-heading" style={{ marginTop: "16px" }}>
            <div className="nav-group-heading-row">
              <span className="nav-group-title nav-group-title--plain" id="workspace-settings-nav-heading">
                <span>Workspaces</span>
              </span>
            </div>
            <div className="settings-sidebar-list" style={{ display: "grid", gap: "2px", marginTop: "8px" }}>
              <button
                type="button"
                className={`sidebar-action-card utility-row settings-workspace-row${
                  activeSettingsTab === "workspace" ? " utility-row--active" : ""
                }`}
                onClick={() => onSelectSettingsTab?.("workspace")}
                aria-current={activeSettingsTab === "workspace" ? "page" : undefined}
              >
                <span>{workspaceName}</span>
              </button>
            </div>
          </section>

          <div className="settings-logout-wrapper" style={{ marginTop: "auto", display: "grid", gap: "8px" }}>
            <div className="sidebar-action-divider" aria-hidden="true" style={{ margin: "0 4px" }} />
            <div className="settings-sidebar-list" style={{ display: "grid", gap: "2px" }}>
              <button
                type="button"
                className="sidebar-action-card utility-row logout-button"
                onClick={() => onAccountMenu("logout")}
              >
                <SignOut size={17} />
                <span>Log Out</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
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
                    const projectLoading = loadingItemIds.includes(project.id) || project.threads.some(t => loadingItemIds.includes(t.id));
                    return (
                      <div className="project-block" key={project.id}>
                        <button
                          type="button"
                          className={`project-row${projectLoading ? " project-row--loading" : ""}`}
                          aria-expanded={expanded}
                          onClick={() => onToggleProject(project.id, project.title, expanded)}
                        >
                          <FolderOpen size={15} />
                          <span>{project.title}</span>
                        </button>
                        {expanded ? (
                          <div className="nested-thread-list">
                            {project.threads.map((thread) => {
                              const isActive = activeItem === thread.id;
                              const isThreadLoading = loadingItemIds.includes(thread.id);
                              return (
                                <button
                                  key={thread.id}
                                  type="button"
                                  className={`thread-row thread-row--nested${
                                    isActive ? " thread-row--active" : ""
                                  }${isThreadLoading ? " thread-row--loading" : ""}`}
                                  onClick={() => onSelectProjectThread(thread, project.title)}
                                >
                                  {thread.title}
                                </button>
                              );
                            })}
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
                  {chatThreads.map((thread) => {
                    const isActive = activeItem === thread.id;
                    const isThreadLoading = loadingItemIds.includes(thread.id);
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        className={`thread-row${isActive ? " thread-row--active" : ""}${
                          isThreadLoading ? " thread-row--loading" : ""
                        }`}
                        onClick={() => onSelectThread(thread)}
                      >
                        {thread.title}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </section>
          </div>
        </>
      )}

      <div className="sidebar-footer">
        <div className="sidebar-footer__identity">
          <span className="avatar" aria-hidden="true">
            {profile?.photoUrl ? (
              <img src={profile.photoUrl} alt="" />
            ) : (
              profile?.photoInitials ||
              (profile?.name
                ? profile.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
                : "J")
            )}
          </span>
          <strong className="sidebar-footer__name">{profile?.name || "Josh"}</strong>
        </div>
        <div className="sidebar-footer__actions">
          <button
            type="button"
            className="sidebar-footer__action"
            onClick={() => onAccountMenu("settings")}
            aria-label="Settings"
            title="Settings"
          >
            <Gear size={18} />
          </button>
          <button
            type="button"
            className="sidebar-footer__action"
            onClick={onOpenMobileConnection}
            aria-label="Mobile connection"
            title="Mobile connection"
          >
            <DeviceMobile size={18} />
          </button>
        </div>
      </div>

      {mobileNavOpen ? (
        <div className="mobile-drawer" aria-label="Mobile navigation">
          {isSettingsActive ? (
            <section className="mobile-drawer-section" aria-label="Settings">
              <strong>Settings</strong>
              <nav className="mobile-utilities" aria-label="Mobile settings">
                {userSettingsTabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        onSelectSettingsTab?.(tab.id);
                        onToggleMobileNav();
                      }}
                    >
                      <Icon size={15} />
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
            </section>
          ) : (
            <>
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
                    {project.threads.map((thread) => {
                      const isActive = activeItem === thread.id;
                      const isThreadLoading = loadingItemIds.includes(thread.id);
                      return (
                        <button
                          key={thread.id}
                          type="button"
                          className={`thread-row thread-row--nested${
                            isActive ? " thread-row--active" : ""
                          }${isThreadLoading ? " thread-row--loading" : ""}`}
                          onClick={() => onSelectProjectThread(thread, project.title)}
                        >
                          {thread.title}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </section>

              <section className="mobile-drawer-section" aria-label="Chats">
                <strong>Chats</strong>
                {chatThreads.map((thread) => {
                  const isActive = activeItem === thread.id;
                  const isThreadLoading = loadingItemIds.includes(thread.id);
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className={`thread-row${isActive ? " thread-row--active" : ""}${
                        isThreadLoading ? " thread-row--loading" : ""
                      }`}
                      onClick={() => onSelectThread(thread)}
                    >
                      {thread.title}
                    </button>
                  );
                })}
              </section>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
