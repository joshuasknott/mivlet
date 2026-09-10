import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { connectorGuides } from "./connector-guides";
import { findMarketplaceConnector, marketplaceConnectorSections } from "./marketplace-catalog";

export function PluginOverview({ id, access, onExample }: { id: string; access: string; onExample?: (prompt: string) => void }) {
  const guide = connectorGuides[id];
  const entry = findMarketplaceConnector(id);
  const category = marketplaceConnectorSections.find((section) => section.connectors.some((connector) => connector.id === id))?.title;
  return <div className="plugin-overview">
    {guide ? <section aria-label="Example prompts" className="plugin-overview__examples">
      <h3>Try asking</h3>
      <div>{guide.examples.slice(0, 3).map((example) => <button key={example} type="button" disabled={!onExample} title={onExample ? "Add to your conversation" : "Connect this plugin to use an example"} onClick={() => onExample?.(example)}><span>{example}</span><CaretRight size={16} aria-hidden="true" /></button>)}</div>
    </section> : null}
    <section className="plugin-overview__about">
      <h3>About this plugin</h3>
      <p>{guide?.description ?? entry?.description}</p>
      <dl><div><dt>Category</dt><dd>{category ?? "Tools"}</dd></div><div><dt>Access</dt><dd>{access}</dd></div></dl>
    </section>
  </div>;
}
