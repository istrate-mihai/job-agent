#!/usr/bin/env bash
# Job Agent launcher (macOS/Linux). Closing this terminal stops the app.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Run ./install.sh first."; read -r -p "Press Enter to close"; exit 1; }
[ -d node_modules ] || npm ci
[ -f .env ] || npm run setup
npm run ui || { echo; echo "Job Agent stopped with an error (see above)."; read -r -p "Press Enter to close"; exit 1; }
