/** Task-only deployment. No browser, computer, lifecycle or container binding. */
export interface TaskEnv extends HostedTaskBindings {
  MIVLET_HOSTED_TASK_SIGNING_KEY: string;
  MIVLET_HOSTED_TASK_ENCRYPTION_KEY: string;
}
