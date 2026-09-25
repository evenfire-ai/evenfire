'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const contracts = require('./index.cjs')

test('Host route deterministic validators preserve approval, model, and title rules', () => {
  assert.deepEqual(contracts.validateHostModelSelectionRequest({}), {
    ok: false,
    error: 'chatId is required',
  })
  assert.deepEqual(contracts.validateHostModelSelectionRequest({ chatId: ' c ', model: ' m ' }), {
    ok: true,
    chatId: 'c',
    model: 'm',
  })
  assert.equal(
    contracts.validateHostModelSelectionRequest({ chatId: 'c', model: 'm', expectedRevision: -1 })
      .ok,
    false
  )
  assert.deepEqual(contracts.validateSessionRenameTitle('  A\nB  '), { ok: true, title: 'A B' })
  assert.deepEqual(contracts.validateSessionRenameTitle('   '), {
    ok: false,
    error: 'invalid title',
  })
  assert.deepEqual(contracts.validateHostApprovalRequestId('approval-1'), {
    ok: true,
    requestId: 'approval-1',
  })
  assert.deepEqual(contracts.validateHostApprovalRequestId(''), {
    ok: false,
    error: 'Missing userId or requestId',
  })
})

test('operation identifiers and generated v2 scopes are bijective', () => {
  assert.equal(new Set(contracts.ACTION_OPERATION_IDS).size, contracts.ACTION_OPERATION_IDS.length)
  assert.equal(contracts.ACTION_OPERATION_SCOPES.length, contracts.ACTION_OPERATION_IDS.length)
  for (const operationId of contracts.ACTION_OPERATION_IDS) {
    assert.equal(contracts.isActionOperationId(operationId), true)
    const scope = contracts.actionOperationScope(operationId)
    assert.equal(scope, `action:${operationId}`)
    assert.equal(contracts.parseActionOperationScope(scope), operationId)
  }
  assert.equal(contracts.parseActionOperationScope('mcp:server:invoke'), null)
  assert.equal(contracts.parseActionOperationScope(' action:mcp.invoke'), null)
  assert.throws(() =>
    contracts.parseActionOperationScopes(['action:mcp.invoke', 'action:mcp.invoke'])
  )
  assert.throws(() => contracts.parseActionOperationScopes(['action:unknown']))
})

test('target serialization and hashing are independent of insertion order', () => {
  const left = { hostRef: 'mcp-host/host-a', agent: 'main', chatId: 'chat-1' }
  const right = { chatId: 'chat-1', hostRef: 'mcp-host/host-a', agent: 'main' }
  assert.equal(
    contracts.canonicalActionTargetJson(left),
    contracts.canonicalActionTargetJson(right)
  )
  assert.equal(contracts.hashActionTarget(left), contracts.hashActionTarget(right))
  assert.match(contracts.hashActionTarget(left), /^ath2_[A-Za-z0-9_-]{43}$/)
})

test('behavior binding hash is deterministic and binds path, revision, and full behavior', () => {
  const base = {
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behavior: {
      capabilities: ['host.use', 'host.read'],
      budget: { state: 'known', value: 'budget-a' },
      credentialPolicy: { state: 'known', value: null },
      approvalPolicy: { state: 'known', value: null },
      filesystemScope: { state: 'known', value: null },
      runtime: { state: 'known', value: 'runtime-a' },
      providerModelPolicy: { state: 'unknown' },
      audit: { state: 'known', value: 'user-a' },
    },
  }
  const reordered = {
    ...base,
    behavior: { ...base.behavior, capabilities: ['host.read', 'host.use'] },
  }
  const hash = contracts.actionBehaviorBindingHash(base)
  assert.equal(hash, contracts.actionBehaviorBindingHash(reordered))
  assert.match(hash, /^bh2_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(
    hash,
    contracts.actionBehaviorBindingHash({
      ...base,
      accessPathId: `ap1_${'c'.repeat(43)}`,
    })
  )
  assert.notEqual(
    hash,
    contracts.actionBehaviorBindingHash({
      ...base,
      authorizationRevision: `ar1_${'d'.repeat(43)}`,
    })
  )
  assert.notEqual(
    hash,
    contracts.actionBehaviorBindingHash({
      ...base,
      behavior: { ...base.behavior, runtime: { state: 'known', value: 'runtime-b' } },
    })
  )
})

test('canonical targets normalize strings and reject unsafe wire shapes', () => {
  assert.deepEqual(
    { ...contracts.canonicalActionTarget({ hostRef: ' mcp-host/host-a ' }) },
    { hostRef: 'mcp-host/host-a' }
  )
  for (const invalid of [
    undefined,
    [],
    { hostRef: '' },
    { hostRef: 'host\nspoof' },
    { hostRef: 7 },
  ]) {
    assert.throws(() => contracts.canonicalActionTarget(invalid))
  }
})

test('shared exact target validation binds operation, resource, and target identity', () => {
  const resource = contracts.canonicalResourceIdentity({
    environmentId: 'cluster.local/evenfire',
    type: 'mcp_server',
    logicalId: 'mcp-system/search',
  })
  assert.deepEqual(contracts.validateCanonicalResourceIdentity(resource), resource)
  assert.deepEqual(
    {
      ...contracts.validateActionOperationTarget({
        operationId: 'mcp.invoke',
        resource,
        operationTarget: {
          serverNamespace: 'mcp-system',
          serverName: 'search',
          toolName: 'lookup',
        },
      }),
    },
    { serverNamespace: 'mcp-system', serverName: 'search', toolName: 'lookup' }
  )
  assert.throws(
    () =>
      contracts.validateActionOperationTarget({
        operationId: 'mcp.invoke',
        resource,
        operationTarget: {
          serverNamespace: 'mcp-system',
          serverName: 'substituted',
          toolName: 'lookup',
        },
      }),
    error => error.code === 'resource_mismatch'
  )
  assert.throws(() =>
    contracts.validateCanonicalResourceIdentity({ ...resource, canonicalId: 'host:spoofed' })
  )
})

test('workflow artifact list authority is run-scoped metadata access only', () => {
  const resource = contracts.canonicalResourceIdentity({
    environmentId: 'cluster.local/evenfire',
    type: 'workflow_run',
    logicalId: '11111111-1111-4111-8111-111111111111',
  })
  assert.deepEqual(
    {
      ...contracts.validateActionOperationTarget({
        operationId: 'workflow.artifact.list',
        resource,
        operationTarget: { runId: '11111111-1111-4111-8111-111111111111' },
      }),
    },
    { runId: '11111111-1111-4111-8111-111111111111' }
  )
  assert.throws(() =>
    contracts.validateActionOperationTarget({
      operationId: 'workflow.artifact.list',
      resource,
      operationTarget: {
        runId: '11111111-1111-4111-8111-111111111111',
        artifactName: 'output.txt',
      },
    })
  )
})

test('MCP caller methods classify to a closed operation surface', () => {
  const server = { serverNamespace: 'mcp-system', serverName: 'search' }
  assert.deepEqual(
    contracts.classifyMcpCallerOperation({
      ...server,
      method: 'tools/call',
      params: { name: 'lookup', arguments: { q: 'term' } },
    }),
    {
      status: 'classified',
      operationId: 'mcp.invoke',
      target: { serverNamespace: 'mcp-system', serverName: 'search', toolName: 'lookup' },
    }
  )
  assert.deepEqual(contracts.classifyMcpCallerOperation({ ...server, method: 'tools/list' }), {
    status: 'classified',
    operationId: 'mcp.tools.read',
    target: { serverNamespace: 'mcp-system', serverName: 'search' },
  })
  for (const method of ['initialize', 'notifications/initialized']) {
    assert.deepEqual(contracts.classifyMcpCallerOperation({ ...server, method }), {
      status: 'denied',
      code: 'internal_protocol_method',
    })
  }
  for (const method of ['ping', 'resources/list', 'prompts/list', 'completion/complete']) {
    assert.deepEqual(contracts.classifyMcpCallerOperation({ ...server, method }), {
      status: 'denied',
      code: 'unclassified_mcp_method',
    })
  }
})

test('checkpoint response accepts only strict server-derived destinations on allowed outcomes', () => {
  const behavior = Object.fromEntries(
    [
      'budget',
      'credentialPolicy',
      'approvalPolicy',
      'filesystemScope',
      'runtime',
      'providerModelPolicy',
      'audit',
    ].map(key => [key, { state: 'known', value: null }])
  )
  const allowed = {
    version: 2,
    status: 'allowed',
    authorizationRevision: `ar1_${'a'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'b'.repeat(43)}`,
    behavior,
    checkedAt: '2026-08-18T12:00:00.000Z',
    validUntil: '2026-08-18T12:00:30.000Z',
    attribution: {
      userId: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      sessionVersion: 2,
      accessPathId: `ap1_${'c'.repeat(43)}`,
      pathKind: 'team',
      effectiveTeamId: '33333333-3333-4333-8333-333333333333',
    },
    destination: {
      kind: 'host',
      ref: 'mcp-host/host-a',
      url: 'http://chatllm.mcp-host.svc.cluster.local:3000',
    },
  }
  assert.deepEqual(contracts.validateActionAuthorityCheckpointResponse(allowed), allowed)
  assert.deepEqual(
    contracts.validateActionAuthorityCheckpointResponse({ ...allowed, destination: null }),
    { ...allowed, destination: null }
  )
  assert.deepEqual(
    contracts.validateActionAuthorityCheckpointResponse({
      ...allowed,
      destination: {
        kind: 'mcp_server',
        ref: 'mcp-system/search',
        url: 'https://search.internal.example/rpc',
      },
    }).destination,
    {
      kind: 'mcp_server',
      ref: 'mcp-system/search',
      url: 'https://search.internal.example/rpc',
    }
  )
  for (const destination of [
    { kind: 'host', ref: 'not-namespaced', url: 'http://host.internal' },
    { kind: 'host', ref: 'mcp-host/host-b', url: 'file:///etc/passwd' },
    { kind: 'host', ref: 'mcp-host/host-a', url: 'http://host.internal', authority: true },
  ]) {
    assert.throws(() =>
      contracts.validateActionAuthorityCheckpointResponse({ ...allowed, destination })
    )
  }
})

test('checkpoint denied outcomes cannot carry a routing destination or omit version', () => {
  const denied = { version: 2, status: 'denied', code: 'forbidden' }
  assert.deepEqual(contracts.validateActionAuthorityCheckpointResponse(denied), denied)
  assert.throws(() =>
    contracts.validateActionAuthorityCheckpointResponse({
      ...denied,
      destination: { kind: 'host', ref: 'mcp-host/host-a', url: 'http://host.internal' },
    })
  )
  assert.throws(() =>
    contracts.validateActionAuthorityCheckpointResponse({ status: 'denied', code: 'forbidden' })
  )
})

test('Host-message checkpoint admission context and failures are exact bounded wire values', () => {
  const receipt = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`
  assert.deepEqual(
    contracts.validateHostMessageAdmissionContext({
      sendNonce: 'n'.repeat(43),
      delegationExpiresAt: 1_900_000_000,
    }),
    { sendNonce: 'n'.repeat(43), delegationExpiresAt: 1_900_000_000 }
  )
  assert.deepEqual(
    contracts.validateHostMessageAdmissionContext({
      sendNonce: 'n'.repeat(43),
      delegationExpiresAt: 1_900_000_000,
      receipt,
    }),
    { sendNonce: 'n'.repeat(43), delegationExpiresAt: 1_900_000_000, receipt }
  )
  for (const invalid of [
    { sendNonce: 'n'.repeat(42), delegationExpiresAt: 1_900_000_000 },
    { sendNonce: 'n'.repeat(43), delegationExpiresAt: 0 },
    { sendNonce: 'n'.repeat(43), delegationExpiresAt: 1_900_000_000, receipt, extra: true },
    { sendNonce: 'n'.repeat(43), delegationExpiresAt: 1_900_000_000, receipt: 'opaque' },
  ]) {
    assert.throws(() => contracts.validateHostMessageAdmissionContext(invalid))
  }
  assert.deepEqual(
    contracts.validateHostMessageAdmissionFailureResponse({
      error: 'Too Many Requests',
      retryAfterSeconds: 12,
    }),
    { error: 'Too Many Requests', retryAfterSeconds: 12 }
  )
  assert.deepEqual(
    contracts.validateHostMessageAdmissionFailureResponse({
      error: 'host_message_admission_unavailable',
    }),
    { error: 'host_message_admission_unavailable' }
  )
  assert.throws(() =>
    contracts.validateHostMessageAdmissionFailureResponse({
      error: 'Too Many Requests',
      retryAfterSeconds: 0,
    })
  )
  assert.throws(() =>
    contracts.validateHostMessageAdmissionFailureResponse({
      error: 'host_rpc_admission_unavailable',
    })
  )
  assert.deepEqual(
    contracts.validateHostRpcAdmissionFailureResponse({
      error: 'host_rpc_admission_unavailable',
    }),
    { error: 'host_rpc_admission_unavailable' }
  )
  assert.deepEqual(
    contracts.validateHostRpcAdmissionFailureResponse({
      error: 'Too Many Requests',
      retryAfterSeconds: 12,
    }),
    { error: 'Too Many Requests', retryAfterSeconds: 12 }
  )
  assert.throws(() =>
    contracts.validateHostRpcAdmissionFailureResponse({
      error: 'host_message_admission_unavailable',
    })
  )
})

test('message-retry wake contract is a separate same-Host source-binding variant', () => {
  const resource = contracts.canonicalResourceIdentity({
    environmentId: 'development:local',
    type: 'host',
    logicalId: 'default/chatllm',
    displayName: 'chatllm',
  })
  const target = contracts.canonicalActionTarget({
    hostRef: 'default/chatllm',
    channelType: 'rpc',
    channelId: 'chatllm',
    messageId: 'message-1',
  })
  const targetHash = contracts.hashActionTarget(target)
  const sourceBinding = Object.freeze({
    version: 2,
    principal: Object.freeze({
      sub: '10000000-0000-4000-8000-000000000001',
      sid: '20000000-0000-4000-8000-000000000002',
      sessionVersion: 1,
    }),
    delegationJti: '30000000-0000-4000-8000-000000000003',
    resource,
    operationId: 'chat.message.invoke',
    target,
    targetHash,
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    domain: Object.freeze({ service: 'rpc-proxy', resource, targetHash }),
  })
  const wire = contracts.createMessageRetryHostWakeRequest(sourceBinding)
  assert.deepEqual(wire, { sourceBinding, wakeReason: 'message_retry' })
  assert.deepEqual(contracts.validateActionAuthorityHostWakeRequest(wire), {
    kind: 'message_retry',
    sourceBinding,
    wakeReason: 'message_retry',
  })
  const derived = contracts.deriveMessageRetryHostWakeCheckpoint(sourceBinding, 'default/chatllm')
  assert.equal(derived.operationId, 'host.wake')
  assert.deepEqual(
    { ...derived.target },
    {
      hostRef: 'default/chatllm',
      wakeReason: 'message_retry',
    }
  )
  assert.equal(derived.targetHash, contracts.hashActionTarget(derived.target))
  assert.equal(derived.domain.targetHash, derived.targetHash)
  assert.equal(Object.hasOwn(derived, 'hostMessageAdmission'), false)
  assert.throws(() =>
    contracts.createMessageRetryHostWakeRequest({
      ...sourceBinding,
      hostMessageAdmission: { sendNonce: 'n'.repeat(43), delegationExpiresAt: 1_900_000_000 },
    })
  )
  assert.throws(() =>
    contracts.deriveMessageRetryHostWakeCheckpoint(sourceBinding, 'default/other')
  )
  assert.throws(() =>
    contracts.validateActionAuthorityHostWakeRequest({
      sourceBinding,
      wakeReason: 'explicit',
    })
  )
})
