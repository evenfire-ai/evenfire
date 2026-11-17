import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { commandFailureReason } from '../../tests/e2e/playwright/issue-628/command-diagnostics.ts'

const profileCases = [
  ['PROFILE_BUSY', 'Minikube profile busy'],
  ['PROFILE_UNHEALTHY', 'Minikube profile unhealthy'],
  ['PROFILE_LOCK_REQUIRED', 'Minikube profile lease required'],
  ['PROFILE_OWNERSHIP_MISMATCH', 'Minikube profile ownership mismatch'],
  ['HEAD_MARKER_MISMATCH', 'Minikube source marker mismatch'],
  ['DEVELOPMENT_SCOPE_REQUIRED', 'Minikube development scope rejected'],
  ['PORT_FORWARD_CONFLICT', 'Minikube port-forward ownership conflict'],
]

test('known command errors produce fixed labels without the surrounding stderr', () => {
  const marker = 'UNTRUSTED_PAYLOAD'
  const cases = [
    ['[bootstrap-instances] ERROR: cannot inspect an existing Context', 'context1 bootstrap read failed'],
    ['[bootstrap-instances] ERROR: invalid context1 last-applied configuration', 'context1 bootstrap baseline invalid'],
    ['Error from server (Forbidden)', 'Kubernetes request forbidden'],
    ['Error from server (Invalid)', 'Kubernetes object invalid'],
    ['Error from server (NotFound)', 'Kubernetes object not found'],
    ['Error from server (Unauthorized)', 'Kubernetes authentication required'],
    ['You must be logged in to the server (Unauthorized)', 'Kubernetes authentication required'],
    ['Unable to connect to the server', 'Kubernetes API connection failed'],
    ['spec.mcpServers: Required value', 'context1 connector list rejected'],
    ['MCP result mismatch', 'MCP result mismatch'],
    ['ISSUE628_RESTART_START_FAILED', 'ISSUE628_RESTART_START_FAILED'],
    ['[provision-gfs-runtime] ERROR:', 'GFS runtime provisioning failed'],
    ...profileCases.map(([code, label]) => [code + ':', label]),
  ]
  for (const [signature, expected] of cases) {
    const actual = commandFailureReason(`${marker}\n${signature}_${marker}`)
    assert.equal(actual, expected)
    assert.ok(!actual.includes(marker))
  }
})

test('specific causes take precedence over generic provisioning and Kubernetes errors', () => {
  assert.equal(
    commandFailureReason('[provision-gfs-runtime] ERROR: Error from server (Invalid): spec.mcpServers: Required value'),
    'context1 connector list rejected'
  )
  assert.equal(
    commandFailureReason('[provision-gfs-runtime] ERROR: PROFILE_BUSY: UNTRUSTED_PAYLOAD'),
    'Minikube profile busy'
  )
})

test('internal signatures still correspond to their producer messages', () => {
  const root = new URL('../../', import.meta.url)
  const producers = [
    ['deploy/scripts/lib/bootstrap-instances.sh', [
      '[bootstrap-instances] ERROR: cannot inspect an existing Context',
      '[bootstrap-instances] ERROR: cannot validate Context response',
      '[bootstrap-instances] ERROR: jq is required',
      '[bootstrap-instances] ERROR: cannot render instances',
      '[bootstrap-instances] ERROR: cannot render seed instances',
      '[bootstrap-instances] ERROR: cannot classify instance declarations',
      '[bootstrap-instances] ERROR: cannot prepare initial context1',
      '[bootstrap-instances] ERROR: invalid context1 last-applied configuration',
    ]],
    ['scripts/e2e/issue-628-profile-restart.sh', [
      'ISSUE628_RESTART_SCOPE_REQUIRED',
      'ISSUE628_RESTART_READINESS_FAILED',
      'ISSUE628_RESTART_IP_UNKNOWN',
      'ISSUE628_RESTART_STOP_FAILED',
      'ISSUE628_RESTART_START_FAILED',
      'ISSUE628_RESTART_IP_CHANGED',
      'ISSUE628_RESTART_STOP_UNOBSERVED',
    ]],
    ['tests/e2e/playwright/issue-628/connector-persistence.spec.ts', [
      'MCP request failed',
      'MCP response missing or rejected',
      'MCP result mismatch',
    ]],
  ]
  for (const [file, signatures] of producers) {
    const source = readFileSync(new URL(file, root), 'utf8')
    for (const signature of signatures) {
      assert.ok(source.includes(signature), `${file} no longer emits ${signature}`)
      assert.ok(commandFailureReason(signature), `${signature} has no diagnostic label`)
    }
  }
  const harness = readFileSync(new URL('scripts/minikube/t2-common.sh', root), 'utf8')
  for (const [code] of profileCases) {
    assert.match(harness, new RegExp('\\bt2_fail ' + code + '\\b'))
  }
})

test('GFS provisioning errors retain a fixed label without exposing the message', () => {
  const source = readFileSync(new URL('../../deploy/scripts/provision-gfs-runtime.sh', import.meta.url), 'utf8')
  const definitions = source.match(/^log\(\) \{[^\n]+\}\ndie\(\) \{\n[\s\S]*?^\}/m)
  assert.ok(definitions, 'GFS logging functions could not be found')
  const result = spawnSync('/bin/bash', ['-c', `${definitions[0]}\ndie "$1"`, 'issue-628-test', 'UNTRUSTED_PAYLOAD'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  })
  assert.equal(result.status, 1)
  const label = commandFailureReason(result.stderr)
  assert.equal(label, 'GFS runtime provisioning failed')
  assert.ok(!label.includes('UNTRUSTED_PAYLOAD'))
})

test('unrecognized stderr, codes and restart-like strings are not echoed', () => {
  assert.equal(commandFailureReason('UNTRUSTED_PAYLOAD'), undefined)
  assert.equal(commandFailureReason('PROFILE_UNTRUSTED_PAYLOAD: private-data'), undefined)
  assert.equal(commandFailureReason('PROFILE_BUSY_UNTRUSTED_PAYLOAD: private-data'), undefined)
  assert.equal(commandFailureReason('ISSUE628_RESTART_UNTRUSTED_PAYLOAD'), undefined)
})
