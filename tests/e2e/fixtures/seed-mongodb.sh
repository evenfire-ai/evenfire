#!/usr/bin/env bash
# Seeds MongoDB with test data for E2E tests.
#
# Usage: CONNECTION_STRING="mongodb+srv://..." ./seed-mongodb.sh

set -euo pipefail

: "${CONNECTION_STRING:?Set CONNECTION_STRING env var}"

echo "=== Seeding MongoDB ==="

mongosh "${CONNECTION_STRING}" <<'MONGO_EOF'

use clerum-test;

// Clean previous test data
db.users.drop();
db.products.drop();
db.large_collection.drop();
db.e2e_test.drop();
db.test_unicode.drop();

// --- users collection (used by R1, R2, D4) ---
db.users.insertMany([
  { name: "Alice", email: "alice@example.com", role: "admin", createdAt: new Date("2024-06-15T10:00:00Z") },
  { name: "Bob", email: "bob@example.com", role: "user", createdAt: new Date("2024-08-20T14:30:00Z") },
  { name: "Charlie", email: "charlie@example.com", role: "user", createdAt: new Date("2025-01-10T09:15:00Z") },
]);
print("  users: 3 documents");

// --- products collection (used by R2, V1, V2) ---
db.products.insertMany([
  { name: "Widget A", price: 29.99, category: "tools", stock: 150 },
  { name: "Widget B", price: 49.99, category: "tools", stock: 0 },
  { name: "Gadget X", price: 199.99, category: "electronics", stock: 42 },
  { name: "Gadget Y", price: 89.99, category: "electronics", stock: 15 },
  { name: "Gizmo Z", price: 349.99, category: "premium", stock: 3 },
]);
print("  products: 5 documents");

// --- large_collection (used by R4, D5) ---
const largeDocs = [];
for (let i = 0; i < 500; i++) {
  largeDocs.push({
    index: i,
    name: `Item ${i}`,
    description: `This is a test document number ${i} with some padding text to increase the payload size. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
    category: ["A", "B", "C", "D"][i % 4],
    value: Math.random() * 1000,
    createdAt: new Date(Date.now() - i * 86400000),
  });
}
db.large_collection.insertMany(largeDocs);
print("  large_collection: 500 documents");

print("=== MongoDB seed complete ===");
MONGO_EOF
