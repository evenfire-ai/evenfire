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
const SANDBOX = 'sandbox-recipes'
const UI = 'sandbox-ui'
const ALL = [NS, SANDBOX, UI]
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

async function readStored(
  mock: MockGateway,
  ns: string = NS
): Promise<{
  type?: string
  labels: Record<string, string>
  annotations: Record<string, string>
  blob?: string
}> {
  const raw = (await mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns)) as {
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

/**
 * Seed an already-provisioned, agreeing credential in `namespaces`.
 *
 * Every entry point provisions the WHOLE platform set (the single-namespace wrapper
 * delegates to it), so a test aimed at one namespace's state must settle the others too —
 * an absent sibling alone forces a mint and swamps what the test is about.
 */
function seedValid(mock: MockGateway, namespaces: string[], key: string): void {
  for (const ns of namespaces) {
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf(key) },
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, key) },
    })
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
    seedValid(mock, ALL, 'efrk_live')
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
  it('leaves a well-shaped foreign Secret untouched and proceeds', async () => {
    const { gateway, mock } = gw()
    // The siblings are settled, so nothing but the foreign namespace is in play.
    seedValid(mock, [SANDBOX, UI], 'efrk_live')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'operator-key') },
    })
    // External pre-provisioning is a supported contract: usable + not ours ⇒ hands off.
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-foreign')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    expect((await readStored(mock)).blob).toBe(encodeDockercfg(HOST, 'operator-key'))
  })

  // Foreign is a reason not to WRITE, not a reason to wave the caller through: every
  // caller attaches an imagePullSecrets reference to this exact name and then persists a
  // CRD. A foreign Secret the kubelet cannot use makes that reference unresolvable, which
  // is the silent ImagePullBackOff this service exists to prevent.
  it('fails loudly when a foreign Secret is the wrong type (kubelet ignores it)', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [SANDBOX, UI], 'efrk_live')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, { type: 'Opaque', data: {} })

    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({
      reason: 'foreign_secret_unusable',
      status: 409,
    })
    // Still never written, and never minted for: invariant 1 is unchanged.
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    const stored = await readStored(mock)
    expect(stored.type).toBe('Opaque')
    expect(stored.labels['clerum.io/managed-by']).toBeUndefined()
  })

  it('fails loudly when a foreign Secret is keyed on a different registry host', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [SANDBOX, UI], 'efrk_live')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg('old-registry.example.com', 'operator-key') },
    })

    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({
      reason: 'foreign_secret_unusable',
      status: 409,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  // The pass covers the whole platform set so the mint can be collapsed across callers —
  // but that must not turn a squatter in one namespace into an outage for installs that
  // never land there. The failure is scoped to the caller's OWN required namespaces.
  it('does not fail a single-namespace install over an unusable foreign Secret elsewhere', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI, { type: 'Opaque', data: {} })

    // The MCP install references mcp-server only; sandbox-ui is swept along for the mint
    // collapse, so its broken squatter is not this caller's problem.
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')

    // The namespaces we own were still provisioned from the one mint...
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    expect((await readStored(mock, NS)).blob).toBeTruthy()
    // ...and the foreign Secret is still never written, usable or not.
    const squatter = await readStored(mock, UI)
    expect(squatter.type).toBe('Opaque')
    expect(squatter.labels['clerum.io/managed-by']).toBeUndefined()
  })

  it('still fails the recipe path, which does reference that namespace', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI, { type: 'Opaque', data: {} })

    // Same broken squatter, but a full-set caller lands workloads in sandbox-ui, so for it
    // the reference really is unresolvable.
    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'foreign_secret_unusable',
      status: 409,
    })
  })
})

describe('ensureRegistryPullSecret — concurrent create race', () => {
  it('adopts the winner without minting a second key', async () => {
    const { gateway, mock } = gw()
    // The winner's Secret appears between our 404 read and our create — in ONE namespace;
    // the pass's other namespaces are created normally.
    const create = mock.createSecret.bind(mock)
    vi.spyOn(mock, 'createSecret').mockImplementation(async req => {
      if ((req as { namespace?: string }).namespace !== NS) return create(req)
      mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: OURS,
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_winner') },
      })
      throw Object.assign(new Error('already exists'), { statusCode: 409, code: 409 })
    })
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')
    // Exactly ONE mint, and the pass converges its own namespaces on that one key rather
    // than adopting a winner's credential it cannot verify.
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    const stored = await readStored(mock)
    expect(decodeHosts(stored.blob)).toEqual([HOST])
    expect(stored.annotations[FINGERPRINT_ANNOTATION]).toBe(fingerprintOf('efrk_test_key'))
  })
})

describe('ensureRegistryPullSecrets — fan-out across platform namespaces', () => {
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
    const operatorBlob = encodeDockercfg(HOST, 'operator-key')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: operatorBlob },
    })
    const res = await ensureRegistryPullSecrets(gateway, ALL)

    expect(res.get(SANDBOX)).toBe('exists-foreign')
    expect(res.get(NS)).toBe('created')
    expect(res.get(UI)).toBe('created')
    // Untouched, byte for byte.
    expect((await blobIn(mock, SANDBOX)).blob).toBe(operatorBlob)
  })

  it('refuses a namespace outside the platform set, before minting', async () => {
    const { gateway } = gw()
    await expect(ensureRegistryPullSecrets(gateway, [NS, 'channels'])).rejects.toMatchObject({
      reason: 'unsupported_namespace',
      status: 400,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  // The inflight dedupe is keyed on the target SET, so concurrent passes only collapse if
  // they agree on that set. An MCP install (one namespace) and a recipe install (all
  // three) overlap on mcp-server, and two mints against a rotate-on-call registry leave
  // the loser's namespaces holding a revoked key — with matching fingerprints, so the
  // divergence detector cannot see it and no later pass ever re-mints. Hence: the
  // single-namespace wrapper must run the SAME full-set pass.
  it('collapses a single-namespace pass and a full-set pass into ONE mint', async () => {
    const { gateway, mock } = gw()

    const [single, fanOut] = await Promise.all([
      ensureRegistryPullSecret(gateway, NS),
      ensureRegistryPullSecrets(gateway, ALL),
    ])

    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    expect(single).toBe('created')
    expect([...fanOut.values()]).toEqual(['created', 'created', 'created'])
    // Every namespace holds the one live credential — including the two the
    // single-namespace caller did not name.
    const seen = await Promise.all(ALL.map(ns => blobIn(mock, ns)))
    expect(new Set(seen.map(s => s.fingerprint))).toEqual(new Set([fingerprintOf('efrk_test_key')]))
  })

  it('provisions the whole platform set from a single-namespace caller', async () => {
    const { gateway, mock } = gw()

    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')

    // A full-set pass every time is also what lets a diverged cluster self-heal on the
    // next install, whichever route triggers it.
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    const seen = await Promise.all(ALL.map(ns => blobIn(mock, ns)))
    expect(new Set(seen.map(s => s.fingerprint))).toEqual(new Set([fingerprintOf('efrk_test_key')]))
  })
})
