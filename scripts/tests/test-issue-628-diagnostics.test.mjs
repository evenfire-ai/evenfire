import assert from 'node:assert/strict'
import test from 'node:test'
import { commandFailureReason } from '../../tests/e2e/playwright/issue-628/command-diagnostics.ts'

test('known command errors produce fixed labels without the surrounding stderr', () => {
  const marker = 'UNTRUSTED_PAYLOAD'
  const cases = [
    ['[bootstrap-instances] ERROR: cannot inspect an existing Context', 'context1 bootstrap read failed'],
    ['[bootstrap-instances] ERROR: invalid context1 last-applied configuration', 'context1 bootstrap baseline invalid'],
    ['Error from server (Forbidden)', 'Kubernetes request forbidden'],
    ['spec.mcpServers: Required value', 'context1 connector list rejected'],
    ['MCP result mismatch', 'MCP result mismatch'],
    ['ISSUE628_RESTART_START_FAILED', 'ISSUE628_RESTART_START_FAILED'],
  ]
  for (const [signature, expected] of cases) {
    const actual = commandFailureReason(`${marker}\n${signature}_${marker}`)
    assert.equal(actual, expected)
    assert.ok(!actual.includes(marker))
  }
})

test('unrecognized stderr and restart-like strings are not echoed', () => {
  assert.equal(commandFailureReason('UNTRUSTED_PAYLOAD'), undefined)
  assert.equal(commandFailureReason('ISSUE628_RESTART_UNTRUSTED_PAYLOAD'), undefined)
})
