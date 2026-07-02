import type { Icon } from "@phosphor-icons/react/dist/lib/types";
import type { ReactNode } from "react";

/**
 * Shared page chrome for the standalone workspace pages (Connectors,
 * Knowledge, Schedules). Gives each page a consistent, minimal header with a
 * title, supporting copy, and optional icon and actions slots.
 */
export function PageHeader({
  icon: Icon,
  title,
  description,
  meta,
  actions
}: {
  icon?: Icon;
  title: string;
  description?: string;
  meta?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__lead">
        {Icon ? (
          <span className="page-header__icon" aria-hidden="true">
            <Icon size={22} weight="regular" />
          </span>
        ) : null}
        <div>
          <h1 className="page-header__title">{title}</h1>
          {description ? <p className="page-header__description">{description}</p> : null}
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
