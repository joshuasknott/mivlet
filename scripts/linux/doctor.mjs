import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, shell: false });
  return { ok: !result.error && result.status === 0, output: result.stdout?.trim() ?? "" };
}

export function inspectLinux({
  platform = process.platform,
  arch = process.arch,
  node = process.versions.node,
  desktop = false,
  session = process.env.XDG_SESSION_TYPE,
  run = execute,
} = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("Platform", platform === "linux" && arch === "x64", "Linux x86_64 is required for this build target.");
  add("Node", Number(node.split(".")[0]) >= 22, "Use Node 22 or newer.");
  if (platform !== "linux") return checks;
  for (const [command, args, guidance] of [
    ["pnpm", ["--version"], "Install the repository's pinned pnpm 10.34.7."],
    ["rustc", ["--version"], "Install stable Rust using rustup."],
    ["cargo", ["--version"], "Load $HOME/.cargo/env after installing Rust."],
    ["cc", ["--version"], "Install build-essential."],
    ["git", ["--version"], "Install git."],
    ["dpkg-deb", ["--version"], "Install dpkg to build the Debian package."],
  ]) {
    const result = run(command, args);
    const valid = result.ok && (command !== "pnpm" || Number(result.output.split(".")[0]) === 10);
    add(command, valid, valid ? result.output.split("\n")[0] : guidance);
  }
  for (const library of ["webkit2gtk-4.1", "gtk+-3.0", "ayatana-appindicator3-0.1", "dbus-1", "openssl"]) {
    const result = run("pkg-config", ["--modversion", library]);
    add(library, result.ok, result.ok ? result.output : "Install the Linux build prerequisites in docs/operations/kubuntu.md.");
  }
  if (desktop) {
    add("Desktop session", session === "wayland" || session === "x11", "Run from a terminal inside your signed-in Plasma session. Wayland is recommended.");
    const secrets = run("gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.DBus.Peer.Ping"]);
    add("Secret Service", secrets.ok, secrets.ok
      ? "Session service responds; Mivlet must still verify that its wallet can be unlocked and used."
      : "Enable and unlock KDE Wallet / Secret Service in Plasma; no plaintext credential fallback is supported.");
    const portal = run("gdbus", ["call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.DBus.Peer.Ping"]);
    add("Desktop portal", portal.ok, portal.ok ? "Desktop portal responds (this does not enable agent desktop control)." : "Install and run xdg-desktop-portal and xdg-desktop-portal-kde in your Plasma session.");
  }
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== "--desktop")) {
    console.error("Usage: pnpm linux:doctor [--desktop]");
    process.exitCode = 2;
  } else {
    const checks = inspectLinux({ desktop: flags.includes("--desktop") });
    for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    console.log("Build prerequisites are separate from provider sign-in and native Kubuntu desktop acceptance.");
    process.exitCode = checks.every(check => check.ok) ? 0 : 1;
  }
}
