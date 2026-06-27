import { Stack } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";

/**
 * Standalone Knowledge page placeholder while the full source and memory
 * workspace is being rebuilt.
 */
export function KnowledgePage() {
  return (
    <>
      <PageHeader
        icon={Stack}
        title="Knowledge"
        description="Coming soon."
        meta="Coming soon"
      />
      <section className="coming-soon-panel" aria-label="Knowledge coming soon">
        <p>Coming soon</p>
      </section>
    </>
  );
}
