import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'crypto'
import { config as hccConfig } from '../config'
import { HostReconciler, type ResolvedSfsMount } from '../hostReconciler'
import { issueMcpHostRuntimeTokens } from '../mcpHostRuntimeTokenIssuerClient'
import type { HostCRD } from '../types'
import { canonicalStringify } from '../utils'

vi.mock('../mcpHostRuntimeTokenIssuerClient', () => ({
  issueMcpHostRuntimeTokens: vi.fn().mockResolvedValue({
    accessToken: 'runtime-access-token',
    refreshToken: 'runtime-refresh-token',
    mcpHostControlToken: 'workflow-control-token',
    channelReaderMessageToken: 'channel-reader-message-token',
    channelReaderApprovalToken: 'channel-reader-approval-token',
    channelReaderWorkflowApprovalDecisionToken: 'channel-reader-decision-token',
    channelReaderActivityToken: 'channel-reader-activity-token',
    channelReaderCronReadToken: 'channel-reader-cron-read-token',
    channelReaderCronAckToken: 'channel-reader-cron-ack-token',
    expiresInSeconds: 300,
    refreshExpiresInSeconds: 3600,
    controlExpiresInSeconds: 300,
    channelReaderMessageExpiresInSeconds: 300,
    channelReaderApprovalExpiresInSeconds: 300,
    channelReaderWorkflowApprovalDecisionExpiresInSeconds: 300,
    channelReaderActivityExpiresInSeconds: 300,
    channelReaderCronReadExpiresInSeconds: 300,
    channelReaderCronAckExpiresInSeconds: 300,
  }),
}))

vi.mock('../gfsHostBinding', () => ({
  mintHostGfsToken: vi
    .fn()
    .mockImplementation(async ({ name, namespace }: { name: string; namespace: string }) => ({
      token: 'gfs-runtime-value',
      expiresInSeconds: 300,
      subject: `host:1st:${namespace}/${name}`,
    })),
}))

// Stand-in KubeConfig that returns a stub for every makeApiClient — buildDeployment
// is a pure function that doesn't touch the API but the constructor still resolves
// these.
function makeStubKc(): k8s.KubeConfig {
  const stub = new Proxy(
    {},
    {
      get: () => vi.fn(),
    }
  )
  return {
    makeApiClient: () => stub,
  } as unknown as k8s.KubeConfig
}

function makeHost(): HostCRD {
  return {
    name: 'team-mission',
    namespace: 'mcp-host',
    spec: {
      host: 'team-mission',
      contextRef: 'team-mission-ctx',
      secretRef: 'team-mission-secret',
    },
  }
}

beforeEach(() => {
  vi.mocked(issueMcpHostRuntimeTokens).mockClear()
})

const ACCESS_KEY = 'mcp-host-runtime-access-token'
const REFRESH_KEY = 'mcp-host-runtime-refresh-token'
const CONTROL_KEY = 'mcp-host-workflow-control-token'
const GFS_KEY = 'mcp-host-gfs-token'
const CHANNEL_READER_MESSAGE_KEY = 'mcp-host-message-token'
const CHANNEL_READER_APPROVAL_KEY = 'mcp-host-approval-token'
const CHANNEL_READER_DECISION_KEY = 'mcp-host-workflow-approval-decision-token'
const CHANNEL_READER_ACTIVITY_KEY = 'mcp-host-activity-token'
const CHANNEL_READER_CRON_READ_KEY = 'mcp-host-cron-read-token'
const CHANNEL_READER_CRON_ACK_KEY = 'mcp-host-cron-ack-token'
const BOOTSTRAP_STATE_KEY = 'clerum.io/' + ['runtime', 'token', 'bootstrap', 'state'].join('-')

type BootstrapOptions = {
  forceFreshForWake?: boolean
  targetSuspended?: boolean
}

type RuntimeTokenProvision = {
  revision: string
  scopeHash: string
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Unsigned-looking JWT with a numeric `exp` claim -- HCC only decodes, never verifies. */
function fakeJwt(expEpochSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ exp: expEpochSec }))
  return `${header}.${payload}.fake-signature`
}

const FAR_FUTURE_EXP_SEC = Math.floor(Date.parse('2999-01-01T00:00:00.000Z') / 1000)

function runtimeSecret(
  host = makeHost(),
  annotations: Record<string, string> = {},
  refreshToken: string = fakeJwt(FAR_FUTURE_EXP_SEC)
): k8s.V1Secret {
  return {
    metadata: {
      name: `host-${host.name}-mcp-host-runtime-tokens`,
      namespace: host.namespace,
      resourceVersion: 'rv-1',
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/host': host.name,
        'clerum.io/component': 'mcp-host-runtime-token',
      },
      annotations,
    },
    data: {
      [ACCESS_KEY]: b64('runtime-access-existing'),
      [REFRESH_KEY]: b64(refreshToken),
      [CONTROL_KEY]: b64('workflow-control-existing'),
      [GFS_KEY]: b64('gfs-runtime-existing'),
    },
  }
}

function channelReaderRuntimeAuthSecret(host = makeHost()): k8s.V1Secret {
  return {
    metadata: {
      name: `channel-reader-${host.name}-mcp-host-runtime-auth`,
      namespace: 'channels',
      resourceVersion: 'rv-channel-reader',
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/host': host.name,
        'clerum.io/component': 'channel-reader',
        'clerum.io/secret-purpose': 'mcp-host-runtime-auth',
      },
    },
    data: {
      [CHANNEL_READER_MESSAGE_KEY]: b64('channel-reader-message-existing'),
      [CHANNEL_READER_APPROVAL_KEY]: b64('channel-reader-approval-existing'),
      [CHANNEL_READER_DECISION_KEY]: b64('channel-reader-decision-existing'),
      [CHANNEL_READER_ACTIVITY_KEY]: b64('channel-reader-activity-existing'),
      [CHANNEL_READER_CRON_READ_KEY]: b64('channel-reader-cron-read-existing'),
      [CHANNEL_READER_CRON_ACK_KEY]: b64('channel-reader-cron-ack-existing'),
    },
  }
}

function readSecretWithChannelReaderRuntimeAuthLabels(host = makeHost()) {
  return vi.fn(async ({ name, namespace }: { name?: string; namespace?: string } = {}) => {
    if (namespace === 'channels' && name === `channel-reader-${host.name}-mcp-host-runtime-auth`) {
      return channelReaderRuntimeAuthSecret(host)
    }
    return {}
  })
}

function runtimeSecretAnnotations(host = makeHost(), refreshBefore = '2999-01-01T00:00:00.000Z') {
  const helper = HostReconciler as unknown as {
    runtimeTokenHostBindingHash: (h: HostCRD) => string
    runtimeTokenScopeHash: (h: HostCRD) => string
    gfsCapabilitySetHash: () => string
  }
  return {
    'clerum.io/runtime-token-host-binding-hash': helper.runtimeTokenHostBindingHash(host),
    'clerum.io/runtime-token-scope-hash': helper.runtimeTokenScopeHash(host),
    'clerum.io/runtime-token-issuer': 'control-api',
    'clerum.io/runtime-token-audience': 'workflow-approvals',
    'clerum.io/runtime-token-schema-version': '2',
    'clerum.io/gfs-token-expected-subject': `host:1st:${host.namespace}/${host.name}`,
    'clerum.io/gfs-token-capability-set-hash': helper.gfsCapabilitySetHash(),
    'clerum.io/runtime-token-refresh-before': refreshBefore,
    'clerum.io/gfs-token-refresh-before': '2999-01-01T00:00:00.000Z',
  }
}

function deploymentWithRevision(
  revision: string,
  readyReplicas = 1,
  annotations: Record<string, string> = {},
  replicas = 1
): k8s.V1Deployment {
  return {
    metadata: { name: 'team-mission', namespace: 'mcp-host' },
    spec: {
      replicas,
      template: {
        metadata: {
          annotations: { ...annotations, 'clerum.io/runtime-token-revision': revision },
        },
        spec: { containers: [] },
      },
    },
    status: { readyReplicas },
  } as unknown as k8s.V1Deployment
}

function runtimeSecretReconciler(opts: {
  secret?: k8s.V1Secret
  channelReaderSecret?: k8s.V1Secret
  deployment?: k8s.V1Deployment | null
}) {
  const host = makeHost()
  const coreApi = {
    readNamespacedSecret: vi.fn(async ({ namespace }: { namespace?: string } = {}) => {
      const secret =
        namespace === 'channels'
          ? (opts.channelReaderSecret ?? channelReaderRuntimeAuthSecret(host))
          : opts.secret
      if (!secret) {
        const err = new Error('not found') as Error & { code: number }
        err.code = 404
        throw err
      }
      return secret
    }),
    createNamespacedSecret: vi.fn(async () => ({})),
    replaceNamespacedSecret: vi.fn(
      async (_request: { name?: string; namespace?: string; body: k8s.V1Secret }) => ({})
    ),
  }
  const appsApi = {
    readNamespacedDeployment: vi.fn(async () => {
      if (opts.deployment === null) {
        const err = new Error('not found') as Error & { code: number }
        err.code = 404
        throw err
      }
      return opts.deployment ?? deploymentWithRevision('deployed-revision')
    }),
  }
  const reconciler = new HostReconciler(makeStubKc(), {
    coreApi: coreApi as unknown as k8s.CoreV1Api,
    appsApi: appsApi as unknown as k8s.AppsV1Api,
  })
  return { reconciler, coreApi, appsApi }
}

function replacedRuntimeSecret(
  coreApi: ReturnType<typeof runtimeSecretReconciler>['coreApi']
): k8s.V1Secret {
  const request = coreApi.replaceNamespacedSecret.mock.calls
    .map(([arg]) => arg)
    .find(
      ({ namespace, body }) => namespace !== 'channels' || body.metadata?.namespace !== 'channels'
    )
  expect(request).toBeDefined()
  return request!.body
}

describe('HostReconciler runtime credential Secret revision', () => {
  it('computes a token-sensitive revision from stringData rather than the empty data hash', () => {
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (
        secret: Pick<k8s.V1Secret, 'data' | 'stringData'>
      ) => string | null
    }
    const left = helper.runtimeTokenSecretRevisionFromSecret({
      stringData: {
        [ACCESS_KEY]: 'runtime-access-a',
        [REFRESH_KEY]: 'runtime-refresh-a',
        [CONTROL_KEY]: 'workflow-control-a',
        [GFS_KEY]: 'gfs-runtime-a',
      },
    })
    const right = helper.runtimeTokenSecretRevisionFromSecret({
      stringData: {
        [ACCESS_KEY]: 'runtime-access-b',
        [REFRESH_KEY]: 'runtime-refresh-b',
        [CONTROL_KEY]: 'workflow-control-b',
        [GFS_KEY]: 'gfs-runtime-b',
      },
    })
    const emptyInputHash = createHash('sha256').update(JSON.stringify([])).digest('hex')

    expect(left).toMatch(/^[a-f0-9]{64}$/)
    expect(right).toMatch(/^[a-f0-9]{64}$/)
    expect(left).not.toBe(emptyInputHash)
    expect(right).not.toBe(emptyInputHash)
    expect(left).not.toBe(right)
  })

  it('does not issue credentials or change the rollout revision for a current Secret', async () => {
    const host = makeHost()
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: runtimeSecret(host, runtimeSecretAnnotations(host)),
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('rotates and rolls a legacy fleet-wide GFS token contract', async () => {
    const host = makeHost()
    const legacyAnnotations = {
      ...runtimeSecretAnnotations(host),
      'clerum.io/runtime-token-schema-version': '1',
    }
    const legacySecret = runtimeSecret(host, legacyAnnotations)
    const helper = HostReconciler as unknown as {
      runtimeTokenRefreshDecision: (
        h: HostCRD,
        secret: k8s.V1Secret,
        nowMs: number
      ) => { refresh: boolean; rolloutRequired: boolean; reason: string }
      runtimeTokenSecretRevisionFromSecret: (value: k8s.V1Secret) => string | null
    }
    expect(helper.runtimeTokenRefreshDecision(host, legacySecret, Date.now())).toMatchObject({
      refresh: true,
      rolloutRequired: true,
      reason: 'contract_changed',
    })

    const legacyRevision = helper.runtimeTokenSecretRevisionFromSecret(legacySecret)!
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: legacySecret,
      deployment: deploymentWithRevision(legacyRevision, 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    expect(result.revision).not.toBe(legacyRevision)
    expect(replacedRuntimeSecret(coreApi).metadata?.annotations).toMatchObject({
      'clerum.io/runtime-token-schema-version': '2',
      'clerum.io/runtime-token-rollout-required': 'true',
    })
  })

  it('keeps a matching fresh bootstrap stable while booting, then marks it consumed when Ready', async () => {
    // A fresh Secret already matches the Deployment template. Reconciles while
    // that Pod is still becoming Ready must not mint again and trigger another
    // ReplicaSet, or a RWO workspace can remain in a rollout loop.
    const host = makeHost()
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host))
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (
        s: Pick<k8s.V1Secret, 'data' | 'stringData'>
      ) => string | null
    }
    const currentSecretRevision = helper.runtimeTokenSecretRevisionFromSecret(secret)
    const deployment = deploymentWithRevision(currentSecretRevision!, 0)
    secret.metadata!.annotations![BOOTSTRAP_STATE_KEY] = 'fresh'
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment,
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe(currentSecretRevision)
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()

    deployment.status!.readyReplicas = 1
    await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    expect(replacedRuntimeSecret(coreApi).metadata?.annotations?.[BOOTSTRAP_STATE_KEY]).toBe(
      'consumed'
    )
  })

  it('refreshes bootstrap credentials without rolling a healthy deployment', async () => {
    const host = makeHost()
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: runtimeSecret(host, runtimeSecretAnnotations(host, '2000-01-01T00:00:00.000Z')),
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const replaceBody = replacedRuntimeSecret(coreApi)
    expect(replaceBody.metadata?.annotations?.['clerum.io/runtime-token-secret-revision']).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(
      replaceBody.metadata?.annotations?.['clerum.io/runtime-token-refresh-before']
    ).toBeDefined()
    expect(replaceBody.metadata?.annotations?.['clerum.io/runtime-token-rollout-required']).toBe(
      'false'
    )
    expect(replaceBody.metadata?.annotations?.['clerum.io/gfs-token-refresh-before']).toBeDefined()
    expect(replaceBody.stringData?.[GFS_KEY]).toBe('gfs-runtime-value')
  })

  it('preserves a pending rollout across retries and clears it after the Deployment converges', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, {
      ...runtimeSecretAnnotations(host),
      [BOOTSTRAP_STATE_KEY]: 'fresh',
      'clerum.io/runtime-token-rollout-required': 'true',
    })
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (value: k8s.V1Secret) => string | null
    }
    const secretRevision = helper.runtimeTokenSecretRevisionFromSecret(secret)!
    const deployment = deploymentWithRevision('pre-scope-revision')
    const { reconciler, coreApi } = runtimeSecretReconciler({ secret, deployment })
    const internals = reconciler as unknown as {
      ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
    }

    const retryResult = await internals.ensureMcpHostRuntimeTokenSecret(host)

    expect(retryResult.revision).toBe(secretRevision)
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()

    deployment.spec!.template.metadata!.annotations!['clerum.io/runtime-token-revision'] =
      secretRevision
    const convergedResult = await internals.ensureMcpHostRuntimeTokenSecret(host)

    expect(convergedResult.revision).toBe(secretRevision)
    const consumed = replacedRuntimeSecret(coreApi)
    expect(consumed.metadata?.annotations?.[BOOTSTRAP_STATE_KEY]).toBe('consumed')
    expect(consumed.metadata?.annotations?.['clerum.io/runtime-token-rollout-required']).toBe(
      'false'
    )
  })

  it('treats a legacy fresh Secret newer than the Deployment as rollout pending', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, {
      ...runtimeSecretAnnotations(host),
      [BOOTSTRAP_STATE_KEY]: 'fresh',
    })
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (value: k8s.V1Secret) => string | null
    }
    const secretRevision = helper.runtimeTokenSecretRevisionFromSecret(secret)!
    const { reconciler } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision('legacy-deployment-revision'),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe(secretRevision)
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
  })

  it('refreshes an expiring mounted gfs credential without rolling a healthy deployment', async () => {
    const host = makeHost()
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: runtimeSecret(host, {
        ...runtimeSecretAnnotations(host),
        'clerum.io/gfs-token-refresh-before': '2000-01-01T00:00:00.000Z',
      }),
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    expect(replacedRuntimeSecret(coreApi).stringData?.[GFS_KEY]).toBe('gfs-runtime-value')
  })

  it('retains fresh bootstrap until a matching Deployment is Ready', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, {
      ...runtimeSecretAnnotations(host, '2000-01-01T00:00:00.000Z'),
      'clerum.io/runtime-token-refresh-expires-at': '2999-01-01T00:00:00.000Z',
      [BOOTSTRAP_STATE_KEY]: 'fresh',
    })
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('re-issues a fresh bootstrap Secret when the Deployment restarted after issuance', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, {
      ...runtimeSecretAnnotations(host, '2999-01-01T00:00:00.000Z'),
      'clerum.io/runtime-token-issued-at': '2026-05-27T02:21:10.950Z',
      'clerum.io/runtime-token-refresh-expires-at': '2026-05-27T03:21:10.950Z',
    })
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (
        s: Pick<k8s.V1Secret, 'data' | 'stringData'>
      ) => string | null
    }
    const currentSecretRevision = helper.runtimeTokenSecretRevisionFromSecret(secret)
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision(currentSecretRevision!, 1, {
        'kubectl.kubernetes.io/restartedAt': '2026-05-27T02:45:38.000Z',
      }),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    const replaceBody = replacedRuntimeSecret(coreApi)
    const newRevision =
      replaceBody.metadata?.annotations?.['clerum.io/runtime-token-secret-revision']
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    expect(result.revision).toBe(newRevision)
    expect(result.revision).not.toBe(currentSecretRevision)
  })

  it('re-issues an unconsumed bootstrap Secret after its refresh token expires', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, {
      ...runtimeSecretAnnotations(host, '2000-01-01T00:00:00.000Z'),
      'clerum.io/runtime-token-refresh-expires-at': '2000-01-01T00:00:00.000Z',
    })
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
  })

  it('uses the new Secret revision when rollout is required', async () => {
    const host = makeHost()
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: runtimeSecret(host, runtimeSecretAnnotations(host, '2000-01-01T00:00:00.000Z')),
      deployment: deploymentWithRevision('deployed-revision', 0),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    const replaceBody = replacedRuntimeSecret(coreApi)
    const newRevision =
      replaceBody.metadata?.annotations?.['clerum.io/runtime-token-secret-revision']
    expect(result.revision).toBe(newRevision)
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('forces rollout when runtime token contract metadata changes', async () => {
    const host = makeHost()
    const annotations = {
      ...runtimeSecretAnnotations(host),
      'clerum.io/runtime-token-issuer': 'unexpected-issuer',
    }
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: runtimeSecret(host, annotations),
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const replaceBody = replacedRuntimeSecret(coreApi)
    const newRevision =
      replaceBody.metadata?.annotations?.['clerum.io/runtime-token-secret-revision']
    expect(result.revision).toBe(newRevision)
    expect(result.revision).not.toBe('deployed-revision')
    expect(replaceBody.metadata?.annotations?.['clerum.io/runtime-token-issuer']).toBe(
      'control-api'
    )
  })

  it('mints a fresh runtime Secret when the Deployment is missing', async () => {
    // No Deployment -> the full reconcile creates it and a brand-new pod boots
    // and reads its bootstrap refresh token from this Secret. That token must
    // be freshly minted and un-revoked, so an exp-based reuse of the existing
    // (possibly-rotated-and-revoked) Secret is unsafe here.
    const host = makeHost()
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host))
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (
        s: Pick<k8s.V1Secret, 'data' | 'stringData'>
      ) => string | null
    }
    const currentSecretRevision = helper.runtimeTokenSecretRevisionFromSecret(secret)
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: null,
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const newRevision =
      replacedRuntimeSecret(coreApi).metadata?.annotations?.[
        'clerum.io/runtime-token-secret-revision'
      ]
    expect(result.revision).toBe(newRevision)
    expect(result.revision).not.toBe(currentSecretRevision)
  })

  it('repairs missing runtime metadata without rolling a healthy deployment', async () => {
    const host = makeHost()
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: runtimeSecret(host, {}),
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const replaceBody = replacedRuntimeSecret(coreApi)
    expect(replaceBody.metadata?.annotations).toMatchObject({
      'clerum.io/runtime-token-issuer': 'control-api',
      'clerum.io/runtime-token-audience': 'workflow-approvals',
      'clerum.io/runtime-token-schema-version': '2',
    })
  })

  it('repairs malformed runtime Secret payload without rolling a healthy deployment', async () => {
    const host = makeHost()
    const malformed = runtimeSecret(host, runtimeSecretAnnotations(host))
    delete malformed.data?.[REFRESH_KEY]
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret: malformed,
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const replaceBody = replacedRuntimeSecret(coreApi)
    expect(replaceBody.data?.[REFRESH_KEY] ?? replaceBody.stringData?.[REFRESH_KEY]).toBeDefined()
  })

  it('rolls once when an existing deployment carries the historical empty Secret revision', async () => {
    const host = makeHost()
    const emptyInputHash = createHash('sha256').update(JSON.stringify([])).digest('hex')
    const { reconciler } = runtimeSecretReconciler({
      secret: runtimeSecret(host, runtimeSecretAnnotations(host)),
      deployment: deploymentWithRevision(emptyInputHash, 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(result.revision).not.toBe(emptyInputHash)
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
  })

  it('reuses a valid HCC-owned Secret with a far-future refresh exp without issuing or rolling', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host))
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    // Pod-template revision annotation stays exactly what the deployment carries.
    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('handles zero-replica bootstrap material for wake, recovery, and suspension', async () => {
    // Revoked-on-wake regression: a suspended Host scales its Deployment to 0.
    // The wake fast-path patches replicas back to 1 and a NEW pod boots and
    // reads its bootstrap refresh token from this Secret. If the pre-suspend
    // pod already rotated, the copy in the Secret is REVOKED even though its
    // decoded `exp` is far in the future. The exp-based reuse must NOT fire for
    // a booting pod -- the reconcile mints a fresh, un-revoked pair and rolls.
    const host = makeHost()
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host))
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (
        s: Pick<k8s.V1Secret, 'data' | 'stringData'>
      ) => string | null
    }
    const reusedRevision = helper.runtimeTokenSecretRevisionFromSecret(secret)
    const deployment = deploymentWithRevision('suspended-revision', 0, {}, 0)
    // Deployment scaled to 0 with no Ready replica -- the wake target state.
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment,
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (
          h: HostCRD,
          options?: BootstrapOptions
        ) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host, {
      forceFreshForWake: true,
      targetSuspended: false,
    })

    // Must NOT reuse: a fresh token pair is issued and persisted.
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const newRevision =
      replacedRuntimeSecret(coreApi).metadata?.annotations?.[
        'clerum.io/runtime-token-secret-revision'
      ]
    expect(result.revision).toBe(newRevision)
    expect(result.revision).not.toBe(reusedRevision)

    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    coreApi.replaceNamespacedSecret.mockClear()
    await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (
          h: HostCRD,
          options?: BootstrapOptions
        ) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host, { targetSuspended: false })

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)

    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    coreApi.replaceNamespacedSecret.mockClear()
    deployment.spec!.replicas = 1
    await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (
          h: HostCRD,
          options?: BootstrapOptions
        ) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host, { targetSuspended: true })

    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('reuses a far-exp Secret for a running Ready pod without minting or rolling (churn fix preserved)', async () => {
    // Steady-state reconcile of a running, Ready pod (readyReplicas>0). The pod
    // rotates its refresh token in memory and never re-reads the Secret, so the
    // exp-based reuse is correct here -- this is the HCC-restart churn fix. It
    // must NOT be re-broken by the revoked-on-wake guard: no mint, no roll.
    const host = makeHost()
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host))
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(result.revision).toBe('deployed-revision')
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('issues and persists refresh-expiry metadata when the Secret is missing', async () => {
    const host = makeHost()
    const { reconciler, coreApi } = runtimeSecretReconciler({ deployment: null })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1)
    const created = (
      coreApi.createNamespacedSecret.mock.calls[0] as unknown as [{ body: k8s.V1Secret }]
    )[0].body
    const expiresAt = created.metadata?.annotations?.['clerum.io/runtime-token-refresh-expires-at']
    expect(expiresAt).toBeDefined()
    // Issuer mock reports refreshExpiresInSeconds=3600 -> expiry is in the future.
    expect(Date.parse(expiresAt!)).toBeGreaterThan(Date.now())
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(result.scopeHash).toBe(
      created.metadata?.annotations?.['clerum.io/runtime-token-scope-hash']
    )
  })

  it('rotates when the refresh token exp is inside the rotate-before window', async () => {
    const host = makeHost()
    // 1h of remaining lifetime -- inside the 24h CONTEXT_MAPPER_RUNTIME_TOKEN_ROTATE_BEFORE_S default.
    const nearExpSec = Math.floor(Date.now() / 1000) + 3600
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host), fakeJwt(nearExpSec))
    const helper = HostReconciler as unknown as {
      runtimeTokenSecretRevisionFromSecret: (
        s: Pick<k8s.V1Secret, 'data' | 'stringData'>
      ) => string | null
    }
    const currentSecretRevision = helper.runtimeTokenSecretRevisionFromSecret(secret)
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision(currentSecretRevision!, 0),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const replaceBody = replacedRuntimeSecret(coreApi)
    const newRevision =
      replaceBody.metadata?.annotations?.['clerum.io/runtime-token-secret-revision']
    expect(result.revision).toBe(newRevision)
    expect(result.revision).not.toBe(currentSecretRevision)
  })

  it('rotates loudly when the refresh token is not a parsable JWT', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host), 'not-a-jwt')
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    // Healthy pod keeps running on its current material; fresh Secret is staged.
    expect(result.revision).toBe('deployed-revision')
  })

  it('replaces a Secret that is not HCC-owned for this Host and rolls onto the trusted one', async () => {
    const host = makeHost()
    const secret = runtimeSecret(host, runtimeSecretAnnotations(host))
    secret.metadata!.labels = { 'clerum.io/managed-by': 'user' }
    const { reconciler, coreApi } = runtimeSecretReconciler({
      secret,
      deployment: deploymentWithRevision('deployed-revision', 1),
    })

    const result = await (
      reconciler as unknown as {
        ensureMcpHostRuntimeTokenSecret: (h: HostCRD) => Promise<RuntimeTokenProvision>
      }
    ).ensureMcpHostRuntimeTokenSecret(host)

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1)
    const replaceBody = replacedRuntimeSecret(coreApi)
    expect(replaceBody.metadata?.labels).toMatchObject({
      'clerum.io/managed-by': 'host-context-controller',
      'clerum.io/host': host.name,
    })
    expect(result.revision).toBe(
      replaceBody.metadata?.annotations?.['clerum.io/runtime-token-secret-revision']
    )
  })
})

describe('HostReconciler.buildDeployment — SharedFileSystem mounts', () => {
  it('produces a baseline pod template when there are no mounts', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const dep = reconciler.buildDeployment(makeHost())
    const podSpec = dep.spec!.template!.spec!
    const container = podSpec.containers![0]
    const mountPaths = (container.volumeMounts ?? []).map(v => v.mountPath).sort()
    expect(mountPaths).toEqual(
      expect.arrayContaining([
        '/tmp',
        '/var/run/clerum/workflow-auth',
        '/var/run/clerum/workflow-tokens',
      ])
    )
    const envNames = (container.env ?? []).map(e => e.name)
    expect(envNames).not.toContain('CLERUM_CONTEXT_FILES_MOUNTS')
    expect(envNames).toContain('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE')
    expect(envNames).toContain('MCP_HOST_RUNTIME_AUTH_STATE_DIR')
    // Only the built-in runtime volumes — no context-files volumes.
    const volNames = (podSpec.volumes ?? []).map(v => v.name).sort()
    expect(volNames).toEqual(['mcp-host-runtime-tokens', 'tmp', 'workflow-auth-state', 'workspace'])
  })

  it('adds a pod-template runtime token revision annotation when HCC rotates tokens', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const dep = reconciler.buildDeployment(makeHost(), [], 'runtime-token-revision-1')
    expect(dep.spec!.template!.metadata!.annotations).toMatchObject({
      'clerum.io/runtime-token-revision': 'runtime-token-revision-1',
    })
  })

  it('omits the guardrails-revision annotation when the host has no guardrails', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const dep = reconciler.buildDeployment(makeHost())
    expect(dep.spec!.template!.metadata!.annotations ?? {}).not.toHaveProperty(
      'clerum.io/guardrails-revision'
    )
  })

  it('stamps sha256(canonicalStringify(guardrails)) on the pod template when guardrails are set', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const guardrails: HostCRD['spec']['guardrails'] = {
      hooks: { preCall: [{ id: 'h1', digest: 'sha256:abc' }] },
    }
    const host: HostCRD = { ...makeHost(), spec: { ...makeHost().spec, guardrails } }
    const dep = reconciler.buildDeployment(host)
    const expected = createHash('sha256')
      .update(canonicalStringify(guardrails as unknown as Record<string, unknown>))
      .digest('hex')
    expect(dep.spec!.template!.metadata!.annotations?.['clerum.io/guardrails-revision']).toBe(
      expected
    )
  })

  it('changes the guardrails-revision on a guardrails change and is stable otherwise', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const revFor = (guardrails: HostCRD['spec']['guardrails']): string | undefined => {
      const host: HostCRD = { ...makeHost(), spec: { ...makeHost().spec, guardrails } }
      return reconciler.buildDeployment(host).spec!.template!.metadata!.annotations?.[
        'clerum.io/guardrails-revision'
      ]
    }
    const a = revFor({ hooks: { preCall: [{ id: 'h1', digest: 'sha256:abc' }] } })
    const aAgain = revFor({ hooks: { preCall: [{ id: 'h1', digest: 'sha256:abc' }] } })
    const b = revFor({ hooks: { preCall: [{ id: 'h2', digest: 'sha256:def' }] } })
    // Same guardrails → same hash: no spurious rolls.
    expect(a).toBe(aAgain)
    // Changed guardrails → new hash → the pod template flips → rolling restart.
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps liveness separate from runtime-auth readiness', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const dep = reconciler.buildDeployment(makeHost())
    const container = dep.spec!.template!.spec!.containers![0]
    expect(container.startupProbe?.httpGet?.path).toBe('/v1/runtime/live')
    expect(container.livenessProbe?.httpGet?.path).toBe('/v1/runtime/live')
    expect(container.readinessProbe?.httpGet?.path).toBe('/v1/runtime/health')
  })

  it('omits imagePullSecrets when the host pull reference config is empty', () => {
    const original = hccConfig.hostImagePullSecretName
    hccConfig.hostImagePullSecretName = ''
    try {
      const reconciler = new HostReconciler(makeStubKc())
      const dep = reconciler.buildDeployment(makeHost())
      expect(dep.spec?.template.spec?.imagePullSecrets).toBeUndefined()
    } finally {
      hccConfig.hostImagePullSecretName = original
    }
  })

  it('injects one volume + RO volumeMount per resolved SharedFileSystem', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const mounts: ResolvedSfsMount[] = [
      {
        name: 'team-mission',
        namespace: 'mcp-host',
        pvcName: 'sfs-aaaaaaaaaa-files',
        mountPath: '/context-files/team-mission',
      },
      {
        name: 'support-faqs',
        namespace: 'mcp-host',
        pvcName: 'sfs-bbbbbbbbbb-files',
        mountPath: '/context-files/support-faqs',
      },
    ]
    const dep = reconciler.buildDeployment(makeHost(), mounts)
    const podSpec = dep.spec!.template!.spec!
    const container = podSpec.containers![0]

    const ctxVolumes = (podSpec.volumes ?? []).filter(v => v.name.startsWith('ctxfs-'))
    expect(ctxVolumes).toHaveLength(2)
    for (const v of ctxVolumes) {
      expect(v.persistentVolumeClaim?.readOnly).toBe(true)
    }
    const ctxMounts = (container.volumeMounts ?? []).filter(m => m.name.startsWith('ctxfs-'))
    expect(ctxMounts).toHaveLength(2)
    for (const m of ctxMounts) {
      expect(m.readOnly).toBe(true)
    }

    // Cross-reference: every volumeMount points at a real volume name.
    const volNames = new Set((podSpec.volumes ?? []).map(v => v.name))
    for (const m of ctxMounts) {
      expect(volNames.has(m.name)).toBe(true)
    }

    // Mount paths are exactly what the Context asked for.
    const mountPaths = ctxMounts.map(m => m.mountPath).sort()
    expect(mountPaths).toEqual(['/context-files/support-faqs', '/context-files/team-mission'])
  })

  it('adds a required podAffinity term per mounted SharedFileSystem to co-locate with its wfc (#592)', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const mounts: ResolvedSfsMount[] = [
      {
        name: 'team-mission',
        namespace: 'mcp-host',
        pvcName: 'sfs-aaaaaaaaaa-files',
        mountPath: '/context-files/team-mission',
      },
      {
        name: 'support-faqs',
        namespace: 'mcp-host',
        pvcName: 'sfs-bbbbbbbbbb-files',
        mountPath: '/context-files/support-faqs',
      },
    ]
    const dep = reconciler.buildDeployment(makeHost(), mounts)
    const terms =
      dep.spec!.template!.spec!.affinity?.podAffinity
        ?.requiredDuringSchedulingIgnoredDuringExecution ?? []
    // One term per mounted SFS — the RWO PVC needs the mcp-host RO consumer on
    // the same node as the wfc RW writer.
    expect(terms).toHaveLength(2)
    for (const t of terms) {
      expect(t.topologyKey).toBe('kubernetes.io/hostname')
      expect(t.labelSelector?.matchLabels?.app).toBe('workspace-files-controller')
      expect(t.labelSelector?.matchLabels?.['clerum.io/sharedfilesystem-namespace']).toBe(
        'mcp-host'
      )
    }
    const targeted = terms
      .map(t => t.labelSelector?.matchLabels?.['clerum.io/sharedfilesystem'])
      .sort()
    expect(targeted).toEqual(['support-faqs', 'team-mission'])
  })

  it('adds no affinity when there are no SharedFileSystem mounts', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const dep = reconciler.buildDeployment(makeHost())
    expect(dep.spec!.template!.spec!.affinity).toBeUndefined()
  })

  it('embeds CLERUM_CONTEXT_FILES_MOUNTS env with sorted JSON', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const mounts: ResolvedSfsMount[] = [
      // Insertion order is intentionally NOT sorted — the env value must still
      // be sorted by SFS name so the pod template hash is stable across reconciles.
      {
        name: 'zzz-team',
        namespace: 'mcp-host',
        pvcName: 'sfs-zzz',
        mountPath: '/context-files/zzz-team',
      },
      {
        name: 'aaa-team',
        namespace: 'mcp-host',
        pvcName: 'sfs-aaa',
        mountPath: '/context-files/aaa-team',
      },
    ]
    const dep = reconciler.buildDeployment(makeHost(), mounts)
    const env = (dep.spec!.template!.spec!.containers![0].env ?? []).find(
      e => e.name === 'CLERUM_CONTEXT_FILES_MOUNTS'
    )
    expect(env).toBeDefined()
    const parsed = JSON.parse(env!.value!) as Array<{ name: string }>
    expect(parsed.map(p => p.name)).toEqual(['aaa-team', 'zzz-team'])
    expect(parsed[0]).toMatchObject({
      name: 'aaa-team',
      namespace: 'mcp-host',
      pvcName: 'sfs-aaa',
      mountPath: '/context-files/aaa-team',
    })
  })

  it('volume name is stable per (sfs.name, sfs.namespace) — same hash both ends', () => {
    const sfs = { name: 'team-mission', namespace: 'mcp-host' }
    const expected = HostReconciler.contextMountVolumeName(sfs)
    expect(expected).toMatch(/^ctxfs-[a-f0-9]{10}$/)
    const reconciler = new HostReconciler(makeStubKc())
    const dep = reconciler.buildDeployment(makeHost(), [
      { ...sfs, pvcName: 'sfs-x', mountPath: '/p' },
    ])
    const podSpec = dep.spec!.template!.spec!
    const ctxVol = (podSpec.volumes ?? []).find(v => v.name === expected)
    expect(ctxVol).toBeDefined()
    const ctxMount = (podSpec.containers![0].volumeMounts ?? []).find(m => m.name === expected)
    expect(ctxMount).toBeDefined()
  })

  it('skips SharedFileSystem mounts that collide with fixed Host mounts', () => {
    const reconciler = new HostReconciler(makeStubKc())
    const dep = reconciler.buildDeployment(makeHost(), [
      {
        name: 'workspace-conflict',
        namespace: 'mcp-host',
        pvcName: 'sfs-workspace',
        mountPath: '/workspace',
      },
      {
        name: 'tmp-conflict',
        namespace: 'mcp-host',
        pvcName: 'sfs-tmp',
        mountPath: '/tmp/',
      },
      {
        name: 'team-mission',
        namespace: 'mcp-host',
        pvcName: 'sfs-team',
        mountPath: '/workspace/team-mission',
      },
    ])

    const podSpec = dep.spec!.template!.spec!
    const ctxMounts = (podSpec.containers![0].volumeMounts ?? []).filter(m =>
      m.name.startsWith('ctxfs-')
    )
    expect(ctxMounts.map(m => m.mountPath)).toEqual(['/workspace/team-mission'])

    const env = (podSpec.containers![0].env ?? []).find(
      e => e.name === 'CLERUM_CONTEXT_FILES_MOUNTS'
    )
    expect(env).toBeDefined()
    const parsed = JSON.parse(env!.value!) as Array<{ name: string; mountPath: string }>
    expect(parsed).toEqual([
      {
        name: 'team-mission',
        namespace: 'mcp-host',
        mountPath: '/workspace/team-mission',
        pvcName: 'sfs-team',
      },
    ])
  })

  it('validates context mount paths before adding them to pod specs', () => {
    expect(
      HostReconciler.contextMountPathRejectionReason('/workspace/team-mission', [
        '/workspace',
        '/tmp',
      ])
    ).toBeNull()
    expect(
      HostReconciler.contextMountPathRejectionReason('/workspace/', ['/workspace', '/tmp'])
    ).toMatch(/reserved Host mount/)
    expect(HostReconciler.contextMountPathRejectionReason('/tmp', ['/workspace', '/tmp'])).toMatch(
      /reserved Host mount/
    )
    expect(
      HostReconciler.contextMountPathRejectionReason('/context-files/../secrets', [
        '/workspace',
        '/tmp',
      ])
    ).toMatch(/absolute POSIX path/)
  })
})

describe('HostReconciler.reconcile — uses resolveContextMounts', () => {
  it('passes resolver output into the Deployment build', async () => {
    const resolveContextMounts = vi.fn(async () => [
      {
        name: 'team-mission',
        namespace: 'mcp-host',
        pvcName: 'sfs-x',
        mountPath: '/context-files/team-mission',
      },
    ])
    const captured: { body?: k8s.V1Deployment } = {}
    const stubKc = makeStubKc()
    const reconciler = new HostReconciler(stubKc, {
      resolveContextMounts,
      // Stub APIs to capture the Deployment body and ack everything.
      coreApi: {
        readNamespacedSecret: readSecretWithChannelReaderRuntimeAuthLabels(),
        createNamespacedServiceAccount: vi.fn(async () => ({})),
        createNamespacedService: vi.fn(async () => ({})),
        createNamespacedSecret: vi.fn(async () => ({})),
        replaceNamespacedSecret: vi.fn(async () => ({})),
        deleteNamespacedPersistentVolumeClaim: vi.fn(),
        createNamespacedPersistentVolumeClaim: vi.fn(async () => ({})),
        readNamespacedPersistentVolumeClaim: vi.fn(),
      } as unknown as k8s.CoreV1Api,
      rbacApi: {
        createNamespacedRole: vi.fn(async () => ({})),
        createNamespacedRoleBinding: vi.fn(async () => ({})),
      } as unknown as k8s.RbacAuthorizationV1Api,
      networkingApi: {
        createNamespacedNetworkPolicy: vi.fn(async () => ({})),
        readNamespacedNetworkPolicy: vi.fn(async () => ({})),
        replaceNamespacedNetworkPolicy: vi.fn(async () => ({})),
      } as unknown as k8s.NetworkingV1Api,
      appsApi: {
        // reconcile() now creates two Deployments (per-Host channel-reader +
        // host). Capture only the host body — the channel-reader Deployment
        // does not carry CLERUM_CONTEXT_FILES_MOUNTS.
        createNamespacedDeployment: vi.fn(async (req: { body: k8s.V1Deployment }) => {
          if (req.body.metadata?.name === 'team-mission') {
            captured.body = req.body
          }
          return {}
        }),
        readNamespacedDeployment: vi.fn(async () => ({ status: { readyReplicas: 1 } })),
      } as unknown as k8s.AppsV1Api,
    })
    await reconciler.reconcile(makeHost())
    expect(resolveContextMounts).toHaveBeenCalledTimes(1)
    expect(captured.body).toBeDefined()
    expect(
      captured.body!.spec!.template!.metadata!.annotations?.['clerum.io/runtime-token-revision']
    ).toMatch(/^[a-f0-9]{64}$/)
    const env = captured.body!.spec!.template!.spec!.containers![0].env ?? []
    const v = env.find(e => e.name === 'CLERUM_CONTEXT_FILES_MOUNTS')
    expect(v).toBeDefined()
    expect(v!.value).toContain('team-mission')
  })

  it('creates host-scoped rpc-proxy ingress and egress policies', async () => {
    const networkingApi = {
      createNamespacedNetworkPolicy: vi.fn(async () => ({})),
      readNamespacedNetworkPolicy: vi.fn(async () => ({})),
      replaceNamespacedNetworkPolicy: vi.fn(async () => ({})),
    }
    const desktopHost: HostCRD = {
      ...makeHost(),
      spec: {
        ...makeHost().spec,
        desktop: { browser: true },
      },
    }
    const reconciler = new HostReconciler(makeStubKc(), {
      coreApi: {
        readNamespacedSecret: readSecretWithChannelReaderRuntimeAuthLabels(desktopHost),
        createNamespacedServiceAccount: vi.fn(async () => ({})),
        createNamespacedService: vi.fn(async () => ({})),
        createNamespacedSecret: vi.fn(async () => ({})),
        replaceNamespacedSecret: vi.fn(async () => ({})),
        deleteNamespacedPersistentVolumeClaim: vi.fn(),
        createNamespacedPersistentVolumeClaim: vi.fn(async () => ({})),
        readNamespacedPersistentVolumeClaim: vi.fn(),
      } as unknown as k8s.CoreV1Api,
      rbacApi: {
        createNamespacedRole: vi.fn(async () => ({})),
        createNamespacedRoleBinding: vi.fn(async () => ({})),
      } as unknown as k8s.RbacAuthorizationV1Api,
      networkingApi: networkingApi as unknown as k8s.NetworkingV1Api,
      appsApi: {
        createNamespacedDeployment: vi.fn(async () => ({})),
        readNamespacedDeployment: vi.fn(async () => ({ status: { readyReplicas: 1 } })),
      } as unknown as k8s.AppsV1Api,
    })

    await reconciler.reconcile(desktopHost)

    const createPolicyCalls = networkingApi.createNamespacedNetworkPolicy.mock
      .calls as unknown as Array<[{ body: k8s.V1NetworkPolicy }]>
    const policies = new Map(
      createPolicyCalls.map(call => {
        const arg = call[0]
        return [arg.body.metadata?.name, arg.body]
      })
    )
    const ingress = policies.get('mcp-host-team-mission-ingress-rpc-proxy')!
    expect(ingress.metadata?.namespace).toBe('mcp-host')
    expect(ingress.spec?.podSelector).toEqual({
      matchLabels: {
        'clerum.io/host': 'team-mission',
        'clerum.io/managed-by': 'host-context-controller',
      },
    })
    expect(ingress.spec?.ingress?.[0]._from).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'rpc-proxy' } },
        podSelector: { matchLabels: { app: 'rpc-proxy' } },
      },
    ])
    expect(ingress.spec?.ingress?.[0].ports).toEqual([
      { port: 8080, protocol: 'TCP' },
      { port: 3000, protocol: 'TCP' },
    ])

    const readerIngress = policies.get('mcp-host-team-mission-ingress-workflow-approval-reader')!
    expect(readerIngress.metadata?.namespace).toBe('mcp-host')
    expect(readerIngress.spec?.podSelector).toEqual({
      matchLabels: {
        'clerum.io/host': 'team-mission',
        'clerum.io/managed-by': 'host-context-controller',
      },
    })
    expect(readerIngress.spec?.ingress?.[0]._from).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'channels' } },
        podSelector: {
          matchLabels: { 'app.kubernetes.io/name': 'workflow-approval-request-reader' },
        },
      },
    ])
    expect(readerIngress.spec?.ingress?.[0].ports).toEqual([{ port: 8080, protocol: 'TCP' }])

    const egress = policies.get('rpc-proxy-team-mission-egress-mcp-host')!
    expect(egress.metadata?.namespace).toBe('rpc-proxy')
    expect(egress.spec?.podSelector).toEqual({ matchLabels: { app: 'rpc-proxy' } })
    expect(egress.spec?.egress?.[0].to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'mcp-host' } },
        podSelector: {
          matchLabels: {
            'clerum.io/host': 'team-mission',
            'clerum.io/managed-by': 'host-context-controller',
          },
        },
      },
    ])
    expect(egress.spec?.egress?.[0].ports).toEqual([
      { port: 8080, protocol: 'TCP' },
      { port: 3000, protocol: 'TCP' },
    ])

    const gfsEgress = policies.get('mcp-host-team-mission-egress-gfs')!
    expect(gfsEgress.metadata?.namespace).toBe('mcp-host')
    expect(gfsEgress.spec?.podSelector).toEqual({
      matchLabels: {
        'clerum.io/host': 'team-mission',
        'clerum.io/managed-by': 'host-context-controller',
      },
    })
    expect(gfsEgress.spec?.egress?.[0].to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'gfs' } },
        podSelector: { matchLabels: { app: 'gfs-controller' } },
      },
    ])
    expect(gfsEgress.spec?.egress?.[0].ports).toEqual([{ port: 8087, protocol: 'TCP' }])

    const readerEgress = policies.get('workflow-approval-reader-team-mission-egress-mcp-host')!
    expect(readerEgress.metadata?.namespace).toBe('channels')
    expect(readerEgress.spec?.podSelector).toEqual({
      matchLabels: { 'app.kubernetes.io/name': 'workflow-approval-request-reader' },
    })
    expect(readerEgress.spec?.egress?.[0].to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'mcp-host' } },
        podSelector: {
          matchLabels: {
            'clerum.io/host': 'team-mission',
            'clerum.io/managed-by': 'host-context-controller',
          },
        },
      },
    ])
    expect(readerEgress.spec?.egress?.[0].ports).toEqual([{ port: 8080, protocol: 'TCP' }])
  })
})
