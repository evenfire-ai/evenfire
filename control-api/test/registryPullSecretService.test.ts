import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'
import type { K8sGateway } from '../src/k8s.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'

vi.mock('../src/services/registryConnectionDb.js', () => ({
  isRegistryAuthActive: vi.fn(),
}))
vi.mock('../src/services/registryClient.js', () => ({
  resolvePublishScope: vi.fn(),
  mintOrgPullCredential: vi.fn(),
}))

import { isRegistryAuthActive } from '../src/services/registryConnectionDb.js'
import { resolvePublishScope, mintOrgPullCredential } from '../src/services/registryClient.js'
import { ensureRegistryPullSecret } from '../src/services/registryPullSecretService.js'

const NS = 'mcp-server'

function gw(): { gateway: K8sGateway; mock: MockGateway } {
  const mock = new MockGateway(NS)
  return { gateway: mock as unknown as K8sGateway, mock }
}

/** Decode the `.dockerconfigjson` a seeded/created Secret carries. */
async function decodeDockercfg(
  mock: MockGateway
): Promise<{ host: string; username: string; password: string }> {
  const raw = (await mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)) as {
    type?: string
    data?: Record<string, string>
  }
  expect(raw.type).toBe('kubernetes.io/dockerconfigjson')
  const blob = raw.data?.['.dockerconfigjson']
  expect(blob).toBeTruthy()
  const parsed = JSON.parse(Buffer.from(blob as string, 'base64').toString('utf8')) as {
    auths: Record<string, { username: string; password: string }>
  }
  const host = Object.keys(parsed.auths)[0]!
  return { host, username: parsed.auths[host]!.username, password: parsed.auths[host]!.password }
}

let savedMode: typeof config.registryConnectionMode
let savedUrl: string

beforeEach(() => {
  vi.clearAllMocks()
  savedMode = config.registryConnectionMode
  savedUrl = config.registryUrl
  config.registryConnectionMode = 'self-hosted'
  config.registryUrl = 'https://registry.evenfire.ai'
  vi.mocked(isRegistryAuthActive).mockResolvedValue(true)
  vi.mocked(resolvePublishScope).mockResolvedValue({ curator: false, orgName: 'acme', scope: '@acme' })
  vi.mocked(mintOrgPullCredential).mockResolvedValue({ key: 'efrk_test_key' })
})

afterEach(() => {
  config.registryConnectionMode = savedMode
  config.registryUrl = savedUrl
})

describe('ensureRegistryPullSecret', () => {
  it('skips (no mint) in managed mode', async () => {
    config.registryConnectionMode = 'managed'
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('skipped')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('skips when registry auth is inactive', async () => {
    vi.mocked(isRegistryAuthActive).mockResolvedValue(false)
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('skipped')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('skips when the org is not yet resolved (connect flow incomplete)', async () => {
    vi.mocked(resolvePublishScope).mockResolvedValue({ curator: false, orgName: null, scope: null })
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('skipped')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('mints and creates the Secret when absent, keyed on the registryUrl host', async () => {
    const { gateway, mock } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')
    expect(mintOrgPullCredential).toHaveBeenCalledWith('acme')
    const { host, username, password } = await decodeDockercfg(mock)
    expect(host).toBe('registry.evenfire.ai') // image host, NOT the registry token-issuer
    expect(username).toBe('_')
    expect(password).toBe('efrk_test_key')
    const raw = (await mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)) as {
      metadata: { labels: Record<string, string> }
    }
    expect(raw.metadata.labels['clerum.io/managed-by']).toBe('control-api')
  })

  it('reuses our existing Secret without minting', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: { 'clerum.io/managed-by': 'control-api' },
      data: { '.dockerconfigjson': 'existing' },
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-ours')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('leaves a foreign (unlabeled) Secret untouched', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { '.dockerconfigjson': 'operator-provisioned' },
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-foreign')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    const raw = (await mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)) as {
      data: Record<string, string>
    }
    expect(raw.data['.dockerconfigjson']).toBe('operator-provisioned') // unchanged
  })

  it('repairs a present-but-empty Secret via update', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: { 'clerum.io/managed-by': 'control-api' },
      data: {},
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('repaired')
    expect(mintOrgPullCredential).toHaveBeenCalledOnce()
    expect((await decodeDockercfg(mock)).password).toBe('efrk_test_key')
  })

  it('aborts without minting when the read fails with a non-404 (e.g. 403)', async () => {
    const { gateway, mock } = gw()
    vi.spyOn(mock, 'getSecret').mockRejectedValue(
      Object.assign(new Error('forbidden'), { statusCode: 403, code: 403 })
    )
    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({ statusCode: 403 })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })
})
