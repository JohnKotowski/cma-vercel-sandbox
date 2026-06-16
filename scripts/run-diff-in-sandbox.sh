#!/usr/bin/env bash
# run-diff-in-sandbox.sh — wrapper for run-diff-in-sandbox.ts (pipeline cloud failover, Phase 1).
# Sources host secrets, tars the diff-rabbit repo, runs ONE diff in a Vercel Sandbox on the API key.
#
# Usage: ./run-diff-in-sandbox.sh <slug> <period> [--keep]
set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <period> [--keep] [--force]}"
PERIOD="${2:?Usage: $0 <slug> <period> [--keep] [--force]}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIFF_RABBIT="${DIFF_RABBIT_DIR:-$HOME/Projects/pricingsaas-diff-rabbit}"
TAR_PATH="/tmp/diff-rabbit.tar.gz"

# Only the failover key comes from the host. Everything else (vault/cloudinary/task-queue
# URLs + keys) rides in diff-rabbit's own .env, which is included in the tarball below —
# so the sandbox replicates the local worker's env exactly, swapping only seat-auth for API key.
set -a; source "$HOME/.claude/.env"; set +a
# Prefer subscription auth (flat-rate) if a token is present; else fall back to the API key.
if [ -z "${FAILOVER_CLAUDE_OAUTH_TOKEN:-}" ] && [ -z "${FAILOVER_ANTHROPIC_API_KEY:-}" ]; then
  echo "Need FAILOVER_CLAUDE_OAUTH_TOKEN (subscription) or FAILOVER_ANTHROPIC_API_KEY in ~/.claude/.env" >&2; exit 1
fi
[ -f "$DIFF_RABBIT/.env" ] || { echo "diff-rabbit .env not found at $DIFF_RABBIT/.env" >&2; exit 1; }

echo "Taring diff-rabbit (incl its .env; excl .git/node_modules/tmp) → $TAR_PATH"
tar -czf "$TAR_PATH" -C "$DIFF_RABBIT" \
  --exclude='.git' --exclude='node_modules' --exclude='tmp' --exclude='*.log' .
echo "  $(du -h "$TAR_PATH" | cut -f1)"

export TAR_PATH FAILOVER_CLAUDE_OAUTH_TOKEN FAILOVER_ANTHROPIC_API_KEY
exec npx --prefix "$PROJECT_DIR" tsx "$SCRIPT_DIR/run-diff-in-sandbox.ts" "$SLUG" "$PERIOD" "${@:3}"
