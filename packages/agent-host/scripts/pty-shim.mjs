import path from "node:path";

// OpenCode's PTY package computes a libc-specific optional package name with
// createRequire. A compiled Bun binary has no ordinary node_modules resolver,
// so the Linux companion is a deliberate sidecar beside this executable.
export const binaryPath = path.join(
  path.dirname(process.execPath),
  "node_modules",
  "@opencode-ai",
  "pty-linux-x64-gnu",
  "bin",
  "opencode-pty",
);
