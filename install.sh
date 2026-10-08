#!/usr/bin/env bash
# Job Agent installer (macOS/Linux): ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
echo "Job Agent installer"
[ -f config/search-config.yaml ] && [ -d drizzle ] || { echo "Not a complete Job Agent copy (config/ or drizzle/ missing). Update zips go over an existing folder; for a new install use the full release zip or git clone."; exit 1; }
major=0
command -v node >/dev/null && major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 22 ]; then
  echo "Node.js 22+ is required (found: $(command -v node >/dev/null && node --version || echo none))."
  if command -v brew >/dev/null; then
    read -r -p "Install Node.js 22 with Homebrew now? [Y/n] " a
    [[ "${a:-y}" =~ ^[Yy] ]] && brew install node@22 && brew link --overwrite --force node@22
  else
    echo "Install it with nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
    echo "or from https://nodejs.org, then run ./install.sh again."
    exit 1
  fi
fi
echo "Node.js $(node --version) OK"
npm ci --no-audit --no-fund
npm run setup
