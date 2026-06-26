import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * Shared page chrome for the standalone workspace pages (Knowledge,
 * Automations, Plugins). Gives each page a consistent, minimal header with an
 * icon, title, supporting copy, and an optional actions slot.
 */
export function PageHeader({
  icon: Icon,
  title,
  description,
  meta,
  actions
}: {
  icon: Icon;
  title: string;
  description: string;
  meta?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__lead">
        <span className="page-header__icon" aria-hidden="true">
          <Icon size={22} weight="regular" />
        </span>
        <div>
          <h1 className="page-header__title">{title}</h1>
          <p className="page-header__description">{description}</p>
        </div>
      </div>
      {(meta || actions) && (
        <div className="page-header__meta">
          {meta ? <span className="page-header__count">{meta}</span> : null}
          {actions}
        </div>
      )}
    </header>
  );
}
