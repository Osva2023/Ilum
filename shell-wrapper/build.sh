#!/bin/sh
# Build the agentguard-shell Go binary for the current platform.
#
# Output: shell-wrapper/agentguard-shell  (alongside this script).
# Requires: Go 1.21+ on PATH.

set -e

cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
  echo "[build] Go is not installed.  AgentGuard will fall back to agentguard-shell.sh."
  echo "        Install Go 1.21+ from https://go.dev/dl/ and re-run ./build.sh."
  exit 1
fi

go build -trimpath -ldflags="-s -w" -o agentguard-shell main.go
chmod +x agentguard-shell

echo "[build] $(pwd)/agentguard-shell"
go version
file agentguard-shell 2>/dev/null || true
