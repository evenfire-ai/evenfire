import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'
import { mintOrgPullCredential, resolvePublishScope } from '../src/services/registryClient.js'
import { isRegistryAuthActive } from '../src/services/registryConnectionDb.js'
import {
  PullSecretProvisionError,
  ensureRegistryPullSecret,
  ensureRegistryPullSecrets,
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
const FINGERPRINT_ANNOTATION = 'clerum.io/pull-key-fingerprint'

/** Mirrors the service's fingerprint derivation so seeds can look already-provisioned. */
function fingerprintOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

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

async function readStored(mock: MockGateway): Promise<{
  type?: string
  labels: Record<string, string>
  annotations: Record<string, string>
  blob?: string
}> {
  const raw = (await mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)) as {
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
    type?: string
    data?: Record<string, string>
  }
  return {
    type: raw.type,
    labels: raw.metadata?.labels ?? {},
    annotations: raw.metadata?.annotations ?? {},
    blob: raw.data?.[DOCKERCONFIG_KEY],
  }
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
      annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_live') },
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
    // must still precede the (now single, up-front) mint, so a failed delete cannot
    // strand a freshly-rotated key that has already revoked the cluster's credential.
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
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')
    // Exactly ONE mint. Our mint already revoked whatever the winner stored, so we
    // overwrite with ours rather than adopting a now-dead credential.
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    const stored = await readStored(mock)
    expect(decodeHosts(stored.blob)).toEqual([HOST])
    expect(stored.annotations[FINGERPRINT_ANNOTATION]).toBe(fingerprintOf('efrk_test_key'))
  })
})

describe('ensureRegistryPullSecrets — fan-out across platform namespaces', () => {
  const SANDBOX = 'sandbox-recipes'
  const UI = 'sandbox-ui'
  const ALL = [NS, SANDBOX, UI]

  async function blobIn(mock: MockGateway, ns: string) {
    const raw = (await mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns)) as {
      metadata?: { annotations?: Record<string, string> }
      data?: Record<string, string>
    }
    return {
      blob: raw.data?.[DOCKERCONFIG_KEY],
      fingerprint: raw.metadata?.annotations?.[FINGERPRINT_ANNOTATION],
    }
  }

  it('mints EXACTLY ONCE and writes the same credential to every namespace', async () => {
    const { gateway, mock } = gw()
    const res = await ensureRegistryPullSecrets(gateway, ALL)

    // The registry mint is rotate-on-call: a second mint would revoke the key the first
    // namespaces were just given. One mint, N copies, is the whole invariant.
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    expect([...res.values()]).toEqual(['created', 'created', 'created'])

    const seen = await Promise.all(ALL.map(ns => blobIn(mock, ns)))
    expect(new Set(seen.map(s => s.blob)).size).toBe(1)
    expect(new Set(seen.map(s => s.fingerprint)).size).toBe(1)
    expect(seen[0].fingerprint).toBe(fingerprintOf('efrk_test_key'))
  })

  it('re-mints once and rewrites ALL namespaces when only one is missing', async () => {
    const { gateway, mock } = gw()
    // Two namespaces already hold a valid, matching credential; the third is absent.
    for (const ns of [NS, SANDBOX]) {
      mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: OURS,
        annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_old') },
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_old') },
      })
    }
    await ensureRegistryPullSecrets(gateway, ALL)

    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    // The already-valid namespaces MUST be rewritten: minting for the third revoked the
    // key they were holding. Leaving them alone is the cross-namespace corruption bug.
    const seen = await Promise.all(ALL.map(ns => blobIn(mock, ns)))
    expect(new Set(seen.map(s => s.fingerprint))).toEqual(new Set([fingerprintOf('efrk_test_key')]))
  })

  it('does not mint when every namespace already agrees', async () => {
    const { gateway, mock } = gw()
    for (const ns of ALL) {
      mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: OURS,
        annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_live') },
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_live') },
      })
    }
    const res = await ensureRegistryPullSecrets(gateway, ALL)
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    expect([...res.values()]).toEqual(['exists-ours', 'exists-ours', 'exists-ours'])
  })

  it('re-mints to converge when copies have DIVERGED', async () => {
    const { gateway, mock } = gw()
    // A previous pass minted and then failed partway: two namespaces carry one key, the
    // third a different one. Only one can still be active registry-side.
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_a') },
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_a') },
    })
    for (const ns of [SANDBOX, UI]) {
      mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: OURS,
        annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_b') },
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_b') },
      })
    }
    await ensureRegistryPullSecrets(gateway, ALL)

    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    const seen = await Promise.all(ALL.map(ns => blobIn(mock, ns)))
    expect(new Set(seen.map(s => s.fingerprint)).size).toBe(1)
  })

  it('skips a foreign namespace but still provisions the others', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: 'operator-provisioned' },
    })
    const res = await ensureRegistryPullSecrets(gateway, ALL)

    expect(res.get(SANDBOX)).toBe('exists-foreign')
    expect(res.get(NS)).toBe('created')
    expect(res.get(UI)).toBe('created')
    // Untouched, byte for byte.
    expect((await blobIn(mock, SANDBOX)).blob).toBe('operator-provisioned')
  })

  it('refuses a namespace outside the platform set, before minting', async () => {
    const { gateway } = gw()
    await expect(ensureRegistryPullSecrets(gateway, [NS, 'channels'])).rejects.toMatchObject({
      reason: 'unsupported_namespace',
      status: 400,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })
})
