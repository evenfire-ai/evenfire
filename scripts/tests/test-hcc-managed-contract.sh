#!/usr/bin/env bash
set -u

FAIL=0
CRD="charts/clerum-crds/crds/mcpserver.yaml"
TYPES="host-context-controller/src/types.ts"
DOC="docs/crds/mcpserver.md"

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

contains() {
  grep -Fq -- "$1" "$2"
}

if contains "workflow-recipes owns the runtime" "$CRD" &&
   contains "spec.managed is immutable" "$CRD" &&
   contains "oldSelf.managed" "$CRD"; then
  pass "McpServer CRD documents WRC ownership and enforces managed immutability"
else
  fail "McpServer CRD managed ownership/immutability contract is incomplete"
fi

if contains "managed:false => WRC owns the runtime" "$TYPES"; then
  pass "TypeScript spec comment uses binary HCC/WRC ownership"
else
  fail "TypeScript spec comment still leaves managed ownership ambiguous"
fi

if contains "\`false\` means WRC owns the runtime" "$DOC" &&
   contains "not create or delete the WRC-owned runtime" "$DOC"; then
  pass "McpServer docs define managed:false as WRC-owned"
else
  fail "McpServer docs do not define managed:false as WRC-owned"
fi

if grep -Eq 'managed[^|]*(externally managed|self-managed)' "$DOC"; then
  fail "Active McpServer docs still describe managed:false as external/self-managed"
else
  pass "Active McpServer docs avoid external/self-managed ownership wording"
fi

exit "$FAIL"
