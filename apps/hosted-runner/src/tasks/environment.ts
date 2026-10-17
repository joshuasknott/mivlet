import type { ProviderCustody } from "./provider-custody";
import type { TaskAuthority } from "./task-authority";

/** Task-only deployment. No browser, computer, lifecycle or container binding. */
export interface TaskEnv {
  TASK_AUTHORITY: DurableObjectNamespace<TaskAuthority>;
  PROVIDER_CUSTODY: DurableObjectNamespace<ProviderCustody>;
  MIVLET_HOSTED_TASK_SIGNING_KEY: string;
  MIVLET_HOSTED_TASK_ENCRYPTION_KEY: string;
}
