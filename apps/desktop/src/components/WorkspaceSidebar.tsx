import { useState, useEffect, useMemo, useRef } from "react";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { DeviceMobile } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plugs } from "@phosphor-icons/react/dist/csr/Plugs";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SignOut } from "@phosphor-icons/react/dist/csr/SignOut";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { Icon } from "@phosphor-icons/react/dist/lib/types";
import type { ProjectWorkspace, ThreadSummary } from "@fable/protocol";
import type { SettingsTab } from "./pages/settings-tabs";

/**
 * Workspace sidebar / shell navigation.
 */

export interface UtilityNavItem {
  label: string;
  icon: Icon;
}

const userSettingsTabs = [
  { id: "general" as const, label: "General", icon: UserCircle },
  { id: "providers" as const, label: "Providers", icon: Plugs },
  { id: "privacy" as const, label: "Privacy & Permissions", icon: ShieldCheck },
  { id: "history" as const, label: "History", icon: Clock }
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
  onOpenProjectFolder,
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
  onOpenWorkspaceSettings,
  onSelectThread,
  onAccountMenu,
  loadingItemIds = [],
  profile,
  isSettingsActive = false,
  activeSettingsTab,
  onSelectSettingsTab,
  onCloseSettings,
  canNavigateBack = false,
  canNavigateForward = false,
  onNavigateBack,
  onNavigateForward
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
  onOpenProjectFolder: () => void;
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
  onOpenWorkspaceSettings: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onAccountMenu: (item: "profile" | "settings" | "logout") => void;
  loadingItemIds?: string[];
  profile?: { name: string; email: string; photoInitials?: string; photoUrl?: string };
  isSettingsActive?: boolean;
  activeSettingsTab?: SettingsTab;
  onSelectSettingsTab?: (tab: SettingsTab) => void;
  onCloseSettings?: () => void;
  canNavigateBack?: boolean;
  canNavigateForward?: boolean;
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
}) {
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [chatFlyoutOpen, setChatFlyoutOpen] = useState(false);
  const [chatHistoryModalOpen, setChatHistoryModalOpen] = useState(false);
  const [chatHistorySearch, setChatHistorySearch] = useState("");
  const [settingsSearch, setSettingsSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const chatFlyoutRef = useRef<HTMLDivElement>(null);
  const normalizedSettingsSearch = settingsSearch.trim().toLocaleLowerCase();
  const visibleSettingsTabs = useMemo(
    () =>
      userSettingsTabs.filter((tab) =>
        tab.label.toLocaleLowerCase().includes(normalizedSettingsSearch)
      ),
    [normalizedSettingsSearch]
  );
  const hasProjects = projects.length > 0;
  const hasChats = chatThreads.length > 0;
  const normalizedChatSearch = chatHistorySearch.trim().toLocaleLowerCase();
  const filteredChatThreads = useMemo(
    () =>
      chatThreads.filter((thread) =>
        thread.title.toLocaleLowerCase().includes(normalizedChatSearch)
      ),
    [chatThreads, normalizedChatSearch]
  );
  const recentChatThreads = useMemo(() => chatThreads.slice(0, 6), [chatThreads]);

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

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (chatFlyoutRef.current && !chatFlyoutRef.current.contains(event.target as Node)) {
        setChatFlyoutOpen(false);
      }
    }
    if (chatFlyoutOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [chatFlyoutOpen]);

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
        {isSettingsActive ? (
          <>
            <div className="sidebar-top-row">
              <span className="sidebar-brand">
                <img
                  className="sidebar-brand__mark"
                  src="/brand/fable-tech-dragon-transparent.png"
                  alt="Fable"
                />
              </span>
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
            <button
              type="button"
              className="workspace-switcher settings-back-button"
              aria-label="Back"
              onClick={onCloseSettings}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              <span className="workspace-switcher__name">
                Back
              </span>
            </button>
          </>
        ) : (
          <>
            <div className="sidebar-top-row">
              <span className="sidebar-brand">
                <img
                  className="sidebar-brand__mark"
                  src="/brand/fable-tech-dragon-transparent.png"
                  alt="Fable"
                />
              </span>
              <div className="sidebar-history-controls" aria-label="Navigation history">
                <button
                  type="button"
                  aria-label="Back"
                  disabled={!canNavigateBack}
                  onClick={onNavigateBack}
                >
                  <ArrowLeft size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Forward"
                  disabled={!canNavigateForward}
                  onClick={onNavigateForward}
                >
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
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
            <div
              className={`workspace-switcher-container workspace-switcher-container--top${workspaceDropdownOpen ? " workspace-switcher-container--open" : ""}`}
              ref={dropdownRef}
            >
              <button
                type="button"
                className="workspace-switcher workspace-switcher--workspace"
                aria-label="Select workspace"
                aria-expanded={workspaceDropdownOpen}
                onClick={() => {
                  setWorkspaceDropdownOpen(!workspaceDropdownOpen);
                  onSelectWorkspace();
                }}
              >
                <span className="workspace-switcher__name">{workspaceName}</span>
                <CaretDown size={12} className="workspace-switcher__caret" />
              </button>

              {workspaceDropdownOpen ? (
                <div className="workspace-dropdown" role="menu">
                  <div className="workspace-dropdown__item workspace-dropdown__item--active">
                    <span className="workspace-dropdown__name">{workspaceName}</span>
                  </div>
                  <div className="workspace-dropdown__divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="workspace-dropdown__settings-card"
                    role="menuitem"
                    onClick={() => {
                      setWorkspaceDropdownOpen(false);
                      onOpenWorkspaceSettings();
                    }}
                  >
                    <Gear size={15} />
                    <span>Workspace settings</span>
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      {isSettingsActive ? (
        <>
          <button
            className="mobile-nav-toggle"
            type="button"
            aria-label="Open settings navigation"
            aria-expanded={mobileNavOpen}
            onClick={onToggleMobileNav}
          >
            <SidebarSimple size={20} />
          </button>
          <div className="sidebar-body">
            <label className="settings-sidebar-search">
              <MagnifyingGlass size={15} aria-hidden="true" />
              <span className="sr-only">Search Settings</span>
              <input
                type="search"
                placeholder="Search Settings"
                value={settingsSearch}
                onChange={(event) => setSettingsSearch(event.target.value)}
              />
            </label>
          {visibleSettingsTabs.length > 0 ? (
            <section className="nav-group" aria-labelledby="personal-settings-nav-heading">
            <div className="nav-group-heading-row">
              <span className="nav-group-title nav-group-title--plain" id="personal-settings-nav-heading">
                <span>Personal</span>
              </span>
            </div>
            <div className="settings-sidebar-list" style={{ display: "grid", gap: "2px", marginTop: "8px" }}>
              {visibleSettingsTabs.map((tab) => {
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
          ) : null}

          {visibleSettingsTabs.length === 0 ? (
            <p className="settings-sidebar-empty">No settings found</p>
          ) : null}

          <div className="settings-logout-wrapper" style={{ marginTop: "auto", display: "grid", gap: "8px" }}>
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
        </>
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
            <NotePencil size={18} />
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
            <section className="nav-group" aria-labelledby="threads-heading">
              <div className="nav-group-heading-row">
                {hasProjects ? (
                  <button
                    type="button"
                    className="nav-group-heading nav-group-heading--plain"
                    id="threads-heading"
                    aria-expanded={expandedCollections.projects}
                    onClick={onToggleProjects}
                  >
                      <span className="nav-group-title nav-group-title--plain">
                      <span>Projects</span>
                    </span>
                    <CaretRight className="collection-caret" size={13} weight="bold" />
                  </button>
                ) : (
                  <span className="nav-group-heading nav-group-heading--plain" id="threads-heading">
                    <span className="nav-group-title nav-group-title--plain">
                      <span>Projects</span>
                    </span>
                  </span>
                )}
                <div className="nav-group-add-wrap">
                  <button
                    type="button"
                    className="nav-group-add"
                    aria-label="Add project"
                    aria-expanded={projectCreateOpen}
                    onClick={() => setProjectCreateOpen((open) => !open)}
                  >
                    <Plus size={13} weight="bold" />
                  </button>
                  {projectCreateOpen ? (
                    <div className="project-create-menu" role="menu" aria-label="Add project">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProjectCreateOpen(false);
                          onOpenProjectFolder();
                        }}
                      >
                        <FolderOpen size={15} />
                        <span>Open folder</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProjectCreateOpen(false);
                          onAddProject();
                        }}
                      >
                        <NotePencil size={15} />
                        <span>Start from scratch</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              {hasProjects && expandedCollections.projects ? (
                <div className="project-list">
                  {projects.map((project) => {
                    const expanded = expandedProjects[project.id];
                    const projectLoading = loadingItemIds.includes(project.id) || project.threads.some(t => loadingItemIds.includes(t.id));
                    return (
                      <div className="project-block" key={project.id}>
                        {project.threads.length > 0 ? (
                          <button
                            type="button"
                            className={`project-row${projectLoading ? " project-row--loading" : ""}`}
                            aria-expanded={expanded}
                            onClick={() => onToggleProject(project.id, project.title, expanded)}
                          >
                            <FolderOpen size={15} />
                            <span>{project.title}</span>
                          </button>
                        ) : (
                          <div className="project-row">
                            <FolderOpen size={15} />
                            <span>{project.title}</span>
                          </div>
                        )}
                        {project.threads.length > 0 && expanded ? (
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
          </div>

          <div className="sidebar-chat-dock" ref={chatFlyoutRef}>
            <div className="sidebar-chat-dock__row">
              <button
                type="button"
                className="sidebar-action-card sidebar-chat-dock__toggle"
                aria-expanded={chatFlyoutOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setChatFlyoutOpen((open) => !open);
                  if (!chatFlyoutOpen) {
                    onToggleChats();
                  }
                }}
              >
                <span>Chats</span>
                <CaretRight className="collection-caret" size={13} weight="bold" />
              </button>
              <button
                type="button"
                className="nav-group-add sidebar-chat-dock__add"
                aria-label="Add chat"
                onClick={onNewChat}
              >
                <Plus size={13} weight="bold" />
              </button>
            </div>
            {chatFlyoutOpen ? (
              <div className="chat-flyout" role="menu" aria-label="Recent chats">
                <div className="chat-flyout__header">
                  <strong>Recent chats</strong>
                  <button type="button" onClick={onNewChat}>
                    <NotePencil size={14} />
                    New chat
                  </button>
                </div>
                {hasChats ? (
                  <div className="chat-flyout__list">
                    {recentChatThreads.map((thread) => {
                      const isActive = activeItem === thread.id;
                      const isThreadLoading = loadingItemIds.includes(thread.id);
                      return (
                        <button
                          key={thread.id}
                          type="button"
                          role="menuitem"
                          className={`thread-row${isActive ? " thread-row--active" : ""}${
                            isThreadLoading ? " thread-row--loading" : ""
                          }`}
                          onClick={() => {
                            setChatFlyoutOpen(false);
                            onSelectThread(thread);
                          }}
                        >
                          {thread.title}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="chat-flyout__empty">No chats yet</p>
                )}
                <button
                  type="button"
                  className="chat-flyout__more"
                  onClick={() => {
                    setChatFlyoutOpen(false);
                    setChatHistoryModalOpen(true);
                  }}
                >
                  Search more chats
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}

      <div className="sidebar-footer-area">
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
      </div>

      {mobileNavOpen ? (
        <div className="mobile-drawer" aria-label="Mobile navigation">
          {isSettingsActive ? (
            <section className="mobile-drawer-section" aria-label="Settings">
              <button
                type="button"
                className="mobile-settings-back"
                onClick={() => {
                  onCloseSettings?.();
                  onToggleMobileNav();
                }}
              >
                <ArrowLeft size={15} />
                Back
              </button>
              <label className="settings-sidebar-search settings-sidebar-search--mobile">
                <MagnifyingGlass size={15} aria-hidden="true" />
                <span className="sr-only">Search Settings</span>
                <input
                  type="search"
                  placeholder="Search Settings"
                  value={settingsSearch}
                  onChange={(event) => setSettingsSearch(event.target.value)}
                />
              </label>
              <nav className="mobile-utilities" aria-label="Mobile settings">
                {visibleSettingsTabs.map((tab) => {
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
              {visibleSettingsTabs.length === 0 ? (
                <p className="settings-sidebar-empty">No settings found</p>
              ) : null}
            </section>
          ) : (
            <>
              <button className="mobile-new-chat" type="button" onClick={onNewChat}>
                <NotePencil size={17} />
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

      {chatHistoryModalOpen ? (
        <div className="chat-history-modal" role="dialog" aria-modal="true" aria-labelledby="chat-history-title">
          <div className="chat-history-modal__panel">
            <div className="chat-history-modal__header">
              <div>
                <h2 id="chat-history-title">Chat history</h2>
                <p>Search or browse older chats.</p>
              </div>
              <button
                type="button"
                className="chat-history-modal__close"
                aria-label="Close chat history"
                onClick={() => setChatHistoryModalOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <label className="chat-history-modal__search">
              <MagnifyingGlass size={15} aria-hidden="true" />
              <span className="sr-only">Search chats</span>
              <input
                type="search"
                placeholder="Search chats"
                value={chatHistorySearch}
                onChange={(event) => setChatHistorySearch(event.target.value)}
              />
            </label>
            <div className="chat-history-modal__list">
              {filteredChatThreads.length > 0 ? (
                filteredChatThreads.map((thread) => {
                  const isActive = activeItem === thread.id;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className={`thread-row${isActive ? " thread-row--active" : ""}`}
                      onClick={() => {
                        setChatHistoryModalOpen(false);
                        onSelectThread(thread);
                      }}
                    >
                      {thread.title}
                    </button>
                  );
                })
              ) : (
                <p className="chat-history-modal__empty">No chats found</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
