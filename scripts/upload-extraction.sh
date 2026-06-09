#!/bin/bash
# upload-extraction.sh
#
# Bridge between agent-browser extraction output and the extract-rabbit
# post-processing pipeline (validate → fetch-existing → merge-ids → transform → upload).
#
# Usage:
#   ./scripts/upload-extraction.sh <slug> <json-file> [--version=YYYYMMDD] [--no-upload] [--dry-run]
#
# Examples:
#   # From skill output:
#   ./scripts/upload-extraction.sh 1password tmp/1password/agent-browser-test/extract-output.json
#
#   # From managed agent sandbox output (piped from sandbox-cmd --read):
#   npx tsx scripts/sandbox-cmd.ts extract-1password --read /tmp/extract-output.json > /tmp/1password.json
#   ./scripts/upload-extraction.sh 1password /tmp/1password.json
#
#   # Dry run (validate but don't upload):
#   ./scripts/upload-extraction.sh 1password output.json --dry-run

set -e

EXTRACT_RABBIT_DIR="${EXTRACT_RABBIT_DIR:-/Users/john/Projects/pricingsaas-extract-rabbit}"

if [ ! -d "$EXTRACT_RABBIT_DIR" ]; then
    echo "ERROR: extract-rabbit repo not found at $EXTRACT_RABBIT_DIR" >&2
    exit 1
fi

SLUG=""
JSON_FILE=""
VERSION=$(date -u +%Y%m%d)
NO_UPLOAD=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --version=*) VERSION="${arg#*=}" ;;
        --no-upload) NO_UPLOAD=true ;;
        --dry-run)   DRY_RUN=true; NO_UPLOAD=true ;;
        --help|-h)
            echo "Usage: $0 <slug> <json-file> [--version=YYYYMMDD] [--no-upload] [--dry-run]"
            exit 0
            ;;
        *)
            if [ -z "$SLUG" ]; then
                SLUG="$arg"
            elif [ -z "$JSON_FILE" ]; then
                JSON_FILE="$arg"
            fi
            ;;
    esac
done

if [ -z "$SLUG" ] || [ -z "$JSON_FILE" ]; then
    echo "Usage: $0 <slug> <json-file> [--version=YYYYMMDD] [--no-upload] [--dry-run]" >&2
    exit 1
fi

if [ ! -f "$JSON_FILE" ]; then
    echo "ERROR: JSON file not found: $JSON_FILE" >&2
    exit 1
fi

# Validate JSON structure
PLAN_COUNT=$(jq '.plans | length' "$JSON_FILE" 2>/dev/null || echo 0)
if [ "$PLAN_COUNT" -eq 0 ]; then
    echo "ERROR: No plans found in $JSON_FILE" >&2
    exit 1
fi

echo "============================================================"
echo " Pipeline Upload: $SLUG @ $VERSION ($PLAN_COUNT plans)"
echo "============================================================"

# Copy to extract-rabbit's expected location
DEST_DIR="$EXTRACT_RABBIT_DIR/tmp/$SLUG/extracts/$VERSION"
mkdir -p "$DEST_DIR"
cp "$JSON_FILE" "$DEST_DIR/extract-output.json"
echo "Copied to $DEST_DIR/extract-output.json"

# Ensure slug and version are set in the JSON
PATCHED=$(jq --arg s "$SLUG" --arg v "$VERSION" \
    '.slug = $s | .version = $v' "$DEST_DIR/extract-output.json")
echo "$PATCHED" > "$DEST_DIR/extract-output.json"

if [ "$DRY_RUN" = "true" ]; then
    echo ""
    echo "Dry run — JSON staged at $DEST_DIR/extract-output.json"
    echo "Plans: $PLAN_COUNT"
    jq -r '.plans[] | "  - \(.display_name // .internal_name): \(.charges | length) charges"' "$DEST_DIR/extract-output.json"
    exit 0
fi

# Run extract-rabbit post-processing chain
cd "$EXTRACT_RABBIT_DIR"

# Load .env for API keys
if [ -f .env ]; then
    set +e; set -a; source .env; set +a; set -e
fi

echo ""
echo "[1/4] Validating extract..."
node agent/extract-agent/validate-ocr-indexes.js "$SLUG" "$VERSION" 2>&1 || {
    echo "WARNING: validate-ocr-indexes exited non-zero (expected for agent-browser extracts)"
}

echo ""
echo "[2/4] Fetching existing data for ID alignment..."
node agent/extract-agent/fetch-existing-data.js "$SLUG" "$VERSION" 2>&1 || {
    echo "WARNING: fetch-existing-data exited non-zero (first extraction or no existing data)"
}

echo ""
echo "[3/4] Merging IDs..."
node agent/extract-agent/merge-ids.js "$SLUG" "$VERSION" 2>&1 || {
    echo "WARNING: merge-ids exited non-zero"
}

echo ""
echo "[4/4] Transforming to Management API format..."
MERGED_FILE="tmp/$SLUG/extracts/$VERSION/extract-output-management-api-merged.json"
if [ ! -f "$MERGED_FILE" ]; then
    MERGED_FILE="tmp/$SLUG/extracts/$VERSION/extract-output.json"
fi
node agent/extract-agent/transform-to-management-api.js "$MERGED_FILE" 2>&1

if [ "$NO_UPLOAD" = "false" ]; then
    API_FILE="tmp/$SLUG/extracts/$VERSION/extract-output-management-api.json"
    if [ ! -f "$API_FILE" ]; then
        echo "ERROR: $API_FILE not found after transform" >&2
        exit 1
    fi
    echo ""
    echo "Uploading to Management API..."
    UPLOAD_RESP=$(curl -s -w "\n%{http_code}" -X POST "${MANAGEMENT_API_URL}/pricing-upload" \
        -H "X-API-Key: ${MANAGEMENT_API_KEY}" \
        -H "Content-Type: application/json" \
        -d @"$API_FILE")
    HTTP_CODE=$(echo "$UPLOAD_RESP" | tail -1)
    BODY=$(echo "$UPLOAD_RESP" | sed '$d')
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        echo "✅ Upload complete (HTTP $HTTP_CODE)"
        echo "$BODY" | jq -r '.message // empty' 2>/dev/null || true
    else
        echo "❌ Upload failed (HTTP $HTTP_CODE): $BODY" >&2
        exit 1
    fi
else
    echo ""
    echo "Skipping upload (--no-upload)"
    echo "Run without --no-upload to push to database."
fi

echo ""
echo "✅ Pipeline upload complete: $SLUG @ $VERSION"
