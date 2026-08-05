import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'
import { mintOrgPullCredential, resolvePublishScope } from '../src/services/registryClient.js'
import { isRegistryAuthActive } from '../src/services/registryConnectionDb.js'
import { reconcileRegistryPullSecret } from '../src/services/registryPullSecretReconcileCron.js'
import {
  PullSecretProvisionError,
  ensureRegistryPullSecret,
  ensureRegistryPullSecrets,
} from '../src/services/registryPullSecretService.js'
import { MockGateway } from './mockGateway.js'

// Records every SQL the service issues, so the cross-process advisory lock is asserted
// rather than mocked into invisibility. Passthrough otherwise, to stay Postgres-free.
const dbCalls = vi.hoisted(() => ({ queries: [] as Array<{ text: string; values?: unknown[] }> }))
vi.mock('../src/db.js', () => ({
  withTransaction: (work: (db: unknown) => unknown) =>
    work({
      query: async (text: string, values?: unknown[]) => {
        dbCalls.queries.push({ text, values })
        return { rows: [], rowCount: 0 }
      },
    }),
}))

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
function seedValid(mock: MockGateway, namespaces: string[], key: string, uid?: string): void {
  for (const ns of namespaces) {
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf(key) },
      ...(uid && { uid }),
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
  dbCalls.queries.length = 0
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

/** What a managed operator's copy looks like: correctly shaped, and NOT labelled as ours. */
function seedOperator(mock: MockGateway, namespaces: string[], key = 'operator-key'): void {
  for (const ns of namespaces) {
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, key) },
    })
  }
}

describe('ensureRegistryPullSecret — legitimate no-ops', () => {
  it('skips (no mint) in managed mode — the operator owns the Secret', async () => {
    config.registryConnectionMode = 'managed'
    const { gateway, mock } = gw()
    seedOperator(mock, [NS])
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

/**
 * Managed clusters: VERIFY what the operator provisioned, write nothing.
 *
 * Skipping the write is right — the operator owns this Secret — but it is not the same as
 * having nothing to say. WRC still injects the `imagePullSecrets` reference into every
 * workload whose image is ours, and recipe workloads land in all three platform
 * namespaces, so an install into a namespace the operator has not populated persists a CRD
 * that can only ImagePullBackOff. Presence is therefore checked read-only, and a caller
 * that needs a namespace without a usable copy is failed BEFORE the CRD is written.
 */
describe('ensureRegistryPullSecrets — managed mode verifies the operator provisioned it', () => {
  beforeEach(() => {
    config.registryConnectionMode = 'managed'
  })

  it('passes without minting or writing when every required namespace is populated', async () => {
    const { gateway, mock } = gw()
    seedOperator(mock, ALL)
    const getSpy = vi.spyOn(mock, 'getSecret')
    const createSpy = vi.spyOn(mock, 'createSecret')
    const updateSpy = vi.spyOn(mock, 'updateSecret')
    const deleteSpy = vi.spyOn(mock, 'deleteSecret')

    const res = await ensureRegistryPullSecrets(gateway, ALL)

    // 'skipped' still means "provisioning was not our job", which is true on a managed
    // cluster — but it is now an answer we checked rather than assumed.
    expect([...res.values()]).toEqual(['skipped', 'skipped', 'skipped'])
    for (const ns of ALL) {
      expect(getSpy).toHaveBeenCalledWith(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns)
    }
    // Invariant 1 is absolute here: managed mode is read-only, all the way down.
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(dbCalls.queries).toHaveLength(0)
  })

  // The shape of a real managed cluster today: MCC provisions `mcp-server`, so transport
  // installs pull fine, and the two sandbox namespaces recipes land in are empty. That is
  // exactly the gap that used to surface only as an ImagePullBackOff.
  it('fails a recipe install for the namespaces the operator never populated', async () => {
    const { gateway, mock } = gw()
    seedOperator(mock, [NS])

    const err = await ensureRegistryPullSecrets(gateway, ALL).catch((e: Error) => e)

    expect(err).toBeInstanceOf(PullSecretProvisionError)
    expect(err).toMatchObject({ reason: 'operator_secret_missing', status: 409 })
    const message = (err as Error).message
    // Actionable means naming the namespaces that are actually missing — and only those.
    expect(message).toContain(`"${SANDBOX}"`)
    expect(message).toContain(`"${UI}"`)
    expect(message).not.toContain(`"${NS}"`)
    expect(message).toContain(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
    expect(message).toMatch(/operator/i) // whose job it is on this cluster
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('fails when the operator copy exists but is the wrong type (kubelet ignores it)', async () => {
    const { gateway, mock } = gw()
    seedOperator(mock, [SANDBOX, UI])
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, { type: 'Opaque', data: {} })

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'operator_secret_missing',
      status: 409,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('fails when the operator copy is keyed on a different registry host', async () => {
    const { gateway, mock } = gw()
    seedOperator(mock, [SANDBOX, UI])
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg('old-registry.example.com', 'operator-key') },
    })

    const err = await ensureRegistryPullSecrets(gateway, ALL).catch((e: Error) => e)
    expect(err).toMatchObject({ reason: 'operator_secret_missing', status: 409 })
    // The kubelet never selects a blob with no entry for our host, so say so rather than
    // reporting a Secret that is plainly sitting right there as "missing".
    expect((err as Error).message).toContain(HOST)
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  // `required` scoping is what keeps this from being the blanket reject it must not be:
  // MCC does provision `mcp-server`, so an McpServer install lands somewhere that works
  // and must not be failed by the sandbox namespaces it never touches.
  it('does not fail an McpServer install over a sandbox namespace it never lands in', async () => {
    const { gateway, mock } = gw()
    seedOperator(mock, [NS])
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('skipped')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('does fail an McpServer install when ITS OWN namespace is the empty one', async () => {
    const { gateway, mock } = gw()
    seedOperator(mock, [SANDBOX, UI])
    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({
      reason: 'operator_secret_missing',
      status: 409,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  // The verification covers the operator's contract, which is defined over the platform
  // workload namespaces. A namespace outside that set is not part of it — and failing on
  // one would break a managed install that works today, which is the opposite of the point.
  it('says nothing about a namespace outside the platform set', async () => {
    const { gateway, mock } = gw()
    seedOperator(mock, ALL)
    const res = await ensureRegistryPullSecrets(gateway, [...ALL, 'channels'])
    expect(res.get('channels')).toBe('skipped')
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
      uid: 'uid-wrong-type',
      resourceVersion: '100',
      data: {},
    })
    const deleteSpy = vi.spyOn(mock, 'deleteSecret')
    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('repaired')
    // An in-place update of `type` would 422, so it must delete first — and the delete
    // must still precede the (now single, up-front) mint, so a failed delete cannot
    // strand a freshly-rotated key that has already revoked the cluster's credential.
    //
    // The delete must also be OWNERSHIP-BOUND. A bare name-addressed delete removes
    // whatever answers to that name at the moment it lands — including a replacement an
    // external owner created after we classified this one.
    expect(deleteSpy).toHaveBeenCalledWith(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      uid: 'uid-wrong-type',
      resourceVersion: '100',
    })
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
  // and that sweep is exactly why a USABLE foreign copy anywhere has to stop the mint. The
  // credential is per-ORG and the registry's mint is rotate-on-call, so provisioning
  // mcp-server revokes whatever key the external owner sealed into the sandbox-ui Secret,
  // which we may not repair (invariant 1) and cannot even detect (a foreign copy is not in
  // the fingerprint set). A well-shaped foreign copy therefore means the org credential is
  // externally managed: mint nothing, and fail the caller that needed a namespace we could
  // not fill.
  it('refuses to provision around a usable foreign Secret in a namespace the caller never references', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'operator-key') },
    })

    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({
      reason: 'foreign_secret_would_be_revoked',
      status: 409,
    })
    // Nothing minted, so the operator's key is still live...
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    // ...and nothing written, in the foreign namespace or the ones we own.
    await expect(mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)).rejects.toThrow()
    expect((await readStored(mock, UI)).labels['clerum.io/managed-by']).toBeUndefined()
  })

  // ...but that sweep must not turn a BROKEN squatter into an outage for installs that
  // never land there. An unusable foreign Secret is by definition not serving any pull —
  // the kubelet ignores a wrong type outright, and never selects a blob keyed on another
  // host — so rotating the org key cannot break a working path through it. The failure
  // stays scoped to the caller's OWN required namespaces.
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

  // The boundary itself, pinned in one place. The gate is USABILITY, not foreignness: only
  // a foreign Secret that could plausibly be serving pulls right now (correct type AND
  // keyed on our host) can be holding the org's live key, and only that one is worth
  // blocking a mint for. Collapsing the two cases in either direction breaks this test —
  // treating every foreign copy as blocking reverses the deliberate scoping fix above;
  // treating none as blocking reinstates the silent cross-namespace revocation.
  it('blocks the mint for a USABLE foreign sibling but not for an unusable one', async () => {
    // (a) unusable squatter — nothing to revoke through it, so the mint proceeds.
    const broken = gw()
    broken.mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI, { type: 'Opaque', data: {} })
    await expect(ensureRegistryPullSecret(broken.gateway, NS)).resolves.toBe('created')
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)

    // (b) same shape, same caller, but the squatter is well-formed — it may be the live
    // credential for this org, so the mint is refused instead.
    vi.mocked(mintOrgPullCredential).mockClear()
    const wellShaped = gw()
    wellShaped.mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'operator-key') },
    })
    await expect(ensureRegistryPullSecret(wellShaped.gateway, NS)).rejects.toMatchObject({
      reason: 'foreign_secret_would_be_revoked',
      status: 409,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  // The sharp edge of that boundary: `auths[host]` PRESENT but carrying nothing. It parses,
  // it names our host, and it is completely unusable — the kubelet finds no credential to
  // send and pulls anonymously. Reading host-presence alone as "usable" put this on the
  // BLOCKING side, so an empty or template-generated Secret in any platform namespace
  // fail-closed every private install in the org, permanently, over a copy that could never
  // have served a pull. It is unusable, so it must not block.
  it('does not block the mint for a foreign entry that names our host but carries no credential', async () => {
    const { gateway, mock } = gw()
    const emptyEntry = Buffer.from(JSON.stringify({ auths: { [HOST]: {} } })).toString('base64')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: emptyEntry },
    })

    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    // Unusable does not mean ours: invariant 1 still forbids touching it.
    const squatter = await readStored(mock, UI)
    expect(squatter.blob).toBe(emptyEntry)
    expect(squatter.labels['clerum.io/managed-by']).toBeUndefined()
  })

  // A caller that actually needs that namespace must still fail — unusable is not "fine",
  // it is "fatal to whoever references it". Otherwise we would persist a CRD pointing at a
  // Secret the kubelet cannot use, which is the silent ImagePullBackOff this exists to stop.
  it('still fails a caller that requires the namespace holding the empty foreign entry', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI, {
      type: 'kubernetes.io/dockerconfigjson',
      data: {
        [DOCKERCONFIG_KEY]: Buffer.from(JSON.stringify({ auths: { [HOST]: {} } })).toString(
          'base64'
        ),
      },
    })

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'foreign_secret_unusable',
      status: 409,
    })
  })

  // Same tightening, our side of the fence: an empty entry in a Secret WE own is broken, not
  // healthy. Left as "valid" it would survive every pass while pulling anonymously.
  it('repairs a Secret we own whose entry names our host but carries no credential', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_live') },
      data: {
        [DOCKERCONFIG_KEY]: Buffer.from(JSON.stringify({ auths: { [HOST]: {} } })).toString(
          'base64'
        ),
      },
    })

    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('repaired')
    expect(decodeHosts((await readStored(mock, NS)).blob)).toEqual([HOST])
  })

  // The remedy is not obvious from a bare 409 — the namespace that fails is not the one
  // holding the external Secret — so the message has to name both and say what to do.
  it('names the external namespace, the unfillable one, and both remedies', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'operator-key') },
    })

    const err = await ensureRegistryPullSecrets(gateway, ALL).catch((e: Error) => e)
    expect(err).toBeInstanceOf(PullSecretProvisionError)
    const message = (err as Error).message
    expect(message).toContain(`"${SANDBOX}"`) // the namespace we cannot provision
    expect(message).toContain(`"${NS}"`) // the externally-owned one that blocks it
    expect(message).toMatch(/revoke/i) // why we refuse
    expect(message).toMatch(/delete/i) // remedy B: hand the namespaces back to control-api
    expect(message).toContain(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  })

  // A pass that has nothing to mint for is untouched by the rule: no mint, no revocation,
  // no block. This is the shape a fully externally-provisioned cluster settles into.
  it('accepts a foreign Secret alongside already-current owned copies (nothing to mint)', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [NS, UI], 'efrk_live')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'operator-key') },
    })

    const res = await ensureRegistryPullSecrets(gateway, ALL)
    expect(res.get(SANDBOX)).toBe('exists-foreign')
    expect(res.get(NS)).toBe('exists-ours')
    expect(res.get(UI)).toBe('exists-ours')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  // A blocked pass is not a blanket failure: the namespaces it leaves alone are genuinely
  // fine, and a caller that only needs one of those must still get a truthful answer. It
  // must NOT come back `'skipped'`, which means "provisioning is not our job" (managed
  // cluster) and would tell an operator to look in entirely the wrong place.
  it('reports an untouched, already-current copy as exists-ours even when the mint is blocked', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'operator-key') },
    })
    seedValid(mock, [SANDBOX], 'efrk_live')
    // sandbox-ui is absent, so the pass wants a mint — and the foreign mcp-server copy
    // forbids it. sandbox-recipes is unaffected: nothing rotated the key it holds.
    await expect(ensureRegistryPullSecret(gateway, SANDBOX)).resolves.toBe('exists-ours')
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  // Divergence is normally the trigger for a corrective re-mint. It is not a licence to
  // rotate a key we do not fully own: converging our copies would still kill the external
  // one. Stay diverged and say so.
  it('does not re-mint to converge diverged owned copies while a foreign copy exists', async () => {
    const { gateway, mock } = gw()
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'operator-key') },
    })
    seedValid(mock, [SANDBOX], 'efrk_a')
    seedValid(mock, [UI], 'efrk_b')

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'foreign_secret_would_be_revoked',
      status: 409,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
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

  // The winner appeared after classification, so the up-front foreign scan never saw it.
  // Bowing out with 'exists-foreign' is right (invariant 1) but is not the whole job: the
  // caller is still about to attach an imagePullSecrets reference to a Secret the kubelet
  // will ignore. The race path has to record the same unusability the classify path does,
  // or the install persists a CRD that can never pull.
  it('records an unusable foreign race winner, so a caller that needs it still fails', async () => {
    const { gateway, mock } = gw()
    const create = mock.createSecret.bind(mock)
    vi.spyOn(mock, 'createSecret').mockImplementation(async req => {
      if ((req as { namespace?: string }).namespace !== NS) return create(req)
      mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, { type: 'Opaque', data: {} })
      throw Object.assign(new Error('already exists'), { statusCode: 409, code: 409 })
    })

    await expect(ensureRegistryPullSecret(gateway, NS)).rejects.toMatchObject({
      reason: 'foreign_secret_unusable',
      status: 409,
    })
    // Still never written: invariant 1 holds on the race path too.
    const stored = await readStored(mock)
    expect(stored.type).toBe('Opaque')
    expect(stored.labels['clerum.io/managed-by']).toBeUndefined()
  })

  it('creates again when the race winner is already gone by the time we re-read', async () => {
    const { gateway, mock } = gw()
    const create = mock.createSecret.bind(mock)
    const updateSpy = vi.spyOn(mock, 'updateSecret')
    let raced = false
    vi.spyOn(mock, 'createSecret').mockImplementation(async req => {
      if ((req as { namespace?: string }).namespace === NS && !raced) {
        raced = true
        // Created and deleted again before our re-read, so the re-read finds nothing.
        throw Object.assign(new Error('already exists'), { statusCode: 409, code: 409 })
      }
      return create(req)
    })

    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('created')
    // The real API 404s an update against an absent Secret, so this path must CREATE. The
    // mock's updateSecret happily upserts, which is precisely why the assertion is on the
    // call and not on the stored bytes.
    expect(updateSpy.mock.calls.some(c => (c[0] as { namespace?: string }).namespace === NS)).toBe(
      false
    )
    expect((await readStored(mock)).blob).toBeTruthy()
  })
})

/**
 * TOCTOU: the pass classifies every namespace ONCE, then acts on that decision later — the
 * wrong-type delete and the credential write both happen after the classify read.
 *
 * The advisory lock does not close this. It serializes control-api replicas against each
 * other; it says nothing about an operator, another controller, or a `kubectl` replacing the
 * same name in between. And the reconcile cron re-opens the window on every tick, so it is
 * not a once-per-install race but a standing one. Invariant 1 ("never write a Secret we do
 * not own") therefore has to be re-proved immediately before each mutation, against the
 * OBJECT the pass classified — identity (`metadata.uid`), not just the name.
 */
describe('ensureRegistryPullSecrets — ownership taken over between classify and mutate', () => {
  /**
   * Simulate an EXTERNAL actor mutating one namespace's Secret in the window that opens the
   * instant the pass has classified it. The classify read is served from the real store,
   * and `mutate` runs immediately after — so the takeover lands at the same point in the
   * sequence whether or not the service re-reads later. (Arming it on a LATER read would
   * make the test describe the fix instead of the race: with no re-read, the mutation would
   * slide onto whatever read came next, including the assertions'.)
   */
  function takeoverAfterClassify(
    mock: MockGateway,
    ns: string,
    mutate: (mock: MockGateway) => void
  ): void {
    const real = mock.getSecret.bind(mock)
    let fired = false
    vi.spyOn(mock, 'getSecret').mockImplementation(async (name: string, namespace?: string) => {
      const result = await real(name, namespace)
      if (namespace === ns && !fired) {
        fired = true
        mutate(mock)
      }
      return result
    })
  }

  /** What a stranger's Secret looks like: usable, and NOT carrying our ownership marker. */
  function seedStranger(mock: MockGateway, ns: string, uid: string): void {
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
      type: 'kubernetes.io/dockerconfigjson',
      uid,
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'stranger-key') },
    })
  }

  // The wrong-type path is the destructive one: `Secret.type` is immutable, so a broken copy
  // is DELETED and recreated. Deleting on a stale classification means deleting whatever now
  // holds that name — here, an external operator's freshly-installed credential.
  it('does not delete a wrong-typed Secret that a foreign owner replaced after classification', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [SANDBOX, UI], 'efrk_live')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'Opaque',
      labels: OURS,
      uid: 'uid-ours',
      data: {},
    })
    const deleteSpy = vi.spyOn(mock, 'deleteSecret')
    takeoverAfterClassify(mock, NS, m => seedStranger(m, NS, 'uid-theirs'))

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'ownership_changed',
      status: 409,
    })
    expect(deleteSpy).not.toHaveBeenCalledWith(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)
    const squatter = await readStored(mock, NS)
    expect(squatter.labels['clerum.io/managed-by']).toBeUndefined()
    expect(squatter.blob).toBe(encodeDockercfg(HOST, 'stranger-key'))
  })

  // Same window, other mutation. `SecretService.updateSecret` re-reads to pick up the latest
  // `resourceVersion`, which makes it ALWAYS win the write — it proves nothing about the
  // object still being the one we classified, so the guard has to live here.
  it('does not overwrite an owned Secret whose UID changed after classification', async () => {
    const { gateway, mock } = gw()
    // mcp-server + sandbox-recipes are ours and current; sandbox-ui is absent, so the pass
    // must mint and rewrite EVERY namespace it owns — including the one changing hands.
    seedValid(mock, [NS], 'efrk_live', 'uid-ns')
    seedValid(mock, [SANDBOX], 'efrk_live', 'uid-sandbox')
    takeoverAfterClassify(mock, SANDBOX, m => {
      // The marker is copied, so only the uid can prove this is a different object.
      m.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: OURS,
        uid: 'uid-stranger',
        annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_live') },
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'stranger-key') },
      })
    })

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'ownership_changed',
      status: 409,
    })
    expect((await readStored(mock, SANDBOX)).blob).toBe(encodeDockercfg(HOST, 'stranger-key'))
  })

  it('does not overwrite an owned Secret whose ownership label was removed after classification', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [NS], 'efrk_live', 'uid-ns')
    seedValid(mock, [SANDBOX], 'efrk_live', 'uid-sandbox')
    // Same object (same uid), but the marker is gone: an external owner adopted the name.
    takeoverAfterClassify(mock, SANDBOX, m => seedStranger(m, SANDBOX, 'uid-sandbox'))

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'ownership_changed',
      status: 409,
    })
    expect((await readStored(mock, SANDBOX)).blob).toBe(encodeDockercfg(HOST, 'stranger-key'))
  })

  // The benign half of the same race, and the reason the guard cannot just be "refuse if
  // anything changed": a Secret that vanished under us is not a takeover. The mint has
  // already revoked whatever key it held, so leaving the namespace empty is the one outcome
  // that guarantees an ImagePullBackOff.
  it('creates the Secret when it was deleted externally between classify and write', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [NS], 'efrk_live', 'uid-ns')
    seedValid(mock, [SANDBOX], 'efrk_live', 'uid-sandbox')
    // The mock's deleteSecret has no await before its Map.delete, so the effect lands before
    // the read it precedes.
    takeoverAfterClassify(mock, NS, m => {
      void m.deleteSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)
    })

    const res = await ensureRegistryPullSecrets(gateway, ALL)

    expect(res.get(NS)).toBe('created')
    const stored = await readStored(mock, NS)
    expect(stored.labels['clerum.io/managed-by']).toBe('control-api')
    expect(stored.annotations[FINGERPRINT_ANNOTATION]).toBe(fingerprintOf('efrk_test_key'))
  })

  it('skips the delete and still recreates when the wrong-typed Secret is already gone', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [SANDBOX, UI], 'efrk_live')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'Opaque',
      labels: OURS,
      uid: 'uid-ours',
      data: {},
    })
    const deleteSpy = vi.spyOn(mock, 'deleteSecret')
    takeoverAfterClassify(mock, NS, m => {
      void m.deleteSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)
    })

    const res = await ensureRegistryPullSecrets(gateway, ALL)

    expect(res.get(NS)).toBe('repaired')
    // Exactly one delete of this name: the external one the test performed. A second would
    // be the service deleting on a stale classification.
    expect(deleteSpy.mock.calls.filter(c => c[1] === NS)).toHaveLength(1)
    expect((await readStored(mock, NS)).type).toBe('kubernetes.io/dockerconfigjson')
  })

  // Scoped like every other recorded failure in this service: the pass sweeps the whole
  // platform set for the mint-once collapse, so a takeover in a namespace this caller never
  // references must not fail its install — while the Secret still goes untouched.
  it('fails only the callers that need the taken-over namespace', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [NS], 'efrk_live', 'uid-ns')
    seedValid(mock, [UI], 'efrk_live', 'uid-ui')
    const updateSpy = vi.spyOn(mock, 'updateSecret')
    // sandbox-recipes is absent, so the pass mints and rewrites what it owns.
    takeoverAfterClassify(mock, UI, m => seedStranger(m, UI, 'uid-theirs'))

    await expect(ensureRegistryPullSecret(gateway, NS)).resolves.toBe('exists-ours')
    // Asserted on the WRITE, not on the stored bytes: a post-pass read would itself be the
    // read the takeover is armed on, and would make this pass for the wrong reason.
    expect(updateSpy.mock.calls.some(c => (c[0] as { namespace?: string }).namespace === UI)).toBe(
      false
    )
  })

  // The re-proof read is what produces the identity the write then binds itself to, so it
  // has to be the LAST thing before the mutation — a read with anything in between would
  // pin the write to an identity that is already one step stale. Pin both halves: one extra
  // read per mutating namespace, and it is the last thing before the mutation.
  it('re-reads immediately before each mutation, and only then', async () => {
    const { gateway, mock } = gw()
    // One of each mutating shape: wrong-typed (delete + create), valid (update), absent
    // (create — a create is already its own compare-and-swap, it 409s if the name is taken).
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      type: 'Opaque',
      labels: OURS,
      uid: 'uid-ns',
      data: {},
    })
    seedValid(mock, [SANDBOX], 'efrk_live', 'uid-sandbox')
    const getSpy = vi.spyOn(mock, 'getSecret')
    const deleteSpy = vi.spyOn(mock, 'deleteSecret')
    const updateSpy = vi.spyOn(mock, 'updateSecret')

    await ensureRegistryPullSecrets(gateway, ALL)

    const readsOf = (ns: string) => getSpy.mock.calls.filter(c => c[1] === ns).length
    expect(readsOf(NS)).toBe(2)
    expect(readsOf(SANDBOX)).toBe(2)
    expect(readsOf(UI)).toBe(1)
    const lastReadOrder = (ns: string) =>
      Math.max(...getSpy.mock.invocationCallOrder.filter((_, i) => getSpy.mock.calls[i][1] === ns))
    expect(lastReadOrder(NS)).toBeLessThan(deleteSpy.mock.invocationCallOrder[0])
    expect(lastReadOrder(SANDBOX)).toBeLessThan(updateSpy.mock.invocationCallOrder[0])
  })
})

/**
 * The half of the TOCTOU that a re-read CANNOT close: a takeover landing AFTER the ownership
 * re-proof and BEFORE the mutation it authorises. No amount of checking beforehand helps —
 * the check and the write are two requests, and the gap between them is exactly where this
 * lands.
 *
 * What closes it is carrying the identity the re-proof observed INTO the write, as a
 * precondition the apiserver enforces: `metadata.resourceVersion` on a replace,
 * `preconditions.uid` on a delete. The write to a moved object is then refused with 409
 * rather than silently winning.
 *
 * Every test here arms the takeover on the RE-PROOF read specifically (the classify read is
 * #1, the re-proof is #2), so the re-proof itself succeeds. That is what makes them
 * regression tests rather than restatements of the block above: against a name-addressed
 * mutation they fail, because the check passes and the write lands anyway.
 */
describe('ensureRegistryPullSecrets — ownership taken over between the re-proof and the write', () => {
  /**
   * Fire `mutate` immediately after the `nth` read of `ns`, placing a takeover in a chosen
   * gap. Counted in `finally` so a 404 advances the clock too — an absent Secret is still a
   * read, and without this "the Nth read" would quietly mean "the Nth read that found
   * something", which is a different position in the sequence on the create path.
   */
  function takeoverAfterRead(
    mock: MockGateway,
    ns: string,
    nth: number,
    mutate: (mock: MockGateway) => void
  ): void {
    const real = mock.getSecret.bind(mock)
    let seen = 0
    vi.spyOn(mock, 'getSecret').mockImplementation(async (name: string, namespace?: string) => {
      try {
        return await real(name, namespace)
      } finally {
        if (namespace === ns && ++seen === nth) mutate(mock)
      }
    })
  }

  /** A stranger's Secret: usable, and NOT carrying our ownership marker. */
  function seedStranger(mock: MockGateway, ns: string, uid: string): void {
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, {
      type: 'kubernetes.io/dockerconfigjson',
      uid,
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'stranger-key') },
    })
  }

  it('refuses the replace when a stranger takes the name after the re-proof', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [NS], 'efrk_live', 'uid-ns')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      uid: 'uid-sandbox',
      resourceVersion: '42',
      annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_live') },
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_live') },
    })
    // sandbox-ui is absent, so the pass mints and rewrites every namespace it owns.
    takeoverAfterRead(mock, SANDBOX, 2, m => seedStranger(m, SANDBOX, 'uid-stranger'))

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'ownership_changed',
      status: 409,
    })
    const squatter = await readStored(mock, SANDBOX)
    expect(squatter.labels['clerum.io/managed-by']).toBeUndefined()
    expect(squatter.blob).toBe(encodeDockercfg(HOST, 'stranger-key'))
  })

  // The destructive half. A name-addressed delete does not just lose a race, it REMOVES the
  // object that won it — here an external owner's credential, which no later pass restores.
  it('refuses the delete when a stranger takes the name after the re-proof', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [SANDBOX, UI], 'efrk_live')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
      // Wrong type ⇒ the immutable-field path, which deletes and recreates.
      type: 'Opaque',
      labels: OURS,
      uid: 'uid-ours',
      resourceVersion: '7',
      data: {},
    })
    takeoverAfterRead(mock, NS, 2, m => seedStranger(m, NS, 'uid-theirs'))

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'ownership_changed',
      status: 409,
    })
    // Still there, and still theirs.
    const squatter = await readStored(mock, NS)
    expect(squatter.type).toBe('kubernetes.io/dockerconfigjson')
    expect(squatter.labels['clerum.io/managed-by']).toBeUndefined()
    expect(squatter.blob).toBe(encodeDockercfg(HOST, 'stranger-key'))
  })

  // The other direction, and the reason a 409 cannot simply mean "give up": a benign edit
  // that leaves the object ours produces the SAME 409 as a takeover. Surrendering there would
  // strand this namespace on the key the mint has already revoked — an ImagePullBackOff we
  // caused ourselves, in the name of safety.
  it('retries the write when the 409 came from a benign edit, not a takeover', async () => {
    const { gateway, mock } = gw()
    seedValid(mock, [NS], 'efrk_live', 'uid-ns')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
      type: 'kubernetes.io/dockerconfigjson',
      labels: OURS,
      uid: 'uid-sandbox',
      resourceVersion: '42',
      annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_live') },
      data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_live') },
    })
    // Same object (same uid), still marked ours — somebody just edited it. Only the version
    // moved, which is enough to make our precondition fail.
    takeoverAfterRead(mock, SANDBOX, 2, m =>
      m.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: { ...OURS, 'example.com/touched-by': 'something-else' },
        uid: 'uid-sandbox',
        resourceVersion: '43',
        annotations: { [FINGERPRINT_ANNOTATION]: fingerprintOf('efrk_live') },
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_live') },
      })
    )

    const res = await ensureRegistryPullSecrets(gateway, ALL)

    expect(res.get(SANDBOX)).toBe('exists-ours')
    // The retry wrote OUR freshly minted key, not the one the mint just revoked.
    const stored = await readStored(mock, SANDBOX)
    expect(stored.annotations[FINGERPRINT_ANNOTATION]).toBe(fingerprintOf('efrk_test_key'))
  })

  // The create-race path adopts a winner it read a moment earlier. A create race is the one
  // situation where a third writer is KNOWN to be active on this name, so it is the last
  // place to assume the gap between that read and the write is safe.
  it('binds the adopt-the-winner write to the winner it just read', async () => {
    const { gateway, mock } = gw()
    const create = mock.createSecret.bind(mock)
    vi.spyOn(mock, 'createSecret').mockImplementation(async req => {
      if ((req as { namespace?: string }).namespace !== NS) return create(req)
      mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS, {
        type: 'kubernetes.io/dockerconfigjson',
        labels: OURS,
        uid: 'uid-winner',
        resourceVersion: '5',
        data: { [DOCKERCONFIG_KEY]: encodeDockercfg(HOST, 'efrk_winner') },
      })
      throw Object.assign(new Error('already exists'), { statusCode: 409, code: 409 })
    })
    // Reads of mcp-server: #1 classify (404), #2 read the race winner, #3 re-prove it. The
    // takeover lands after #3, so only the precondition on the write can still catch it.
    takeoverAfterRead(mock, NS, 3, m => seedStranger(m, NS, 'uid-stranger'))

    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'ownership_changed',
      status: 409,
    })
    expect((await readStored(mock, NS)).blob).toBe(encodeDockercfg(HOST, 'stranger-key'))
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

  // This used to assert that a foreign namespace is skipped while the others are
  // provisioned, and that the foreign blob survives "byte for byte". Byte-identity is NOT
  // the property that matters here, and asserting it is what let the bug through: the mint
  // is per-ORG and rotate-on-call, so provisioning the two namespaces we own revokes the
  // key sealed INSIDE those untouched bytes. The Secret then looks perfect and is dead —
  // its fingerprint is not in the divergence set (foreign copies are excluded), invariant 1
  // forbids repairing it, and every pod already pulling with it breaks on its next restart.
  // The property that actually keeps the credential alive is that no mint happens at all.
  it('mints nothing at all when one namespace is foreign, and says which one it cannot fill', async () => {
    const { gateway, mock } = gw()
    const operatorBlob = encodeDockercfg(HOST, 'operator-key')
    mock.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { [DOCKERCONFIG_KEY]: operatorBlob },
    })

    // A full-set caller lands workloads in the namespaces we cannot fill without that
    // mint, so it must fail loudly instead of getting a 201 over a cluster we just broke.
    await expect(ensureRegistryPullSecrets(gateway, ALL)).rejects.toMatchObject({
      reason: 'foreign_secret_would_be_revoked',
      status: 409,
    })
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    // The bytes are unchanged — but only as a consequence of the key still being live.
    expect((await blobIn(mock, SANDBOX)).blob).toBe(operatorBlob)
    // And the namespaces we own stay absent rather than half-provisioned.
    await expect(mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)).rejects.toThrow()
    await expect(mock.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, UI)).rejects.toThrow()
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

describe('ensureRegistryPullSecrets — cross-process serialization', () => {
  it('takes a per-org advisory lock BEFORE minting', async () => {
    const { gateway } = gw()
    await ensureRegistryPullSecrets(gateway, ALL)

    // Two replicas coexist on every RollingUpdate; without this lock their mints
    // interleave and some namespaces end up holding a revoked key.
    const lock = dbCalls.queries.find(q => q.text.includes('pg_advisory_xact_lock'))
    expect(lock).toBeDefined()
    expect(lock?.values?.[0]).toBe('registry-pull-secret:acme')
    // An xact lock auto-releases on commit, so there is no explicit unlock to leak.
    expect(dbCalls.queries.some(q => q.text.includes('pg_advisory_unlock'))).toBe(false)
  })

  it('does not reach the lock when the pass is a legitimate no-op', async () => {
    config.registryConnectionMode = 'managed'
    const { gateway, mock } = gw()
    seedOperator(mock, ALL)
    await ensureRegistryPullSecrets(gateway, ALL)
    // Managed clusters must not touch Postgres on this path: the lock exists to serialize
    // a mint, and the managed pass only reads.
    expect(dbCalls.queries).toHaveLength(0)
  })
})

/**
 * The reconcile loop against the REAL service — its own suite mocks this module out, so
 * this is the only place the managed interaction can be observed.
 *
 * A managed cluster genuinely has nothing for control-api to do here, and the loop runs on
 * a timer: it must stay a quiet no-op rather than reporting a failed pass every tick just
 * because the operator has not populated a namespace no install has asked for yet.
 */
describe('reconcileRegistryPullSecret — managed cluster', () => {
  it('stays a quiet no-op when the operator has provisioned nothing', async () => {
    config.registryConnectionMode = 'managed'
    const { gateway, mock } = gw()
    const createSpy = vi.spyOn(mock, 'createSecret')

    await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(true)
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })
})
