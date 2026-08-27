import { getSandbox } from "@cloudflare/sandbox";
import { runWithTools } from "@cloudflare/ai-utils";
import type {
  HostedAgentRoutineRequest,
  HostedAgentRoutineToolRunSnapshot
} from "@fable/protocol";

const DEFAULT_HOSTED_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_TOOL_RESULT_CHARACTERS = 16_000;
const MAX_FINAL_RESULT_CHARACTERS = 12_000;
const MAX_WRITE_CHARACTERS = 64_000;
const MAX_PROCESS_OUTPUT_BYTES = 32 * 1024;

type HostedSandbox = ReturnType<typeof getSandbox>;
type RunWithTools = typeof runWithTools;

export interface HostedAgentExecutionResult {
  result: string;
  tools: HostedAgentRoutineToolRunSnapshot[];
}

export interface HostedAgentExecutionDependencies {
  /** Kept opaque because Wrangler's generated runtime types can be newer than
   * ai-utils' bundled declaration while representing the same binding. */
  ai: unknown;
  sandbox: HostedSandbox;
  request: HostedAgentRoutineRequest;
  model?: Parameters<RunWithTools>[1];
  runWithToolsImpl?: RunWithTools;
}

/**
 * Execute one bounded natural-language turn inside the user's isolated hosted
 * workspace. The routine's standing capabilities determine which tools exist;
 * the model cannot broaden them at run time.
 */
export async function executeHostedAgentRoutine({
  ai,
  sandbox,
  request,
  model = DEFAULT_HOSTED_MODEL,
  runWithToolsImpl = runWithTools
}: HostedAgentExecutionDependencies): Promise<HostedAgentExecutionResult> {
  const evidence: HostedAgentRoutineToolRunSnapshot[] = [];
  const toolBudget = request.maxSteps;

  const record = async (
    tool: HostedAgentRoutineToolRunSnapshot["tool"],
    summary: string,
    operation: () => Promise<string>
  ): Promise<string> => {
    if (evidence.length >= toolBudget) {
      const refusal = "The routine reached its approved tool-step limit.";
      evidence.push({ tool, summary: bounded(summary, 240), status: "failed" });
      return JSON.stringify({ ok: false, error: refusal });
    }
    try {
      const value = await operation();
      evidence.push({ tool, summary: bounded(summary, 240), status: "completed" });
      return bounded(value, MAX_TOOL_RESULT_CHARACTERS);
    } catch (error) {
      evidence.push({ tool, summary: bounded(summary, 240), status: "failed" });
      return JSON.stringify({ ok: false, error: safeToolError(error) });
    }
  };

  const tools: Parameters<RunWithTools>[2]["tools"] = [];
  if (request.capabilities.includes("workspace-read")) {
    tools.push({
      name: "workspace_list",
      description: "List files and directories under /workspace. Use only paths under /workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path under /workspace." },
          recursive: { type: "boolean", description: "Whether to include descendants." }
        },
        required: ["path"]
      },
      function: async (args: unknown) => {
        const value = recordArgs(args);
        const path = workspacePath(value.path);
        const recursive = value.recursive === true;
        return record("workspace-list", `${recursive ? "Recursively listed" : "Listed"} ${path}`, async () => {
          const listed = await sandbox.listFiles(path, { recursive, includeHidden: false });
          const files = listed.files.slice(0, 200).map((file) => ({
            path: file.absolutePath,
            type: file.type,
            size: file.size,
            modifiedAt: file.modifiedAt
          }));
          return JSON.stringify({ ok: listed.success, files, truncated: listed.files.length > files.length });
        });
      }
    });
    tools.push({
      name: "workspace_read",
      description: "Read one UTF-8 text file under /workspace. Binary files and internal .fable state are unavailable.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute text-file path under /workspace." }
        },
        required: ["path"]
      },
      function: async (args: unknown) => {
        const path = workspacePath(recordArgs(args).path, false);
        return record("workspace-read", `Read ${path}`, async () => {
          const file = await sandbox.readFile(path, { encoding: "utf8" });
          if (!file.success || file.isBinary) throw new Error("workspace-file-unreadable");
          if ((file.size ?? new TextEncoder().encode(file.content).byteLength) > 64 * 1024) {
            throw new Error("workspace-file-too-large");
          }
          return JSON.stringify({ ok: true, path, content: bounded(file.content, MAX_TOOL_RESULT_CHARACTERS) });
        });
      }
    });
  }
  if (request.capabilities.includes("workspace-write")) {
    tools.push({
      name: "workspace_write",
      description: "Atomically replace one UTF-8 text file under /workspace. This cannot write Fable's internal .fable state.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute target path under /workspace." },
          content: { type: "string", description: "Complete UTF-8 file contents." }
        },
        required: ["path", "content"]
      },
      function: async (args: unknown) => {
        const value = recordArgs(args);
        const path = workspacePath(value.path, false);
        if (typeof value.content !== "string" || value.content.length > MAX_WRITE_CHARACTERS) {
          return record("workspace-write", `Rejected write to ${path}`, async () => {
            throw new Error("workspace-write-content-invalid");
          });
        }
        const content = value.content;
        return record("workspace-write", `Wrote ${path}`, async () => {
          const slash = path.lastIndexOf("/");
          if (slash > "/workspace".length) await sandbox.mkdir(path.slice(0, slash), { recursive: true });
          const temporary = `/workspace/.fable/routine-write-${crypto.randomUUID()}.part`;
          await sandbox.writeFile(temporary, content, { encoding: "utf8" });
          try {
            await sandbox.renameFile(temporary, path);
          } catch (error) {
            await sandbox.deleteFile(temporary).catch(() => undefined);
            throw error;
          }
          return JSON.stringify({ ok: true, path, charactersWritten: content.length });
        });
      }
    });
  }
  if (request.capabilities.includes("process-run")) {
    tools.push({
      name: "process_run",
      description: "Run an explicit argv program in the isolated hosted computer. No shell string is accepted. The working directory must be under /workspace.",
      parameters: {
        type: "object",
        properties: {
          argvJson: { type: "string", description: "JSON array containing the executable followed by separate string arguments." },
          cwd: { type: "string", description: "Absolute working directory under /workspace." },
          timeoutMs: { type: "integer", description: "Deadline from 1000 through 60000 milliseconds." }
        },
        required: ["argvJson"]
      },
      function: async (args: unknown) => {
        const value = recordArgs(args);
        const argv = processArgvJson(value.argvJson);
        const cwd = value.cwd === undefined ? "/workspace" : workspacePath(value.cwd);
        const timeoutMs = processTimeout(value.timeoutMs);
        return record("process-run", `Ran ${bounded(argv.join(" "), 180)} in ${cwd}`, async () => {
          const process = await sandbox.exec(argv, { cwd, timeout: timeoutMs });
          const output = await process.output({ encoding: "utf8", maxBytes: MAX_PROCESS_OUTPUT_BYTES, timeout: timeoutMs + 5_000 });
          return JSON.stringify({
            ok: output.exitCode === 0,
            exitCode: output.exitCode,
            timedOut: output.timedOut,
            truncated: output.truncated,
            stdout: bounded(output.stdout, 12_000),
            stderr: bounded(output.stderr, 4_000)
          });
        });
      }
    });
  }

  const response = await runWithToolsImpl(
    ai as Parameters<RunWithTools>[0],
    model,
    {
      messages: [
        {
          role: "system",
          content: [
            "You are a Fable teammate running an approved background routine on a persistent isolated computer.",
            "Complete the stated outcome using only the tools you were given and only inside /workspace.",
            "Never seek or expose passwords, one-time codes, payment details, tokens, or private keys.",
            "Do not claim an action succeeded unless the corresponding tool result proves it.",
            "If access or authority is missing, explain the exact blocker and preserve partial work.",
            "Finish with a concise result summary that names created or changed workspace paths."
          ].join(" ")
        },
        { role: "user", content: request.instruction }
      ],
      tools
    },
    {
      maxRecursiveToolRuns: request.maxSteps,
      strictValidation: true,
      verbose: false
    }
  );

  const result = typeof response.response === "string" && response.response.trim()
    ? response.response.trim()
    : evidence.length > 0
      ? "The routine completed its approved tool work but returned no final summary."
      : "The routine returned no result.";
  return { result: bounded(result, MAX_FINAL_RESULT_CHARACTERS), tools: evidence.slice(0, toolBudget) };
}

function recordArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool-arguments-invalid");
  return value as Record<string, unknown>;
}

function workspacePath(value: unknown, allowRoot = true): string {
  if (typeof value !== "string" || value !== value.trim() || value.includes("\0") || value.includes("\\")) {
    throw new Error("workspace-path-invalid");
  }
  if (value === "/workspace") {
    if (!allowRoot) throw new Error("workspace-path-invalid");
    return value;
  }
  if (!value.startsWith("/workspace/") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("workspace-path-invalid");
  }
  if (value === "/workspace/.fable" || value.startsWith("/workspace/.fable/")) {
    throw new Error("workspace-internal-path-denied");
  }
  return value;
}

function processArgvJson(value: unknown): [string, ...string[]] {
  if (typeof value !== "string" || value.length > 16_000) throw new Error("process-argv-invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("process-argv-invalid");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 32
    || parsed.some((part) => typeof part !== "string" || !part || part.length > 4_096 || part.includes("\0"))
  ) {
    throw new Error("process-argv-invalid");
  }
  return parsed as [string, ...string[]];
}

function processTimeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw new Error("process-timeout-invalid");
  }
  return value;
}

function safeToolError(error: unknown): string {
  if (!(error instanceof Error) || !/^[a-z0-9-]{1,80}$/u.test(error.message)) return "tool-operation-failed";
  return error.message;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}
