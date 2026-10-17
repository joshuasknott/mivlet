/** Task-only deployment. No browser, computer, lifecycle or container binding. */
export interface TaskEnv extends HostedTaskBindings {
  MIVLET_HOSTED_TASK_SIGNING_KEY: string;
  MIVLET_HOSTED_TASK_ENCRYPTION_KEY: string;
  /** Optional private Paid service; absent in the operational Free deployment. */
  CODING_RUNTIME?: import("./coding-runtime-contract").CodingRuntimeBinding;
}
