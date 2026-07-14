#!/usr/bin/env bash
# Drops all E2E test collections from MongoDB.
#
# Usage: CONNECTION_STRING="mongodb+srv://..." ./cleanup-mongodb.sh

set -euo pipefail

: "${CONNECTION_STRING:?Set CONNECTION_STRING env var}"

echo "=== Cleaning up MongoDB test data ==="

mongosh "${CONNECTION_STRING}" <<'EOF'
use clerum-test;
db.users.drop();
db.products.drop();
db.large_collection.drop();
db.e2e_test.drop();
db.test_unicode.drop();
print("All test collections dropped.");
EOF

echo "=== MongoDB cleanup complete ==="
