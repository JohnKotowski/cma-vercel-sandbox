#!/bin/bash
# upload-agent-extract.sh
#
# E2E upload for agent-browser extractions. Runs alongside the existing
# scrape-rabbit pipeline but handles agent-browser-specific edge cases:
#
#   1. Fetches existing data WITHOUT version filter (gets plan UUIDs for upsert)
#   2. Patches freemium / pricing_not_disclosed charges (strips price field)
#   3. Strips thresholds that lack pricing_metric_id
#   4. Uploads plans/charges/discounts via pricing-upload
#   5. Uploads features via POST /features (separate endpoint)
#   6. Verifies result via management API
#   7. Records extraction metadata (version, duration, task_id) to app_extractions
#
# Usage:
#   ./scripts/upload-agent-extract.sh <slug> <json-file> [options]
#
# Options:
#   --version=YYYYMMDD   Override version (default: today)
#   --dry-run            Validate and stage only, no upload
#   --no-verify          Skip verification step
#   --features-only      Skip pricing-upload, only upload features
#   --task-id=UUID       Claude task ID (written to app_extractions for dashboard link)
#
# Examples:
#   ./scripts/upload-agent-extract.sh airtable tmp/airtable/agent-browser-test/extract-output.json
#   ./scripts/upload-agent-extract.sh airtable extract.json --dry-run

set -e

EXTRACT_RABBIT_DIR="${EXTRACT_RABBIT_DIR:-/Users/john/Projects/pricingsaas-extract-rabbit}"

if [ ! -d "$EXTRACT_RABBIT_DIR" ]; then
    echo "ERROR: extract-rabbit repo not found at $EXTRACT_RABBIT_DIR" >&2
    exit 1
fi

SLUG=""
JSON_FILE=""
VERSION=$(date -u +%Y%m%d)
DRY_RUN=false
NO_VERIFY=false
FEATURES_ONLY=false
TASK_ID=""

for arg in "$@"; do
    case "$arg" in
        --version=*)    VERSION="${arg#*=}" ;;
        --dry-run)      DRY_RUN=true ;;
        --no-verify)    NO_VERIFY=true ;;
        --features-only) FEATURES_ONLY=true ;;
        --task-id=*)    TASK_ID="${arg#*=}" ;;
        --help|-h)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
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
    echo "Usage: $0 <slug> <json-file> [--version=YYYYMMDD] [--dry-run]" >&2
    exit 1
fi

if [ ! -f "$JSON_FILE" ]; then
    echo "ERROR: JSON file not found: $JSON_FILE" >&2
    exit 1
fi

PLAN_COUNT=$(jq '.plans | length' "$JSON_FILE" 2>/dev/null || echo 0)
if [ "$PLAN_COUNT" -eq 0 ]; then
    echo "ERROR: No plans found in $JSON_FILE" >&2
    exit 1
fi

FEATURE_COUNT=$(jq '[.plans[].features // [] | length] | add' "$JSON_FILE" 2>/dev/null || echo 0)

UPLOAD_START_EPOCH=$(date +%s)

echo "============================================================"
echo " Agent Browser Upload: $SLUG @ $VERSION"
echo " Plans: $PLAN_COUNT  Features: $FEATURE_COUNT"
echo " Source: $JSON_FILE"
echo "============================================================"

# --- Setup ---
DEST_DIR="$EXTRACT_RABBIT_DIR/tmp/$SLUG/extracts/$VERSION"
mkdir -p "$DEST_DIR"
cp "$JSON_FILE" "$DEST_DIR/extract-output.json"

jq --arg s "$SLUG" --arg v "$VERSION" \
    '.slug = $s | .version = $v' "$DEST_DIR/extract-output.json" \
    > "$DEST_DIR/_tmp.json" && mv "$DEST_DIR/_tmp.json" "$DEST_DIR/extract-output.json"

cd "$EXTRACT_RABBIT_DIR"
if [ -f .env ]; then
    set +e; set -a; source .env; set +a; set -e
fi

if [ "$DRY_RUN" = "true" ]; then
    echo ""
    echo "Dry run — staged at $DEST_DIR/extract-output.json"
    jq -r '.plans[] | "  \(.display_name): \(.charges | length) charges, \(.features // [] | length) features"' \
        "$DEST_DIR/extract-output.json"
    exit 0
fi

# --- Step 1: Fetch existing data WITHOUT version filter (gets plan UUIDs) ---
echo ""
echo "[1/6] Fetching existing data (no version filter, for plan ID matching)..."
EXISTING_URL="${MANAGEMENT_API_URL}/pricing-structure?slug=${SLUG}"
curl -s "$EXISTING_URL" -H "X-API-Key: ${MANAGEMENT_API_KEY}" \
    > "$DEST_DIR/existing-data.json" 2>/dev/null
EXISTING_PLANS=$(jq '.plans | length' "$DEST_DIR/existing-data.json" 2>/dev/null || echo 0)
echo "  Found $EXISTING_PLANS existing plans"

# --- Step 2: Merge IDs ---
echo ""
echo "[2/6] Merging IDs..."
node agent/extract-agent/merge-ids.js "$SLUG" "$VERSION" 2>&1 | grep -E "^(✓|✗|\+|📊|🔗|🌐|🔑|💾|✅)" || true

MERGED_FILE="$DEST_DIR/extract-output-management-api-merged.json"
if [ ! -f "$MERGED_FILE" ]; then
    echo "  WARNING: merge produced no output, using raw extract"
    MERGED_FILE="$DEST_DIR/extract-output.json"
fi

# --- Step 3: Transform ---
echo ""
echo "[3/6] Transforming to Management API format..."
node agent/extract-agent/transform-to-management-api.js "$MERGED_FILE" 2>&1 | grep -E "^(🔄|📊|✅|📤|Input)" || true

# Find the transform output (naming varies)
API_FILE=""
for candidate in \
    "$DEST_DIR/extract-output-management-api-merged-management-api.json" \
    "$DEST_DIR/extract-output-management-api.json"; do
    if [ -f "$candidate" ]; then
        API_FILE="$candidate"
        break
    fi
done

if [ -z "$API_FILE" ]; then
    echo "ERROR: No transform output found" >&2
    exit 1
fi

# --- Step 4: Patch for agent-browser edge cases ---
echo ""
echo "[4/6] Patching for agent-browser edge cases..."
PATCHED_FILE="$DEST_DIR/upload-ready.json"

jq '
  .plans = [.plans[] |
    # Strip thresholds without pricing_metric_id
    .thresholds = [(.thresholds // [])[] | select(.pricing_metric_id != null)] |
    # Remove price from freemium and pricing_not_disclosed charges
    if .charges then
      .charges = [.charges[] |
        if (.billing == "freemium" or .billing == "pricing_not_disclosed") then del(.price)
        else . end
      ]
    else . end
  ]
' "$API_FILE" > "$PATCHED_FILE"

THRESH_KEPT=$(jq '[.plans[].thresholds | length] | add' "$PATCHED_FILE")
THRESH_ORIG=$(jq '[.plans[].thresholds | length] | add' "$API_FILE")
echo "  Thresholds: $THRESH_KEPT kept (${THRESH_ORIG} original, stripped those without pricing_metric_id)"
echo "  Patched freemium/pricing_not_disclosed charges (removed price field)"

# --- Step 5a: Upload plans/charges/discounts ---
if [ "$FEATURES_ONLY" = "false" ]; then
    echo ""
    echo "[5/6] Uploading plans/charges/discounts..."
    UPLOAD_RESP=$(curl -s -w "\n%{http_code}" -X POST "${MANAGEMENT_API_URL}/pricing-upload" \
        -H "X-API-Key: ${MANAGEMENT_API_KEY}" \
        -H "Content-Type: application/json" \
        -d @"$PATCHED_FILE")
    HTTP_CODE=$(echo "$UPLOAD_RESP" | tail -1)
    BODY=$(echo "$UPLOAD_RESP" | sed '$d')
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        UPLOADED_PLANS=$(echo "$BODY" | jq '.plans | length' 2>/dev/null || echo "?")
        ERRORS=$(echo "$BODY" | jq '.errors | length' 2>/dev/null || echo "0")
        echo "  ✅ Plans uploaded: $UPLOADED_PLANS (HTTP $HTTP_CODE, errors: $ERRORS)"
    else
        echo "  ❌ Upload failed (HTTP $HTTP_CODE)" >&2
        echo "$BODY" | jq -r '.error // .details.errors[0].message // .' 2>/dev/null | head -5 >&2
        exit 1
    fi
else
    echo ""
    echo "[5/6] Skipping plan upload (--features-only)"
fi

# --- Step 5b: Upload features ---
echo ""
echo "[5b/6] Uploading features..."

FEATURE_INPUT="$EXTRACT_RABBIT_DIR/tmp/$SLUG/$VERSION/feature-extraction-input.json"
mkdir -p "$(dirname "$FEATURE_INPUT")"

jq --arg slug "$SLUG" '{
  slug: $slug,
  method: "agent-browser-cloud",
  plans: [.plans[] | {
    internal_name: .internal_name,
    inherits_from: null,
    features: [(.features // [])[] | {
      name: .name,
      value: .value,
      source: .source,
      description: .description,
      inherited_from: null,
      evidence: null,
      confidence: null,
      method: "agent-browser-cloud"
    }]
  }]
}' "$DEST_DIR/extract-output.json" > "$FEATURE_INPUT"

FEAT_PLAN_COUNT=$(jq '[.plans[] | select(.features | length > 0)] | length' "$FEATURE_INPUT")
FEAT_TOTAL=$(jq '[.plans[].features | length] | add' "$FEATURE_INPUT")
echo "  Prepared $FEAT_TOTAL features across $FEAT_PLAN_COUNT plans"

node agent/extract-agent/extract-features.js "$SLUG" "$VERSION" 2>&1 | grep -v "dotenv" || true

FEAT_RESULT="$EXTRACT_RABBIT_DIR/tmp/$SLUG/$VERSION/feature-extraction-result.json"
if [ -f "$FEAT_RESULT" ]; then
    FEAT_UPSERTED=$(jq '.total_features_upserted' "$FEAT_RESULT" 2>/dev/null || echo "?")
    echo "  Features upserted: $FEAT_UPSERTED"
    if [ "$FEAT_UPSERTED" = "0" ]; then
        echo "  ⚠️  0 features upserted — POST /features endpoint may need investigation"
    fi
fi

# --- Step 6: Verify ---
if [ "$NO_VERIFY" = "false" ]; then
    echo ""
    echo "[6/6] Verifying..."
    VERIFY=$(curl -s "${MANAGEMENT_API_URL}/pricing/${SLUG}" \
        -H "X-API-Key: ${MANAGEMENT_API_KEY}" 2>/dev/null)

    if [ -n "$VERIFY" ]; then
        V_PLANS=$(echo "$VERIFY" | jq '.plans | length' 2>/dev/null || echo "?")
        V_VERSION=$(echo "$VERIFY" | jq -r '.version // "unknown"' 2>/dev/null)
        echo "  DB state: $V_PLANS plans, version=$V_VERSION"
        echo "$VERIFY" | jq -r '.plans[] | "    \(.display_name): \(.charges | length) charges, \(.features | length) features"' 2>/dev/null || true
    else
        echo "  ⚠️  Verification fetch failed"
    fi
else
    echo ""
    echo "[6/6] Skipping verification (--no-verify)"
fi

# --- Step 7: Record extraction metadata ---
echo ""
echo "[7/7] Recording extraction metadata..."
UPLOAD_END_EPOCH=$(date +%s)
DURATION=$((UPLOAD_END_EPOCH - UPLOAD_START_EPOCH))
SKILL_VERSION=$(cd "$EXTRACT_RABBIT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")

EXTRACT_STATUS="success"
if [ "$FEATURES_ONLY" = "true" ]; then
    EXTRACT_STATUS="partial"
fi

RECORD_RESP=$(curl -s -w "\n%{http_code}" -X POST "${MANAGEMENT_API_URL}/extractions" \
    -H "X-API-Key: ${MANAGEMENT_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc \
        --arg slug "$SLUG" \
        --arg version "$VERSION" \
        --arg method "agent_browser_cloud" \
        --arg skill_version "$SKILL_VERSION" \
        --arg status "$EXTRACT_STATUS" \
        --argjson plan_count "$PLAN_COUNT" \
        --argjson feature_count "${FEATURE_COUNT:-0}" \
        --argjson duration_seconds "$DURATION" \
        --arg task_id "${TASK_ID:-}" \
        '{slug:$slug, version:$version, method:$method, skill_version:$skill_version, status:$status, plan_count:$plan_count, feature_count:$feature_count, duration_seconds:$duration_seconds, task_id:$task_id}')" 2>/dev/null)
RECORD_HTTP=$(echo "$RECORD_RESP" | tail -1)
if [ "$RECORD_HTTP" = "201" ]; then
    echo "  ✅ Extraction recorded (HTTP $RECORD_HTTP, ${DURATION}s)"
else
    echo "  ⚠️  Failed to record extraction (HTTP $RECORD_HTTP) — non-fatal"
fi

echo ""
echo "============================================================"
echo " ✅ Agent browser upload complete: $SLUG @ $VERSION"
echo "============================================================"
