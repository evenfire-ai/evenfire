import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'
import { mintOrgPullCredential, resolvePublishScope } from '../src/services/registryClient.js'
import { isRegistryAuthActive } from '../src/services/registryConnectionDb.js'
import {
  PullSecretProvisionError,
  ensureRegistryPullSecret,
} from '../src/services/registryPullSecretService.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/services/registryConnectionDb.js', () => ({
  isRegistryAuthActive: vi.fn(),
}))
vi.mock('../src/services/registryClient.js', () => ({
  resolvePublishScope: vi.fn(),
  mintOrgPullCredential: vi.fn(),
}))

const NS = 'mcp-server'
const HOST = 'registry.evenfire.ai'
const DOCKERCONFIG_KEY = '.dockerconfigjson'
const OURS = { 'clerum.io/managed-by': 'control-api' }

function gw(): { gateway: K8sGateway; mock: MockGateway } {
  const mock = new MockGateway(NS)
  return { gateway: mock as unknown as K8sGateway, mock }
}

/** Encode a dockerconfigjson blob keyed on `host`, matching what the realm expects. */
function encodeDockercfg(host: string, key: string): string {
  const auth = Buffer.from(`_:${key}`).toString('base64')
  return Buffer.from(
    JSON.stringify({ auths: { [host]: { username: '_', password: key, auth } } })
  ).toString('base64')
}

async function readStored(
  mock: MockGateway
): Promise<{ type?: string; labels: Record<string, string>; blob?: string }> {
  const raw = (await mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)) as {
    metadata?: { labels?: Record<string, string> }
    type?: string
    data?: Record<string, string>
  }
  return { type: raw.type, labels: raw.metadata?.labels ?? {}, blob: raw.data?.[DOCKERCONFIG_KEY] }
}

function decodeHosts(blob: string | undefined): string[] {
  if (!blob) return []
  const parsed = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as {
    auths: Record<string, unknown>
  }
  return Object.keys(parsed.auths)
}

let savedMode: typeof config.registryConnectionMode
let savedUrl: string

beforeEach(() => {
  vi.clearAllMocks()
  savedMode = config.registryConnectionMode
  savedUrl = config.registryUrl
  config.registryConnectionMode = 'self-hosted'
  config.registryUrl = `https://${HOST}`
  vi.mocked(isRegistryAuthActive).mockResolvedValue(true)
  vi.mocked(resolvePublishScope).mockResolvedValue({
    curator: false,
    orgName: 'acme',
    scope: '@acme',
  })
  vi.mocked(mintOrgPullCredential).mockResolvedValue({ key: 'efrk_test_key' })
})

afterEach(() => {
  config.registryConnectionMode = savedMode
  config.registryUrl = savedUrl
})

describe('ensureRegistryPullSecret — legitimate no-ops', () => {
  it('skips (no mint) in managed mode — the operator owns the Secret', async () => {
    config.registryConnectionMode = 'managed'
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('skipped')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('skips when no registry host is configured', async () => {
    config.registryUrl = ''
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('skipped')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })
})

describe('ensureRegistryPullSecret — fails loudly instead of silently skipping', () => {
  it('throws (not skips) when the registry connection is inactive', async () => {
    vi.mocked(isRegistryAuthActive).mockResolvedValue(false)
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toBeInstanceOf(
      PullSecretProvisionError
    )
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('throws when the org cannot be resolved even after a forced refresh', async () => {
    vi.mocked(resolvePublishScope).mockResolvedValue({ curator: false, orgName: null, scope: null })
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({
      reason: 'org_unresolved',
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('recovers from a stale cached null org by forcing one refresh', async () => {
    vi.mocked(resolvePublishScope)
      .mockResolvedValueOnce({ curator: false, orgName: null, scope: null })
      .mockResolvedValueOnce({ curator: false, orgName: 'acme', scope: '@acme' })
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')
    expect(resolvePublishScope).toHaveBeenNthCalledWith(2, { force: true })
    expect(mintOrgPullCredential).toHaveBeenCalledWith('acme')
  })

  it('refuses to write the credential outside the configured plugin namespace', async () => {
    const { gateway } = gw()
    await expect(ensureRegistryPullSecret(gateway, 'channels')).rejects.toMatchObject({
      reason: 'unsupported_namespace',
      status: 400,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('aborts without minting when the read fails with a non-404 (e.g. 403)', async () => {
    const { gateway, mock } = gw()
    vi.spyOn(mock, 'getSecret').mockRejectedValue(
      Object.assign(new Error('forbidden'), { statusCode: 403, code: 403 })
    )
    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({ statusCode: 403 })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('propagates a mint failure and writes nothing', async () => {
    vi.mocked(mintOrgPullCredential).mockRejectedValue(new Error('registry returned no pull key'))
    const { gateway, mock } = gw()
    const createSpy = vi.spyOn(mock, 'createSecret')
    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toThrow(/no pull key/)
    expect(createSpy).not.toHaveBeenCalled()
  })
})

describe('ensureRegistryPullSecret — provisioning', () => {
  it('mints and creates the Secret when absent, keyed on the image host', async () => {
    const { gateway, mock } = gw()
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')
    expect(mintOrgPullCredential).toHaveBeenCalledWith('acme')
    const stored = await readStored(mock)
    expect(stored.type).toBe('kubernetes.io/dockerconfigjson')
    expect(stored.labels['clerum.io/managed-by']).toBe('control-api')
    // Keyed on OUR image host, never the registry's token issuer.
    expect(decodeHosts(stored.blob)).toEqual([HOST])
  })

  it('reuses our existing, correctly-keyed Secret without minting', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_live') },
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-ours')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('repairs our Secret when the blob is keyed on a STALE host (registry URL changed)', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg('old-registry.example.com', 'efrk_stale') },
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('repaired')
    expect(decodeHosts((await readStored(mock)).blob)).toEqual([HOST])
  })

  it('repairs our Secret when the payload is missing', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      data: {},
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('repaired')
    expect(decodeHosts((await readStored(mock)).blob)).toEqual([HOST])
  })

  it('recreates our Secret when the type is wrong (Secret.type is immutable)', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'Opaque',
      labels: OURS,
      data: {},
    })
    const deleteSpy = vi.spyOn(mock, 'deleteSecret')
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('repaired')
    // An in-place update of `type` would 422, so it must delete first — and the delete
    // must precede the mint so a failed delete cannot strand a freshly-rotated key.
    expect(deleteSpy).toHaveBeenCalledWith(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)
    expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(mintOrgPullCredential).mock.invocationCallOrder[0]
    )
    expect((await readStored(mock)).type).toBe('kubernetes.io/dockerconfigjson')
  })
})

describe('ensureRegistryPullSecret — never touches a Secret we do not own', () => {
  it('leaves a foreign Secret WITH data untouched', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: 'operator-provisioned' },
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-foreign')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    expect((await readStored(mock)).blob).toBe('operator-provisioned')
  })

  it('leaves a foreign EMPTY Secret untouched (never seizes ownership)', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, { type: 'Opaque', data: {} })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-foreign')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    const stored = await readStored(mock)
    expect(stored.type).toBe('Opaque')
    expect(stored.labels['clerum.io/managed-by']).toBeUndefined()
  })
})

describe('ensureRegistryPullSecret — concurrent create race', () => {
  it('adopts the winner without minting a second key', async () => {
    const { gateway, mock } = gw()
    // The winner's Secret appears between our 404 read and our create.
    vi.spyOn(mock, 'createSecret').mockImplementation(async () => {
      mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: OURS,
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_winner') },
      })
      throw Object.assign(new Error('already exists'), { statusCode: 409, code: 409 })
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-ours')
    // Exactly ONE mint — a second would revoke the key the winner just stored.
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    expect(decodeHosts((await readStored(mock)).blob)).toEqual([HOST])
  })
})
