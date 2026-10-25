export function agentHostPlatform(platform = process.platform, architecture = process.arch) {
  if (platform === "win32" && architecture === "x64") {
    return {
      platform,
      architecture,
      target: "bun-windows-x64",
      packageName: "@oven/bun-windows-x64",
      bunBinary: "bin/bun.exe",
      binary: "mivlet-agent-host.exe",
    };
  }
  if (platform === "linux" && architecture === "x64") {
    return {
      platform,
      architecture,
      target: "bun-linux-x64-baseline",
      packageName: "@oven/bun-linux-x64-baseline",
      bunBinary: "bin/bun",
      binary: "mivlet-agent-host",
    };
  }
  throw new Error(
    `The embedded agent host currently supports Windows x64 and Linux x64; got ${platform}/${architecture}.`,
  );
}
