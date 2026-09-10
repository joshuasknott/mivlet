// Build-time only. End users receive the verified executable in the installer.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const resources = fileURLToPath(new URL("../src-tauri/resources/cua-driver/", import.meta.url));
const manifest = JSON.parse(await readFile(join(resources, "runtime.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// PowerShell 7 exports its module path; Windows PowerShell must discover its own modules.
const powershellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The bundled native computer currently supports Windows x64 only.");
}
const executable = join(resources, manifest.executable);
const existing = await readFile(executable).catch(() => null);
if (existing && digest(existing) === manifest.executableSha256) {
  console.log(`Cua Driver ${manifest.version}: verified bundled executable.`);
} else {
  const staging = await mkdtemp(join(tmpdir(), "mivlet-cua-"));
  try {
    const response = await fetch(manifest.archiveUrl);
    if (!response.ok) throw new Error(`Cua Driver download failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== manifest.archiveSha256) throw new Error("Cua Driver archive checksum mismatch.");
    const archive = join(staging, "runtime.zip");
    const expanded = join(staging, "expanded");
    await writeFile(archive, bytes);
    // Fixed script; paths are parameters, never interpolated PowerShell code.
    const script = join(staging, "extract.ps1");
    await writeFile(script, "param([string]$Archive,[string]$Destination)\n$ErrorActionPreference='Stop'\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, archive, expanded], { windowsHide: true, stdio: "inherit", env: powershellEnv });
    const candidate = join(expanded, manifest.executable);
    if (digest(await readFile(candidate)) !== manifest.executableSha256) throw new Error("Cua Driver executable checksum mismatch.");
    const verify = join(staging, "verify.ps1");
    await writeFile(verify, 'param([string]$Executable)\n$signature = Get-AuthenticodeSignature -LiteralPath $Executable\nif ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch \'CN="?Cua AI, Inc\\."?\') { throw "Invalid Cua Driver signature" }\n');
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", verify, candidate], { windowsHide: true, stdio: "inherit", env: powershellEnv });
    await mkdir(resources, { recursive: true });
    await copyFile(candidate, executable);
    console.log(`Cua Driver ${manifest.version}: downloaded, signature and SHA-256 verified.`);
  } finally {
    // mkdtemp owns this exact directory; no user-selected path is removed.
    await rm(staging, { recursive: true, force: true });
  }
}
