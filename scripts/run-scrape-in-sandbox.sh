#!/usr/bin/env bash
# run-scrape-in-sandbox.sh — wrapper for run-scrape-in-sandbox.ts (scrape blast in Vercel, Claude-free).
# Tars scrape-rabbit (incl. its .env + Vision creds JSON) and runs blitz_scrape.py --from-queue in a sandbox.
# Usage: ./run-scrape-in-sandbox.sh [workers] [--dry-run] [--keep]
set -euo pipefail

WORKERS="${1:-10}"; case "$WORKERS" in --*) WORKERS=10 ;; esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SCRAPE_RABBIT="${SCRAPE_RABBIT_DIR:-$HOME/Projects/pricingsaas-scrape-rabbit}"
BLITZ_PATH="${BLITZ_PATH:-$HOME/Projects/agent-bob/blitz_scrape.py}"
TAR_PATH="/tmp/scrape-rabbit.tar.gz"

[ -f "$SCRAPE_RABBIT/.env" ] || { echo "scrape-rabbit .env not found at $SCRAPE_RABBIT/.env" >&2; exit 1; }
[ -f "$BLITZ_PATH" ] || { echo "blitz_scrape.py not found at $BLITZ_PATH" >&2; exit 1; }

echo "Taring scrape-rabbit (incl .env + Vision creds; excl node_modules/.git/tmp) → $TAR_PATH"
tar -czf "$TAR_PATH" -C "$SCRAPE_RABBIT" \
  --exclude='.git' --exclude='node_modules' --exclude='tmp' --exclude='*.log' .
echo "  $(du -h "$TAR_PATH" | cut -f1)"

export TAR_PATH BLITZ_PATH
exec npx --prefix "$PROJECT_DIR" tsx "$SCRIPT_DIR/run-scrape-in-sandbox.ts" "$WORKERS" "${@:2}"
