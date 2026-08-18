import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AuthorityBindingV2,
  canonicalResourceIdentity,
  hashActionTarget,
} from '@clerum/action-context-contracts'
import type { McpHostRuntimeAuth } from '../workflow/userApprovalRequester'

const runtimeAuth = vi.hoisted(() => ({ refreshWithRecovery: vi.fn() }))
vi.mock('../workflow/userApprovalRequester', () => runtimeAuth)

const {
  checkpointMcpHostActionAuthority,
  mcpHostActionAuthorityCheckpointRequest,
  McpHostActionAuthorityCheckpointError,
} = await import('./actionAuthorityCheckpointClient')

const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: 'host',
  logicalId: 'mcp-host/chatllm',
})
const target = Object.freeze({ hostRef: 'mcp-host/chatllm' })
const binding: AuthorityBindingV2 = Object.freeze({
  version: 2,
  userId: '10000000-0000-4000-8000-000000000001',
  sid: '20000000-0000-4000-8000-000000000002',
  sessionVersion: 1,
  delegationJti: '30000000-0000-4000-8000-000000000003',
  operationId: 'host.status.read',
  resource,
  target,
  targetHash: hashActionTarget(target),
  accessPathId: `ap1_${'a'.repeat(43)}`,
  authorizationRevision: `ar1_${'b'.repeat(43)}`,
  pathKind: 'direct',
  effectiveTeamId: null,
  behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
})

function auth(): McpHostRuntimeAuth {
  return {
    accessToken: 'runtime-access-one',
    refreshToken: 'runtime-refresh',
    baseUrl: 'http://control-api.test:8090',
    hostRef: 'chatllm',
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
  }
}

function allowed() {
  return {
    version: 2,
    status: 'allowed',
    authorizationRevision: binding.authorizationRevision,
    behaviorBindingHash: binding.behaviorBindingHash,
    behavior: {
      budget: { state: 'known', value: null },
      credentialPolicy: { state: 'known', value: null },
      approvalPolicy: { state: 'known', value: null },
      filesystemScope: { state: 'known', value: null },
      runtime: { state: 'known', value: null },
      providerModelPolicy: { state: 'known', value: null },
      audit: { state: 'known', value: binding.userId },
    },
    checkedAt: '2026-08-18T12:00:00.000Z',
    validUntil: null,
    attribution: {
      userId: binding.userId,
      sid: binding.sid,
      sessionVersion: binding.sessionVersion,
      accessPathId: binding.accessPathId,
      pathKind: binding.pathKind,
      effectiveTeamId: binding.effectiveTeamId,
    },
    destination: {
      kind: 'host',
      ref: resource.logicalId,
      url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
    },
  }
}

describe('mcp-host action-authority checkpoint client', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits the strict mcp-host domain binding with the existing runtime bearer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(allowed()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    const credential = auth()

    await expect(
      checkpointMcpHostActionAuthority(binding, credential, fetchImpl)
    ).resolves.toMatchObject({ status: 'allowed' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://control-api.test:8090/api/v1/internal/action-authority/checkpoint')
    expect(init.headers).toEqual({
      authorization: 'Bearer runtime-access-one',
      'content-type': 'application/json',
    })
    expect(JSON.parse(init.body)).toEqual(mcpHostActionAuthorityCheckpointRequest(binding))
  })

  it('refreshes the existing runtime credential once after 401 and retries with its new token', async () => {
    const credential = auth()
    runtimeAuth.refreshWithRecovery.mockImplementation(async () => {
      credential.accessToken = 'runtime-access-two'
    })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(allowed()), { status: 200 }))

    await checkpointMcpHostActionAuthority(binding, credential, fetchImpl)

    expect(runtimeAuth.refreshWithRecovery).toHaveBeenCalledWith(credential)
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer runtime-access-one')
    expect(fetchImpl.mock.calls[1][1].headers.authorization).toBe('Bearer runtime-access-two')
  })

  it('fails closed when Control returns a malformed or status-mismatched envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(allowed()), { status: 503 }))

    await expect(checkpointMcpHostActionAuthority(binding, auth(), fetchImpl)).rejects.toEqual(
      new McpHostActionAuthorityCheckpointError('authority_unavailable')
    )
  })
})
