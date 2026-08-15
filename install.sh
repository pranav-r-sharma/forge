#!/usr/bin/env bash
# Builds Forge and installs it into your local VS Code.
# Requires: Node.js 18+ and npm on PATH. Run this from inside the unzipped
# forge-local-agent folder (or just double-click-run via `bash install.sh`).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Forge: installing build dependencies (needs internet access once)..."
npm install

echo "==> Forge: compiling TypeScript..."
npm run compile

echo "==> Forge: packaging .vsix..."
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository

VSIX_FILE=$(ls -t ./*.vsix | head -1)
echo "==> Forge: built ${VSIX_FILE}"

if command -v code >/dev/null 2>&1; then
  echo "==> Forge: installing into VS Code..."
  code --install-extension "${VSIX_FILE}" --force
  echo ""
  echo "Done! Reload/restart VS Code, then click the Forge icon in the Activity Bar (left side)."
else
  echo ""
  echo "Built ${VSIX_FILE} but couldn't find the 'code' command on your PATH."
  echo "In VS Code: Cmd+Shift+P -> 'Shell Command: Install code command in PATH', then re-run this script,"
  echo "or install manually: Extensions view -> '...' menu -> 'Install from VSIX...' -> select ${VSIX_FILE}"
fi
