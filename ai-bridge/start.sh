#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите LTS: https://nodejs.org"
  exit 1
fi
echo "Starting BIM.LVA AI bridge..."
exec node ai-bridge/server.mjs
