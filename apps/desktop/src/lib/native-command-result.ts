import type { NativeCommandJob } from "@mivlet/protocol";
/** Display discovery only. Native scope/epoch/job verification precedes controls. */
export function nativeCommandResult(tool: string, output: string): Pick<NativeCommandJob, "id" | "generation"> | null {
  if (!["repository-start", "workspace-start"].includes(tool) || output.length > 128 * 1024) return null;
  try {
    const job = JSON.parse(output)?.job;
    return job && typeof job.id === "string" && /^[a-f0-9]{48}$/.test(job.id)
      && Number.isSafeInteger(job.generation) && job.generation > 0 ? { id: job.id, generation: job.generation } : null;
  } catch { return null; }
}
