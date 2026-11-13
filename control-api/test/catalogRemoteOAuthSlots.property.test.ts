import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fc from 'fast-check'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import {
  type ListedMcpServer,
  classifyRemoteOAuthSlots,
  deriveCatalogRemoteServerName,
  resolveRemoteOAuthEntry,
} from '../src/routes/admin/catalogRemoteOAuth.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import {
  getCategories,
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  reportInstall,
} from '../src/services/registryClient.js'
import { registryEntryRow } from './fixtures/registryEntryRow.js'
import {
  REMOTE_OAUTH_FIXTURE_BASE_URL,
  type RemoteOAuthCr,
  remoteOAuthMcpServer,
} from './fixtures/remoteOAuthMcpServer.js'
import { MockGateway } from './mockGateway.js'

/**
 * Properties of `classifyRemoteOAuthSlots`, the decision of who owns each
 * (catalog entry × grant scope) install slot. Every input comes from its real
 * producer: remote-OAuth CRs from the remote saga's builder (`remoteOAuthMcpServer`,
 * catalog identity from `catalogAnnotations`), plain CRs from the registry install
 * route, `deletionTimestamp` from the gateway's delete, the listing from the
 * gateway, and entries from `registryEntryRow` passed through `resolveRemoteOAuthEntry`.
 *
 * Decision table encoded below (servers ordered by name):
 *   no `oauth.source: remote`            → only its name counts (for `foreign`)
 *   remote, no catalog id                 → `manualRemoteOAuth`, terminating or not
 *   remote, catalog id not a registry name→ discarded (name still counts)
 *   remote, valid catalog id              → claims slot (id, grantScope ?? user):
 *       canonical-name claimant wins, terminating or not; else first by name
 *   valid remote-OAuth entry on the page, allowed scope, slot unclaimed:
 *       `foreign` iff any listed CR holds the slot's canonical name; else absent
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/services/registryClient.js', () => ({
  searchEntries: vi.fn(),
  getEntry: vi.fn(),
  getEntryVersion: vi.fn(),
  getCredentialSchema: vi.fn(),
  getCategories: vi.fn(),
  reportInstall: vi.fn(),
  downloadBundle: vi.fn(),
  getDigest: vi.fn(),
  uploadArtifacts: vi.fn(),
  updateVersionMetadata: vi.fn(),
  deleteVersion: vi.fn(),
  publishEntry: vi.fn(),
  resolvePublishScope: vi.fn(),
  applyPublishScope: vi.fn((name: string | undefined) => name),
}))

const NS = 'mcp-server'
const NUM_RUNS = 500
type Scope = 'user' | 'context'
const SCOPES: readonly Scope[] = ['user', 'context']

const NOTION = '@evenfire/notion'
const LINEAR = '@acme/linear'
/** Remote-OAuth entry the resolver rejects (curator pre-registered without a guide). */
const NOTION_PRE = '@evenfire/notion-pre'
/** A plain remote entry: never remote-OAuth, so it opens no slot. */
const PLAIN = '@evenfire/plain'
/** Valid registry names that have CRs but are not on the page. */
const OFF_PAGE = ['@acme/offpage', 'constructor'] as const
/** Catalog ids the registry grammar rejects: the classification discards these CRs. */
const INVALID_IDS = ['__proto__', 'toString'] as const
const VALID_IDS = [NOTION, LINEAR, NOTION_PRE, PLAIN, ...OFF_PAGE] as const
const ALL_IDS = [...VALID_IDS, ...INVALID_IDS] as const
const VERSIONS = ['1.0.0', '1.1.0'] as const

const canonical = deriveCatalogRemoteServerName
const NAME_POOL: readonly string[] = [
  ...ALL_IDS.flatMap(id => SCOPES.map(scope => canonical(id, scope))),
  'aaa-hand',
  'mmm-hand',
  'zzz-hand',
  'hand-notion',
]

beforeEach(() => {
  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
  vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
  vi.mocked(getCategories).mockResolvedValue({ data: [] })
})

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

function remoteOAuthRow(name: string, allowedGrantScopes: Scope[], extra = {}) {
  const org = /^@([^/]+)\//.exec(name)?.[1]
  return registryEntryRow(
    {
      name,
      mcpServer: {
        serverMode: 'remote',
        transport: 'streamableHttp',
        remoteEndpoints: [{ url: REMOTE_OAUTH_FIXTURE_BASE_URL }],
        oauth: { source: 'remote', allowedGrantScopes, expectedRegistration: 'cimd', ...extra },
      },
    },
    org === 'evenfire' ? { kind: 'curator-machine' } : { kind: 'org-machine', org: org! }
  )
}

const plainRemoteRow = (name: string) =>
  registryEntryRow(
    {
      name,
      mcpServer: {
        serverMode: 'remote',
        transport: 'streamableHttp',
        remoteEndpoints: [{ url: 'https://plain.example.com/mcp' }],
      },
    },
    { kind: 'curator-machine' }
  )

/** Plain (non-remote-OAuth) McpServers as the registry install route writes them, by name. */
const plainPool = new Map<string, unknown>()

beforeAll(async () => {
  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
  vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
  const gw = new MockGateway(NS)
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gw as unknown as K8sGateway))
  for (const serverName of NAME_POOL) {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(plainRemoteRow(PLAIN) as never)
    const res = await request(app).post('/admin/registry/install').send({
      serverName,
      registryEntryName: PLAIN,
      registryEntryVersion: '1.0.0',
    })
    if (res.status !== 201) throw new Error(`plain install ${serverName}: ${res.status}`)
    plainPool.set(serverName, await gw.getResource('mcpservers', serverName, NS))
  }
})

const remoteCache = new Map<string, RemoteOAuthCr>()
async function remoteCr(spec: CrSpec & { kind: 'manual' | 'catalog' }): Promise<RemoteOAuthCr> {
  const key = JSON.stringify(spec)
  let cr = remoteCache.get(key)
  if (!cr) {
    cr = await remoteOAuthMcpServer({
      serverName: spec.name,
      namespace: NS,
      grantScope: spec.scope,
      ...(spec.kind === 'catalog' ? { catalog: { id: spec.id, version: spec.version } } : {}),
    })
    remoteCache.set(key, cr)
  }
  return structuredClone(cr)
}

type CrSpec =
  | { kind: 'plain'; name: string; terminating: boolean }
  | { kind: 'manual'; name: string; scope: Scope; terminating: boolean }
  | {
      kind: 'catalog'
      name: string
      scope: Scope
      id: string
      version: string
      terminating: boolean
    }

/** The McpServers as the gateway lists them after creating (and deleting) each one. */
async function listed(specs: readonly CrSpec[]): Promise<ListedMcpServer[]> {
  const gw = new MockGateway(NS)
  for (const spec of specs) {
    const body =
      spec.kind === 'plain' ? structuredClone(plainPool.get(spec.name)) : await remoteCr(spec)
    await gw.createResource('mcpservers', body as never, NS)
    if (spec.terminating) gw.markDeleting('mcpservers', spec.name, NS)
  }
  return (await gw.listResource('mcpservers', NS)) as ListedMcpServer[]
}

type PageEntry = { name: string; scopes: Scope[] }
function pageEntries(page: readonly PageEntry[]) {
  return page.map(({ name, scopes }) =>
    resolveRemoteOAuthEntry(
      name === PLAIN
        ? plainRemoteRow(name)
        : name === NOTION_PRE
          ? remoteOAuthRow(name, scopes, { expectedRegistration: 'pre-registered' })
          : remoteOAuthRow(name, scopes)
    )
  )
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const scopeArb = fc.constantFrom<Scope>('user', 'context')
/** The slot a canonical name belongs to, so claims can be aimed at it. */
const SLOT_OF_NAME = new Map(
  ALL_IDS.flatMap(id => SCOPES.map(scope => [canonical(id, scope), { id, scope }] as const))
)
/** Claims cluster on few slots so double claims and canonical-vs-other races are common. */
const claimedSlotArb = fc.oneof(
  fc.record({ id: fc.constantFrom<string>(NOTION, LINEAR), scope: scopeArb }),
  fc.record({ id: fc.constantFrom<string>(...ALL_IDS), scope: scopeArb })
)
const crSpecArb = (name: string): fc.Arbitrary<CrSpec> => {
  const own = SLOT_OF_NAME.get(name)
  const slotArb = own ? fc.oneof(fc.constant(own), claimedSlotArb) : claimedSlotArb
  return fc.oneof(
    fc.record({
      kind: fc.constant('plain' as const),
      name: fc.constant(name),
      terminating: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant('manual' as const),
      name: fc.constant(name),
      scope: scopeArb,
      terminating: fc.boolean(),
    }),
    {
      weight: 3,
      arbitrary: fc
        .record({
          slot: slotArb,
          version: fc.constantFrom<string>(...VERSIONS),
          terminating: fc.boolean(),
        })
        .map(({ slot, version, terminating }) => ({
          kind: 'catalog' as const,
          name,
          ...slot,
          version,
          terminating,
        })),
    }
  )
}

/** Unique names (a namespace cannot hold two McpServers under one name). */
const specsArb = fc
  .uniqueArray(fc.constantFrom(...NAME_POOL), { maxLength: 12 })
  .chain(names => fc.tuple(...names.map(crSpecArb)))
  .map(specs => specs as CrSpec[])

const pageArb: fc.Arbitrary<PageEntry[]> = fc.uniqueArray(
  fc.record({
    name: fc.constantFrom(NOTION, LINEAR, NOTION_PRE, PLAIN),
    scopes: fc.constantFrom<Scope[]>(['user'], ['context'], ['user', 'context']),
  }),
  { selector: e => e.name, maxLength: 4 }
)

const scenarioArb = fc.record({ specs: specsArb, page: pageArb })

// ---------------------------------------------------------------------------
// Oracle helpers (the decision table, read from the specs, not from the code)
// ---------------------------------------------------------------------------

type CatalogSpec = Extract<CrSpec, { kind: 'catalog' }>
const isValidId = (id: string) => (VALID_IDS as readonly string[]).includes(id)
const claimants = (specs: readonly CrSpec[], id: string, scope: Scope) =>
  specs.filter((s): s is CatalogSpec => s.kind === 'catalog' && s.id === id && s.scope === scope)
const firstByName = <T extends { name: string }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => a.name.localeCompare(b.name))[0]
const expectedOwner = (claims: readonly CatalogSpec[], id: string, scope: Scope) =>
  claims.find(c => c.name === canonical(id, scope)) ?? firstByName(claims)
const isValidRemoteEntry = (e: PageEntry) => e.name === NOTION || e.name === LINEAR

async function classify(specs: readonly CrSpec[], page: readonly PageEntry[]) {
  return classifyRemoteOAuthSlots(await listed(specs), pageEntries(page))
}

const run = <T extends [unknown]>(prop: fc.IAsyncProperty<T>) =>
  fc.assert(prop, { numRuns: NUM_RUNS })

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('classifyRemoteOAuthSlots properties', () => {
  it('is independent of the order of the listed servers and of the entries', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.infiniteStream(fc.nat()), async ({ specs, page }, seeds) => {
        const servers = await listed(specs)
        const entries = pageEntries(page)
        const base = classifyRemoteOAuthSlots(servers, entries)
        const keys = seeds[Symbol.iterator]()
        const shuffle = <T>(xs: readonly T[]) =>
          xs
            .map(x => ({ x, k: keys.next().value as number }))
            .sort((a, b) => a.k - b.k)
            .map(({ x }) => x)
        expect(classifyRemoteOAuthSlots(shuffle(servers), shuffle(entries))).toEqual(base)
        expect(classifyRemoteOAuthSlots([...servers].reverse(), entries)).toEqual(base)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('a server owns at most one slot and is never both a slot owner and manual', async () => {
    await run(
      fc.asyncProperty(scenarioArb, async ({ specs, page }) => {
        const { remoteOAuthSlots, manualRemoteOAuth } = await classify(specs, page)
        const owners = Object.values(remoteOAuthSlots).flatMap(bySlot =>
          Object.values(bySlot).flatMap(s => (s?.kind === 'instance' ? [s.serverName] : []))
        )
        const manual = manualRemoteOAuth.map(m => m.serverName)
        expect(new Set(owners).size).toBe(owners.length)
        expect(new Set(manual).size).toBe(manual.length)
        expect(owners.filter(o => manual.includes(o))).toEqual([])
      })
    )
  })

  it('nothing is lost: manual CRs are listed, valid catalog claims are filled, invalid ids are discarded', async () => {
    await run(
      fc.asyncProperty(scenarioArb, async ({ specs, page }) => {
        const { remoteOAuthSlots, manualRemoteOAuth } = await classify(specs, page)
        const manualSpecs = specs.filter(s => s.kind === 'manual')
        expect(manualRemoteOAuth.map(m => m.serverName).sort()).toEqual(
          manualSpecs.map(s => s.name).sort()
        )
        for (const m of manualRemoteOAuth) {
          const spec = manualSpecs.find(s => s.name === m.serverName)!
          expect(m).toEqual({
            serverName: spec.name,
            baseUrl: REMOTE_OAUTH_FIXTURE_BASE_URL,
            grantScope: spec.scope,
          })
        }
        const owners = new Set<string>()
        for (const [id, bySlot] of Object.entries(remoteOAuthSlots)) {
          for (const [scope, state] of Object.entries(bySlot)) {
            if (state?.kind === 'instance') {
              owners.add(state.serverName)
              const spec = specs.find(s => s.name === state.serverName)
              expect(spec).toMatchObject({ kind: 'catalog', id, scope })
            }
          }
        }
        for (const s of specs) {
          if (s.kind !== 'catalog') continue
          if (!isValidId(s.id)) {
            // The discard bucket: only CRs whose catalog id the registry rejects.
            expect(Object.hasOwn(remoteOAuthSlots, s.id)).toBe(false)
            expect(owners.has(s.name)).toBe(false)
          } else {
            expect(remoteOAuthSlots[s.id]?.[s.scope]?.kind).toBe('instance')
          }
        }
      })
    )
  })

  it('the canonical claimant owns its slot, otherwise the first claimant by name', async () => {
    await run(
      fc.asyncProperty(scenarioArb, async ({ specs, page }) => {
        const { remoteOAuthSlots } = await classify(specs, page)
        for (const id of VALID_IDS) {
          for (const scope of SCOPES) {
            const claims = claimants(specs, id, scope)
            if (claims.length === 0) continue
            const owner = expectedOwner(claims, id, scope)
            expect(remoteOAuthSlots[id]?.[scope]).toEqual({
              kind: 'instance',
              serverName: owner.name,
              version: owner.version,
              canonical: owner.name === canonical(id, scope),
              terminating: owner.terminating,
            })
          }
        }
      })
    )
  })

  it('an unclaimed slot of a valid page entry is foreign iff its canonical name is taken', async () => {
    await run(
      fc.asyncProperty(scenarioArb, async ({ specs, page }) => {
        const { remoteOAuthSlots } = await classify(specs, page)
        const names = new Set(specs.map(s => s.name))
        for (const id of [...VALID_IDS, ...INVALID_IDS]) {
          for (const scope of SCOPES) {
            if (claimants(specs, id, scope).length > 0 && isValidId(id)) continue
            const entry = page.find(e => e.name === id)
            const slotExists =
              entry !== undefined && isValidRemoteEntry(entry) && entry.scopes.includes(scope)
            const state = remoteOAuthSlots[id]?.[scope]
            if (slotExists && names.has(canonical(id, scope))) {
              expect(state).toEqual({ kind: 'foreign', serverName: canonical(id, scope) })
            } else {
              expect(state).toBeUndefined()
            }
          }
        }
      })
    )
  })

  it('adding a non-remote-OAuth server changes at most the slot whose canonical name it takes, to foreign', async () => {
    await run(
      fc.asyncProperty(
        scenarioArb.chain(sc => {
          const free = NAME_POOL.filter(n => !sc.specs.some(s => s.name === n))
          return fc.record({
            sc: fc.constant(sc),
            extra: free.length ? fc.constantFrom(...free) : fc.constant(null),
          })
        }),
        async ({ sc: { specs, page }, extra }) => {
          if (extra === null) return
          const before = await classify(specs, page)
          const after = await classify(
            [...specs, { kind: 'plain', name: extra, terminating: false }],
            page
          )
          expect(after.manualRemoteOAuth).toEqual(before.manualRemoteOAuth)
          const ids = new Set([
            ...Object.keys(before.remoteOAuthSlots),
            ...Object.keys(after.remoteOAuthSlots),
          ])
          for (const id of ids) {
            for (const scope of SCOPES) {
              const was = before.remoteOAuthSlots[id]?.[scope]
              const now = after.remoteOAuthSlots[id]?.[scope]
              if (canonical(id, scope) === extra && was === undefined) {
                expect(now === undefined || now.kind === 'foreign').toBe(true)
              } else {
                expect(now).toEqual(was)
              }
            }
          }
        }
      )
    )
  })

  it('a slot whose only claimant is terminating reports it terminating', async () => {
    await run(
      fc.asyncProperty(scenarioArb, async ({ specs, page }) => {
        const { remoteOAuthSlots } = await classify(specs, page)
        for (const id of VALID_IDS) {
          for (const scope of SCOPES) {
            const claims = claimants(specs, id, scope)
            if (claims.length !== 1 || !claims[0].terminating) continue
            expect(remoteOAuthSlots[id]?.[scope]).toMatchObject({
              kind: 'instance',
              serverName: claims[0].name,
              terminating: true,
            })
          }
        }
      })
    )
  })

  // Accepted behaviours, pinned so that changing them is a visible decision.

  it('accepted: a terminating canonical claimant beats a live non-canonical one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.constantFrom<string>(NOTION, LINEAR, ...OFF_PAGE),
          scope: scopeArb,
          other: fc.constantFrom('aaa-hand', 'zzz-hand'),
          version: fc.constantFrom<string>(...VERSIONS),
          page: pageArb,
        }),
        async ({ id, scope, other, version, page }) => {
          const specs: CrSpec[] = [
            { kind: 'catalog', name: other, scope, id, version, terminating: false },
            { kind: 'catalog', name: canonical(id, scope), scope, id, version, terminating: true },
          ]
          const { remoteOAuthSlots } = await classify(specs, page)
          expect(remoteOAuthSlots[id]?.[scope]).toMatchObject({
            serverName: canonical(id, scope),
            canonical: true,
            terminating: true,
          })
        }
      ),
      { numRuns: 100 }
    )
  })

  it('accepted: a terminating manual CR is still listed as manual', async () => {
    await run(
      fc.asyncProperty(scenarioArb, async ({ specs, page }) => {
        const { manualRemoteOAuth } = await classify(specs, page)
        const listedNames = new Set(manualRemoteOAuth.map(m => m.serverName))
        for (const s of specs) {
          if (s.kind === 'manual' && s.terminating) expect(listedNames.has(s.name)).toBe(true)
        }
      })
    )
  })
})

describe('classifyRemoteOAuthSlots property generators', () => {
  it('reach every row of the decision table, so the properties are not vacuous', async () => {
    const seen = {
      doubleClaim: 0,
      canonicalVsOther: 0,
      foreign: 0,
      discarded: 0,
      terminatingManual: 0,
      offPage: 0,
    }
    for (const { specs, page } of fc.sample(scenarioArb, { numRuns: NUM_RUNS, seed: 42 })) {
      const { remoteOAuthSlots } = await classify(specs, page)
      for (const id of VALID_IDS) {
        for (const scope of SCOPES) {
          const claims = claimants(specs, id, scope)
          if (claims.length > 1) seen.doubleClaim++
          if (claims.length > 1 && claims.some(c => c.name === canonical(id, scope))) {
            seen.canonicalVsOther++
          }
          if (remoteOAuthSlots[id]?.[scope]?.kind === 'foreign') seen.foreign++
        }
      }
      if (specs.some(s => s.kind === 'catalog' && !isValidId(s.id))) seen.discarded++
      if (specs.some(s => s.kind === 'manual' && s.terminating)) seen.terminatingManual++
      if (specs.some(s => s.kind === 'catalog' && (OFF_PAGE as readonly string[]).includes(s.id))) {
        seen.offPage++
      }
    }
    expect(Math.min(...Object.values(seen)), JSON.stringify(seen)).toBeGreaterThan(30)
  })
})
