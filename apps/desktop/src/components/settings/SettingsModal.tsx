import { useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { Desktop } from "@phosphor-icons/react/dist/csr/Desktop";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { tabs, type SettingsTab } from "../pages/settings-tabs";

export function SettingsModal({ activeTab, onSelectTab, onClose, children }: {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useModalFocusTrap({ active: true, containerRef: ref, onClose });
  return <div className="settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={ref} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" tabIndex={-1}>
      <aside className="settings-modal__nav" aria-label="Settings sections">
        <strong className="settings-modal__label">Settings</strong>
        <nav className="settings-modal__tab-list" aria-label="Settings">
          {tabs.map((tab) => <button key={tab.id} type="button"
            className={`settings-modal__tab${activeTab === tab.id ? " settings-modal__tab--active" : ""}`}
            aria-current={activeTab === tab.id ? "page" : undefined} onClick={() => onSelectTab(tab.id)}>
            {tab.id === "general" ? <Gear size={18} aria-hidden="true" /> : tab.id === "providers" ? <PlugsConnected size={18} aria-hidden="true" /> : tab.id === "connections" ? <Desktop size={18} aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
            {tab.label}</button>)}
        </nav>
      </aside>
      <div className="settings-modal__content">
        <button type="button" className="settings-modal__close" aria-label="Close settings" onClick={onClose}><X size={18} /></button>
        {children}
      </div>
    </section>
  </div>;
}
