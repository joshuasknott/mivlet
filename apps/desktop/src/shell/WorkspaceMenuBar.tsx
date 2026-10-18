import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { SidebarMenu } from "../components/agents/SidebarMenu";
import "./workspace-menu-bar.css";

export function WorkspaceMenuBar({ canGoBack, canGoForward, onBack, onForward,
  onNewConversation, onNewProject, onSettings, onSearch, onSingleView, onTheme, theme }: {
  canGoBack: boolean; canGoForward: boolean;
  onBack: () => void; onForward: () => void;
  onNewConversation: () => void; onNewProject: () => void;
  onSettings: () => void; onSearch: () => void; onSingleView: () => void;
  onTheme: (theme: "light" | "dark") => void; theme: "light" | "dark";
}) {
  return (
    <nav className="workspace-menu-bar" aria-label="Application">
      <button type="button" aria-label="Go back" title="Go back" disabled={!canGoBack} onClick={onBack}><ArrowLeft size={15} /></button>
      <button type="button" aria-label="Go forward" title="Go forward" disabled={!canGoForward} onClick={onForward}><ArrowRight size={15} /></button>
      <SidebarMenu label="File" triggerContent="File" triggerClassName="workspace-menu-bar__menu" items={[
        { label: "New chat", run: onNewConversation },
        { label: "New project", run: onNewProject },
        { label: "Settings", run: onSettings },
      ]} />
      <SidebarMenu label="View" triggerContent="View" triggerClassName="workspace-menu-bar__menu" items={[
        { label: "Search", run: onSearch },
        { label: "Single conversation", run: onSingleView },
        { label: "Light appearance", checked: theme === "light", run: () => onTheme("light") },
        { label: "Dark appearance", checked: theme === "dark", run: () => onTheme("dark") },
      ]} />
      <SidebarMenu label="Help" triggerContent="Help" triggerClassName="workspace-menu-bar__menu" items={[
        { label: "Search · Ctrl K", run: onSearch },
        { label: "Single conversation · Ctrl Shift \\", run: onSingleView },
      ]} />
    </nav>
  );
}
