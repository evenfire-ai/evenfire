#!/usr/bin/env bash
# Seeds Airtable with additional records for pagination test (D2).
#
# Requires 5 manual seed records already in the Tasks table (see docs).
#
# Usage:
#   AIRTABLE_API_KEY="patXXX..." \
#   AIRTABLE_BASE_ID="appXXX..." \
#   AIRTABLE_TABLE_NAME="Tasks" \
#   ./seed-airtable.sh

set -euo pipefail

: "${AIRTABLE_API_KEY:?Set AIRTABLE_API_KEY}"
: "${AIRTABLE_BASE_ID:?Set AIRTABLE_BASE_ID}"
AIRTABLE_TABLE_NAME="${AIRTABLE_TABLE_NAME:-Tasks}"

API_URL="https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}"

echo "=== Seeding Airtable (150 records for pagination test D2) ==="

# Airtable allows max 10 records per create request
for batch in $(seq 0 14); do
  RECORDS="["
  for i in $(seq 0 9); do
    idx=$((batch * 10 + i + 6))  # Start at 6 (5 manual seed records already exist)
    STATUS_IDX=$((idx % 3))
    case $STATUS_IDX in
      0) STATUS="Todo" ;;
      1) STATUS="In Progress" ;;
      2) STATUS="Done" ;;
    esac
    PRIORITY=$((idx % 5 + 1))
    COMMA=""
    if [ "$i" -gt 0 ]; then COMMA=","; fi
    RECORDS="${RECORDS}${COMMA}{\"fields\":{\"Title\":\"Seed Task ${idx}\",\"Status\":\"${STATUS}\",\"Priority\":${PRIORITY},\"Assignee\":\"Bot\"}}"
  done
  RECORDS="${RECORDS}]"

  curl -s -X POST "${API_URL}" \
    -H "Authorization: Bearer ${AIRTABLE_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"records\": ${RECORDS}}" > /dev/null

  echo "  Batch $((batch + 1))/15 created"
  sleep 0.25  # Respect 5 req/sec rate limit
done

echo "=== Airtable seed complete (150 records added) ==="
