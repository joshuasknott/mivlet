import type { ReactNode } from "react";

export function PluginDetailHeader({ name, description, icon, status, statusClass, titleId }: {
  name: string;
  description?: string;
  icon: ReactNode;
  status: string;
  statusClass?: string;
  titleId?: string;
}) {
  return <>
    <p className="connector-detail__eyebrow">Plugins</p>
    <div className="connector-detail__header">
      {icon}
      <div><h2 id={titleId}>{name}</h2>{description ? <p>{description}</p> : null}</div>
      <span className={`connector-detail__status${statusClass ? ` connector-detail__status--${statusClass}` : ""}`}>{status}</span>
    </div>
  </>;
}
