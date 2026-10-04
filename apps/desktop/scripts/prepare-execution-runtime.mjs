// Release-time preparation only. No project command downloads a host runtime.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(
  new URL("../src-tauri/resources/execution-runtime/", import.meta.url),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [
  {
    directory: "node",
    url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip",
    sha256: "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71",
    inner: "node-v22.23.3-win-x64",
  },
  {
    directory: "python",
    url: "https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip",
    sha256: Buffer.from(
      "l9rlJ0zFSGcGXo1aMibkjDUBftMyoP2w4n1bWCGWEpc=",
      "base64",
    ).toString("hex"),
  },
  {
    directory: "python/site-packages",
    url: "https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-26.2.1-py3-none-any.whl",
    sha256: "71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e",
  },
];
async function inventory(root, relative = "") {
  const result = {};
  for (const entry of (
    await readdir(join(root, relative), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await inventory(root, path));
    else if (entry.isFile())
      result[path] = hash(await readFile(join(root, path)));
    else
      throw new Error(
        "Execution runtime contains a link or unsupported entry.",
      );
  }
  return result;
}
const existing = JSON.parse(
  await readFile(join(destination, "files.json"), "utf8").catch(() => "null"),
);
if (
  existing?.version === 1 &&
  JSON.stringify(existing.sources) === JSON.stringify(sources) &&
  JSON.stringify(
    await inventory(join(destination, "runtime")).catch(() => null),
  ) === JSON.stringify(existing.files)
) {
  console.log(
    "Native execution runtime: verified Node 22.23.3, Python 3.13.16 and pip 26.2.1.",
  );
} else {
  const staging = await mkdtemp(join(tmpdir(), "mivlet-execution-build-"));
  try {
    const runtime = join(staging, "runtime");
    await mkdir(runtime);
    for (const [index, source] of sources.entries()) {
      const response = await fetch(source.url);
      if (!response.ok)
        throw new Error(`Runtime download failed (${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== source.sha256)
        throw new Error("Native execution archive checksum mismatch.");
      const archive = join(staging, `${index}.zip`);
      const expanded = join(staging, `expanded-${index}`);
      await writeFile(archive, bytes);
      if (process.platform === "win32") {
        const script = join(staging, "extract.ps1");
        await writeFile(
          script,
          "param([string]$Archive,[string]$Destination)\n$ErrorActionPreference='Stop'\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n",
        );
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-File", script, archive, expanded],
          {
            windowsHide: true,
            stdio: "inherit",
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => key.toLowerCase() !== "psmodulepath",
              ),
            ),
          },
        );
      } else {
        await mkdir(expanded);
        execFileSync("unzip", ["-q", archive, "-d", expanded], {
          stdio: "inherit",
        });
      }
      await cp(
        source.inner ? join(expanded, source.inner) : expanded,
        join(runtime, source.directory),
        { recursive: true },
      );
    }
    // Isolated Python never discovers user/system site-packages or environment.
    // Only the staged work and its explicitly installed packages join sys.path.
    await writeFile(
      join(runtime, "python/python313._pth"),
      "python313.zip\n.\nsite-packages\n../../work\n../../work/.python-packages\n",
    );
    await cp(
      join(runtime, "python/python.exe"),
      join(runtime, "python/python3.exe"),
    );
    await mkdir(destination, { recursive: true });
    await cp(runtime, join(destination, "runtime"), { recursive: true });
    const files = await inventory(runtime);
    await writeFile(
      join(destination, "files.json"),
      JSON.stringify(
        {
          version: 1,
          node: "22.23.3",
          python: "3.13.16",
          pip: "26.2.1",
          sources,
          files,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Native execution runtime prepared: ${Object.keys(files).length} verified files, with upstream redistribution notices.`,
    );
  } finally {
    // Only the exact build staging directory created above is removed.
    await rm(staging, { recursive: true, force: true });
  }
}
