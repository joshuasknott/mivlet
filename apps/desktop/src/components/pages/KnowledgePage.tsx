import { Stack } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";

/**
 * Standalone Knowledge page. Intentionally blank while the source and memory
 * workspace is being rebuilt — no mock sources or memory are rendered here.
 */
export function KnowledgePage() {
  return (
    <>
      <PageHeader
        icon={Stack}
        title="Knowledge"
        description="Sources and memory you pin to your workspace will live here."
      />
      <section className="empty-state" aria-label="Knowledge is empty">
        <p>Nothing here yet.</p>
      </section>
    </>
  );
}
