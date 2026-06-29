import { builtInDepartments, planDepartmentPipeline } from "@fable/connectors";
import { CheckCircle, LockKey, Plugs, WarningCircle } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

export function DepartmentsPage({ runtime }: { runtime: ShellRuntime }) {
  const connectedConnectorIds = runtime.connectorManifests
    .filter((connector) => connector.status === "connected")
    .map((connector) => connector.id);
  const departments = builtInDepartments("2026-06-29T00:00:00.000Z");

  return (
    <section className="departments-page">
      <PageHeader
        title="Departments"
        description="Pipeline lanes that route through Knowledge, connectors, schedules, and the selected agent backend."
      />
      <div className="department-list">
        {departments.map((department) => (
          <section className="department-section" key={department.id} aria-labelledby={`${department.id}-title`}>
            <div className="department-section__heading">
              <h2 id={`${department.id}-title`}>{department.name}</h2>
              <p>{department.summary}</p>
            </div>
            <div className="department-pipelines">
              {department.pipelines.map((pipeline) => {
                const plan = planDepartmentPipeline(pipeline, connectedConnectorIds);
                return (
                  <article className="department-pipeline" key={pipeline.id}>
                    <div className="department-pipeline__top">
                      <div>
                        <strong>{pipeline.name}</strong>
                        <span>{pipeline.description}</span>
                      </div>
                      <span className={`department-status${plan.runnable ? " is-ready" : " is-blocked"}`}>
                        {plan.runnable ? <CheckCircle size={15} /> : <WarningCircle size={15} />}
                        {plan.runnable ? "Ready" : "Needs setup"}
                      </span>
                    </div>

                    <ol className="department-steps">
                      {pipeline.steps.map((step) => (
                        <li key={step.id}>
                          <strong>{step.title}</strong>
                          <span>{step.description}</span>
                        </li>
                      ))}
                    </ol>

                    <div className="department-meta-grid">
                      <div>
                        <span className="department-meta-label">
                          <Plugs size={14} /> Connectors
                        </span>
                        <p>
                          {pipeline.connectorNeeds
                            .map((need) => `${need.connectorId} ${need.access}${need.optional ? " optional" : ""}`)
                            .join(", ")}
                        </p>
                      </div>
                      <div>
                        <span className="department-meta-label">
                          <LockKey size={14} /> Approval
                        </span>
                        <p>{pipeline.approvalRequirement.reason}</p>
                      </div>
                    </div>

                    {plan.missingConnectors.length > 0 ? (
                      <p className="department-warning">
                        Connect {plan.missingConnectors.map((need) => need.connectorId).join(", ")} before running this lane.
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
