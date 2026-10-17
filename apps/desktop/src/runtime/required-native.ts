import { getRuntimeAdapter } from "./adapters/select";
import { toRuntimeError } from "./errors";

/** Commands that require native storage keep their own prerequisite message. */
export async function invokeRequiredNative<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  prerequisite: string,
): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native") throw new Error(prerequisite);
  try {
    return await adapter.invoke<T>(command, args);
  } catch (error) {
    throw toRuntimeError(error);
  }
}
