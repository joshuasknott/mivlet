import { GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { PageHeader } from "../PageHeader";

export function DepartmentsPage() {
  return (
    <section className="departments-page">
      <PageHeader
        title="Departments"
        description="Purpose-built teams of agents for repeatable work."
      />
      <div className="run-empty departments-coming-soon" role="status">
        <GitBranch size={22} aria-hidden="true" />
        <p className="run-empty__title">Coming soon</p>
        <p className="run-empty__hint">Departments are in development and are not available yet.</p>
      </div>
    </section>
  );
}
