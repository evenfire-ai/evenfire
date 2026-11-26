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

test('no production source still reads or sends the removed static rpc-proxy edge token', () => {
  const { execFileSync, spawnSync } = require('node:child_process')
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: __dirname,
    encoding: 'utf8',
  }).trim()
  const sourcePathspec = [
    '--',
    '.',
    ':!docs',
    ':!*.md',
    ':!*.test.*',
    ':!**/__tests__/**',
    ':!**/test/**',
    ':!tests/**',
  ]
  const grep = (pattern) =>
    spawnSync('git', ['grep', '-n', '-E', pattern, ...sourcePathspec], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
  // Liveness witness: the same pathspec finds the assertion header the forwarders now send.
  const witness = grep('x-clerum-edge-assertion|HOST_EDGE_ASSERTION_HEADER')
  assert.equal(witness.status, 0, witness.stderr)
  assert.ok(witness.stdout.includes('rpc-proxy/src/'), 'witness must reach rpc-proxy source')
  assert.ok(witness.stdout.includes('mcp-host/src/'), 'witness must reach mcp-host source')
  const removed = grep(
    'RPC_PROXY_MCP_HOST_EDGE_TOKEN|MCP_HOST_RPC_PROXY_EDGE_TOKEN|rpcProxyServiceAuthenticated|parseRpcProxyEdgeToken|rpcProxyEdgeToken|mcpHostEdgeToken|x-clerum-rpc-proxy-edge-token'
  )
  assert.equal(removed.status, 1, `static edge token still referenced:\n${removed.stdout}`)
})

test('Host edge assertion constants pin the wire contract and no static edge token remains', () => {
  assert.equal(contracts.HOST_EDGE_ASSERTION_HEADER, 'x-clerum-edge-assertion')
  assert.equal(contracts.HOST_EDGE_ASSERTION_AUDIENCE, 'evenfire-host-runtime-edge')
  assert.equal(contracts.HOST_EDGE_ASSERTION_JWT_TYPE, 'host-edge-assertion+jwt')
  assert.equal(contracts.HOST_EDGE_ASSERTION_CLAIM_TYPE, 'host_edge_assertion')
  assert.equal(contracts.HOST_EDGE_ASSERTION_MAX_TTL_SECONDS, 300)
  assert.equal(contracts.HOST_EDGE_ASSERTION_MAX_IAT_SKEW_SECONDS, 5)
  assert.equal(Object.isFrozen(contracts.HOST_EDGE_RPC_PROXY_ROUTE_SCOPES), true)
  assert.equal(Object.keys(contracts.HOST_EDGE_RPC_PROXY_ROUTE_SCOPES).length, 19)
  assert.equal('RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER' in contracts, false)
  assert.equal('RPC_PROXY_MCP_HOST_EDGE_TOKEN_DEV_DEFAULT' in contracts, false)
})

test('Host edge route scope map pins the scope of each of the 19 Host routes', () => {
  assert.deepEqual(contracts.HOST_EDGE_RPC_PROXY_ROUTE_SCOPES, {
    'GET /v1/runtime/status': 'host:status:read',
    'GET /v1/runtime/activity': 'host:activity:read',
    'GET /v1/runtime/activity/stream': 'host:activity:read',
    'POST /v1/runtime/messages': 'host:message:invoke',
    'POST /v1/runtime/approvals/approve': 'host:approval:write',
    'POST /v1/runtime/approvals/deny': 'host:approval:write',
    'GET /v1/runtime/sessions/search': 'host:session:read',
    'GET /v1/runtime/sessions': 'host:session:read',
    'GET /v1/runtime/sessions/:agent/:chatId/messages': 'host:session:read',
    'GET /v1/runtime/sessions/:agent/:chatId/context-breakdown': 'host:session:read',
    'GET /v1/runtime/tasks/:taskId/result': 'host:message:invoke',
    'POST /v1/runtime/tasks/:taskId/cancel': 'host:message:invoke',
    'GET /v1/runtime/models': 'host:session:read',
    'POST /v1/runtime/model': 'host:model:write',
    'PATCH /v1/runtime/sessions/:agent/:chatId/name': 'host:session:write',
    'PATCH /v1/runtime/sessions/:agent/:chatId/approval-mode': 'host:approval:write',
    'GET /v1/runtime/tasks/:taskId/progress/stream': 'host:activity:read',
    'GET /v1/runtime/artifacts': 'host:task:read',
    'GET /v1/runtime/artifacts/:filename/download': 'host:task:read',
  })
})

test('overlong normalized titles skip unbounded code-point array materialization', () => {
  const originalFrom = Array.from
  let calls = 0
  let longResult
  Array.from = function (...args) {
    calls += 1
    return originalFrom.apply(this, args)
  }
  try {
    longResult = contracts.validateSessionRenameTitle('😀'.repeat(121))
  } finally {
    Array.from = originalFrom
  }

  assert.deepEqual(longResult, { ok: false, error: 'invalid title' })
  assert.equal(calls, 0)

  assert.deepEqual(contracts.validateSessionRenameTitle('😀'.repeat(120)), {
    ok: true,
    title: '😀'.repeat(120),
  })
})

test('session cursor encoding and validation share the runtime wire contract', () => {
  const scope = contracts.sessionsCursorScope('user-a', 'chatllm')
  const cursor = contracts.encodeSessionsCursor('2026-04-22T00:00:00.000Z', 'session-a', scope)
  assert.deepEqual(contracts.decodeSessionsCursor(cursor, scope), {
    version: 1,
    scope,
    updatedAt: '2026-04-22T00:00:00.000Z',
    key: 'session-a',
  })
  assert.equal(
    contracts.decodeSessionsCursor(cursor, contracts.sessionsCursorScope('user-b')),
    null
  )
  assert.equal(contracts.decodeSessionsCursor('not-json', scope), null)
  assert.equal(contracts.decodeSessionsCursor('', scope), null)
})

test('Host activity limits preserve the producer range and reject invalid numbers', () => {
  assert.deepEqual(contracts.validateHostActivityLimit(undefined), { ok: true, limit: 50 })
  assert.deepEqual(contracts.validateHostActivityLimit('25'), { ok: true, limit: 25 })
  for (const invalid of ['0', '-1', 'not-a-number', 'Infinity', 'NaN']) {
    assert.deepEqual(contracts.validateHostActivityLimit(invalid), {
      ok: false,
      error: 'limit must be a positive number',
    })
  }
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
  const hostEdgeAssertion = 'eyJhbGciOiJSUzI1NiJ9.eyJ2IjoyfQ.c2lnbmF0dXJl'
  assert.equal(
    contracts.validateActionAuthorityCheckpointResponse({ ...allowed, hostEdgeAssertion })
      .hostEdgeAssertion,
    hostEdgeAssertion
  )
  for (const refused of [
    { ...allowed, destination: null, hostEdgeAssertion },
    {
      ...allowed,
      destination: {
        kind: 'mcp_server',
        ref: 'mcp-system/search',
        url: 'https://search.internal.example/rpc',
      },
      hostEdgeAssertion,
    },
    { ...allowed, hostEdgeAssertion: 'not-a-jws' },
    { ...allowed, hostEdgeAssertion: 42 },
    { ...allowed, hostEdgeAssertion: `${'a'.repeat(8190)}.b.c` },
  ]) {
    assert.throws(() => contracts.validateActionAuthorityCheckpointResponse(refused))
  }
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

const {
  generateKeyPairSync,
  randomUUID,
  sign: cryptoSign,
  verify: cryptoVerify,
} = require('node:crypto')

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

// A test signer that mirrors the control-api producer: RS256 compact JWS with the header typ, the
// issuer, the audience constant, a UUID jti and an expiry bounded by the maximum lifetime. The
// round trip through the real producer runs in control-api
// (test/routes.rpcAccessUsers.hostEdgeAssertion.test.ts and
// test/routes.internalActionAuthorityCheckpoint.hostEdgeAssertion.test.ts).
function signEdgeAssertion(privateKey, claims) {
  const header = { alg: 'RS256', typ: contracts.HOST_EDGE_ASSERTION_JWT_TYPE }
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), privateKey).toString(
    'base64url'
  )
  return `${signingInput}.${signature}`
}

// Verifies and decodes the way the Host receives the token, returning the decoded payload.
function verifyEdgeAssertion(publicKey, token) {
  const [encodedHeader, encodedPayload, signature] = token.split('.')
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
  assert.deepEqual(header, { alg: 'RS256', typ: 'host-edge-assertion+jwt' })
  assert.equal(
    cryptoVerify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(signature, 'base64url')
    ),
    true
  )
  return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
}

const edgeKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const EDGE_ISSUER = 'fixture-control-api-issuer'
const EDGE_HOST = 'hosts/fixture-host'
const EDGE_IAT = 1_900_000_000
// The verifier clock of the existing rows: the second the fixtures were issued.
const EDGE_NOW = EDGE_IAT

function v1Claims(overrides = {}) {
  return {
    typ: contracts.HOST_EDGE_ASSERTION_CLAIM_TYPE,
    v: 1,
    iss: EDGE_ISSUER,
    aud: contracts.HOST_EDGE_ASSERTION_AUDIENCE,
    sub: 'user-fixture-1',
    host: EDGE_HOST,
    jti: randomUUID(),
    iat: EDGE_IAT,
    exp: EDGE_IAT + 300,
    teamId: 'team-fixture-1',
    scopes: ['host:status:read', 'host:message:invoke'],
    ...overrides,
  }
}

const V1_EXPECTED = Object.freeze({
  v: 1,
  iss: EDGE_ISSUER,
  host: EDGE_HOST,
  sub: 'user-fixture-1',
  teamId: 'team-fixture-1',
  requiredScope: 'host:status:read',
})

const V2_BOUND = Object.freeze({
  operationId: 'host.status.read',
  delegationJti: randomUUID(),
  sid: 'session-fixture-1',
  sessionVersion: 3,
  accessPathId: 'access-path-fixture-1',
  pathKind: 'team',
  effectiveTeamId: 'team-fixture-1',
  resource: { type: 'host', logicalId: 'fixture-host' },
  targetHash: 'ath2_fixture',
  authorizationRevision: 'revision-fixture-1',
  behaviorBindingHash: 'bh2_fixture',
  checkedAt: '2030-03-17T17:46:40.000Z',
})

function v2Claims(overrides = {}) {
  return {
    typ: contracts.HOST_EDGE_ASSERTION_CLAIM_TYPE,
    v: 2,
    iss: EDGE_ISSUER,
    aud: contracts.HOST_EDGE_ASSERTION_AUDIENCE,
    sub: 'user-fixture-1',
    host: EDGE_HOST,
    jti: randomUUID(),
    iat: EDGE_IAT,
    exp: EDGE_IAT + 120,
    ...V2_BOUND,
    ...overrides,
  }
}

const V2_EXPECTED = Object.freeze({
  v: 2,
  iss: EDGE_ISSUER,
  host: EDGE_HOST,
  sub: 'user-fixture-1',
  ...V2_BOUND,
})

test('signed round trip: a V1 assertion signed by the test signer decodes to a payload the validator accepts', () => {
  const payload = verifyEdgeAssertion(
    edgeKeys.publicKey,
    signEdgeAssertion(edgeKeys.privateKey, v1Claims())
  )
  assert.deepEqual(Object.keys(payload), [...contracts.HOST_EDGE_ASSERTION_V1_CLAIM_KEYS])
  assert.deepEqual(contracts.validateHostEdgeAssertionClaims(payload, V1_EXPECTED, EDGE_NOW), {
    ok: true,
  })
})

test('signed round trip: a V2 assertion signed by the test signer decodes to a payload the validator accepts', () => {
  const payload = verifyEdgeAssertion(
    edgeKeys.publicKey,
    signEdgeAssertion(edgeKeys.privateKey, v2Claims())
  )
  assert.deepEqual(Object.keys(payload), [...contracts.HOST_EDGE_ASSERTION_V2_CLAIM_KEYS])
  assert.deepEqual(contracts.validateHostEdgeAssertionClaims(payload, V2_EXPECTED, EDGE_NOW), {
    ok: true,
  })
})

test('V1 claims: key set, registered claims, lifetime, binding and route scope are enforced', () => {
  assert.deepEqual(contracts.validateHostEdgeAssertionClaims(v1Claims(), V1_EXPECTED, EDGE_NOW), {
    ok: true,
  })
  const { teamId: _omitted, ...missingTeam } = v1Claims()
  const cases = [
    [missingTeam, 'claim keys do not match the declared version'],
    [{ ...v1Claims(), extra: true }, 'claim keys do not match the declared version'],
    [{ ...v1Claims(), ...V2_BOUND }, 'claim keys do not match the declared version'],
    [v1Claims({ v: 2 }), 'version mismatch'],
    [v1Claims({ typ: 'other' }), 'typ mismatch'],
    [v1Claims({ aud: 'rpc-proxy' }), 'aud mismatch'],
    [v1Claims({ iss: 'other-issuer' }), 'iss mismatch'],
    [v1Claims({ jti: 'not-a-uuid' }), 'jti must be a UUID'],
    [v1Claims({ iat: 1.5 }), 'iat and exp must be whole seconds'],
    [v1Claims({ exp: EDGE_IAT }), 'lifetime out of bounds'],
    [v1Claims({ exp: EDGE_IAT + 301 }), 'lifetime out of bounds'],
    [v1Claims({ host: 'hosts/other' }), 'host mismatch'],
    [v1Claims({ sub: 'user-other' }), 'sub mismatch'],
    [v1Claims({ teamId: 7 }), 'teamId must be a string or null'],
    [v1Claims({ teamId: null }), 'teamId mismatch'],
    [v1Claims({ teamId: 'team-other' }), 'teamId mismatch'],
    [v1Claims({ scopes: [] }), 'scopes must be a non-empty array of strings'],
    [v1Claims({ scopes: ['host:status:read', 3] }), 'scopes must be a non-empty array of strings'],
    [v1Claims({ scopes: ['host:message:invoke'] }), 'route scope missing'],
  ]
  for (const [payload, error] of cases) {
    assert.deepEqual(contracts.validateHostEdgeAssertionClaims(payload, V1_EXPECTED, EDGE_NOW), {
      ok: false,
      error,
    })
  }
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(
      v1Claims({ teamId: null }),
      { ...V1_EXPECTED, teamId: null },
      EDGE_NOW
    ),
    { ok: true }
  )
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(
      v1Claims(),
      { ...V1_EXPECTED, requiredScope: '' },
      EDGE_NOW
    ),
    { ok: false, error: 'expected requiredScope is missing' }
  )
})

test('V2 claims: every bound field must equal the expectation', () => {
  for (const key of Object.keys(V2_BOUND)) {
    const changedValue = key === 'sessionVersion' ? 4 : `${JSON.stringify(V2_BOUND[key])}-x`
    assert.deepEqual(
      contracts.validateHostEdgeAssertionClaims(
        v2Claims({ [key]: changedValue }),
        V2_EXPECTED,
        EDGE_NOW
      ),
      { ok: false, error: `${key} mismatch` }
    )
  }
  const { checkedAt: _omitted, ...expectationWithoutCheckedAt } = V2_EXPECTED
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(v2Claims(), expectationWithoutCheckedAt, EDGE_NOW),
    { ok: false, error: 'expected checkedAt is missing' }
  )
  assert.deepEqual(contracts.validateHostEdgeAssertionClaims(v2Claims(), V1_EXPECTED, EDGE_NOW), {
    ok: false,
    error: 'version mismatch',
  })
})

test('validator refuses a non-object payload and an unknown expected version', () => {
  assert.deepEqual(contracts.validateHostEdgeAssertionClaims(null, V1_EXPECTED, EDGE_NOW), {
    ok: false,
    error: 'payload must be an object',
  })
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(v1Claims(), { ...V1_EXPECTED, v: 3 }, EDGE_NOW),
    { ok: false, error: 'expected version must be 1 or 2' }
  )
})

test('validator refuses an iat more than the allowed skew ahead of the verifier clock', () => {
  const yearAhead = EDGE_NOW + 31_536_000
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(
      v1Claims({ iat: yearAhead, exp: yearAhead + 300 }),
      V1_EXPECTED,
      EDGE_NOW
    ),
    { ok: false, error: 'iat is in the future' }
  )
  // Liveness witness: the same claims issued at the verifier clock pass.
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(
      v1Claims({ iat: EDGE_NOW, exp: EDGE_NOW + 300 }),
      V1_EXPECTED,
      EDGE_NOW
    ),
    { ok: true }
  )
})

test('validator accepts an iat up to 5 seconds ahead of the verifier clock and refuses 6', () => {
  for (const [version, claims, expected] of [
    ['v1', v1Claims, V1_EXPECTED],
    ['v2', v2Claims, V2_EXPECTED],
  ]) {
    const atSkew = EDGE_NOW + 5
    assert.deepEqual(
      contracts.validateHostEdgeAssertionClaims(
        claims({ iat: atSkew, exp: atSkew + 120 }),
        expected,
        EDGE_NOW
      ),
      { ok: true },
      version
    )
    const pastSkew = EDGE_NOW + 6
    assert.deepEqual(
      contracts.validateHostEdgeAssertionClaims(
        claims({ iat: pastSkew, exp: pastSkew + 120 }),
        expected,
        EDGE_NOW
      ),
      { ok: false, error: 'iat is in the future' },
      version
    )
  }
})

test('validator requires the verifier clock in whole seconds', () => {
  for (const nowSeconds of [undefined, 1.5, 0]) {
    assert.deepEqual(
      contracts.validateHostEdgeAssertionClaims(v1Claims(), V1_EXPECTED, nowSeconds),
      { ok: false, error: 'verifier clock must be whole seconds' },
      String(nowSeconds)
    )
  }
  // Liveness witness: the same payload passes with a whole-second clock.
  assert.deepEqual(contracts.validateHostEdgeAssertionClaims(v1Claims(), V1_EXPECTED, EDGE_NOW), {
    ok: true,
  })
})

test('validator refuses a verifier clock that is not in seconds', () => {
  // With a millisecond clock the future-iat bound could never fire: this assertion a year
  // ahead of the verifier must not be accepted.
  const yearAhead = EDGE_NOW + 31_536_000
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(
      v1Claims({ iat: yearAhead, exp: yearAhead + 300 }),
      V1_EXPECTED,
      EDGE_NOW * 1000
    ),
    { ok: false, error: 'verifier clock must be whole seconds' }
  )
  for (const clock of [EDGE_NOW * 1000, Date.now(), 100_000_000_000]) {
    assert.deepEqual(
      contracts.validateHostEdgeAssertionClaims(v1Claims(), V1_EXPECTED, clock),
      { ok: false, error: 'verifier clock must be whole seconds' },
      String(clock)
    )
  }
  // Liveness witness: the same payload passes with the clock in seconds, and the largest
  // clock the validator takes as seconds still reaches the claim checks.
  assert.deepEqual(contracts.validateHostEdgeAssertionClaims(v1Claims(), V1_EXPECTED, EDGE_NOW), {
    ok: true,
  })
  const lastSecond = 99_999_999_999
  assert.deepEqual(
    contracts.validateHostEdgeAssertionClaims(
      v1Claims({ iat: lastSecond, exp: lastSecond + 300 }),
      V1_EXPECTED,
      lastSecond
    ),
    { ok: true }
  )
})
