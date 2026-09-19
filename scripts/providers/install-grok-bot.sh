#!/bin/sh
# Run inside WSL Linux, under the same Linux user as Mivlet's default WSL distro.
# Installs code only. Pairing and relay deployment remain operator actions.
set -eu
version=0.2.0-beta.8
integrity='6ouDfYiCBON1O9RS6t7A64AiJa6YlgvMW1g/8XPYqS5hkowBVJtYnQicNXLTQvM5dIYBqOqxpFkGzHE975IgDQ=='
/usr/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
destination="$HOME/.local/share/mivlet-grok-bot/$version"
if [ -e "$destination" ]; then
  printf '%s\n' 'Install directory already exists. Inspect it before replacing it; this installer never overwrites an installation.'
  exit 1
fi
temporary=$(mktemp -d)
trap 'rm -f "$temporary/package.tgz"; rmdir "$temporary" 2>/dev/null || true' EXIT
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  "https://registry.npmjs.org/codex-grok-mcp/-/codex-grok-mcp-$version.tgz" -o "$temporary/package.tgz"
/usr/bin/node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const actual=crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"); if(actual!==process.argv[2]) throw Error("Pinned bridge integrity mismatch");' "$temporary/package.tgz" "$integrity"
mkdir -p "$destination"
npm install --prefix "$destination" --ignore-scripts --omit=dev --no-audit --no-fund "$temporary/package.tgz"
printf '%s\n' 'Pinned bridge code installed. Follow docs/development/grok-bot.md to deploy and pair.'
