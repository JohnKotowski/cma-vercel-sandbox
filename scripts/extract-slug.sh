#!/bin/bash
# extract-slug.sh
#
# Single slug extraction via the Claude Code skill (sandbox-cmd wrapper).
# Extracts pricing data, saves JSON locally, optionally uploads to pipeline.
#
# Usage:
#   ./scripts/extract-slug.sh <slug> [--url=URL] [--upload] [--version=YYYYMMDD]
#
# Examples:
#   ./scripts/extract-slug.sh github                    # extract, no upload
#   ./scripts/extract-slug.sh github --upload           # extract + upload to DB
#   ./scripts/extract-slug.sh github --url=https://github.com/pricing

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SBX="npx --prefix $PROJECT_DIR tsx $SCRIPT_DIR/sandbox-cmd.ts"

SLUG=""
URL=""
UPLOAD=false
VERSION=$(date -u +%Y%m%d)

for arg in "$@"; do
    case "$arg" in
        --url=*)     URL="${arg#*=}" ;;
        --upload)    UPLOAD=true ;;
        --version=*) VERSION="${arg#*=}" ;;
        --help|-h)
            echo "Usage: $0 <slug> [--url=URL] [--upload] [--version=YYYYMMDD]"
            exit 0
            ;;
        *)
            if [ -z "$SLUG" ]; then SLUG="$arg"; fi
            ;;
    esac
done

if [ -z "$SLUG" ]; then
    echo "Usage: $0 <slug> [--url=URL] [--upload]" >&2
    exit 1
fi

if [ -z "$URL" ]; then
    URL="https://${SLUG//_/.}.com/pricing"
fi

SBX_NAME="extract-${SLUG}"
OUTPUT_DIR="$PROJECT_DIR/tmp/$SLUG"
OUTPUT_FILE="$OUTPUT_DIR/extract-output.json"

echo "============================================================"
echo " Agent Browser Extraction: $SLUG"
echo " URL: $URL"
echo " Sandbox: $SBX_NAME"
echo "============================================================"

mkdir -p "$OUTPUT_DIR"

echo ""
echo "[1/5] Initializing sandbox..."
$SBX "$SBX_NAME" "agent-browser skills get core" 2>&1 | tail -3

echo ""
echo "[2/5] Opening page..."
$SBX "$SBX_NAME" "agent-browser open '$URL'" 2>&1 | tail -3

echo ""
echo "[3/5] Dismissing overlays..."
$SBX "$SBX_NAME" "sleep 2 && agent-browser eval \"(function(){var d=0;['[aria-label=Close]','[aria-label=close]','[data-dismiss]','.close-button','.modal-close'].forEach(function(sel){document.querySelectorAll(sel).forEach(function(el){try{el.click();d++}catch(e){}})});return d+' dismissed'})()\"" 2>&1

echo ""
echo "[4/5] Capturing page text..."
TEXT=$($SBX "$SBX_NAME" "agent-browser get text body" 2>&1)
echo "$TEXT" > "$OUTPUT_DIR/page-text.txt"
echo "  Saved ${#TEXT} chars to $OUTPUT_DIR/page-text.txt"

echo ""
echo "[5/5] Capturing interactive snapshot..."
SNAP=$($SBX "$SBX_NAME" "agent-browser snapshot -i -c" 2>&1)
echo "$SNAP" > "$OUTPUT_DIR/snapshot.txt"
echo "  Saved snapshot to $OUTPUT_DIR/snapshot.txt"

echo ""
echo "============================================================"
echo " Browser data captured. Next steps:"
echo "  - Page text: $OUTPUT_DIR/page-text.txt"
echo "  - Snapshot:  $OUTPUT_DIR/snapshot.txt"
echo ""
echo "  To continue extraction, use the agent-browser-extract skill"
echo "  which reads these files and produces structured JSON."
echo ""
echo "  To stop the sandbox:"
echo "  $SBX $SBX_NAME --stop"
echo "============================================================"

# Cleanup
echo ""
echo "Closing browser and stopping sandbox..."
$SBX "$SBX_NAME" "agent-browser close" 2>&1 || true
$SBX "$SBX_NAME" "--stop" 2>&1 || true

echo "Done."
