import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginAuditLog } from '../pluginAuditLog.js'
import { PluginConsentGate } from '../pluginConsentGate.js'
import { LocalConsentStore } from '../pluginConsentStore.js'
import { PluginRateLimiter } from '../pluginRateLimiter.js'
import { PluginSdkBroker } from '../pluginSdkBroker.js'
import type { PluginSdkDataSource } from '../pluginSdkCapabilities.js'
import type { PluginConsentRequest } from '../pluginSdkProtocol.js'
import { _resetPluginSurfacesForTests, pinPluginSurface } from '../pluginSurfaceRegistry.js'

const ENV_KEY = 'testenv-0123456789ab'
const USER_ID = 'user-1'
const PLUGIN_ID = 'sandbox-recipes/leadforge'
const SENDER_ID = 42

let tmpDir: string
let store: LocalConsentStore
let audit: PluginAuditLog
let gate: PluginConsentGate
let broker: PluginSdkBroker
let prompts: PluginConsentRequest[]
/** What the fake user clicks on the next prompt. */
let nextDecision: (request: PluginConsentRequest) => string[]
let userId: string | null
let sleeps: number[]

function fakeSource(overrides: Partial<PluginSdkDataSource> = {}): PluginSdkDataSource {
  return {
    getSessionState: async () => ({
      authenticated: true,
      me: {
        id: USER_ID,
        email: 'andres@example.com',
        name: 'Andres',
        picture: 'https://cdn.example/avatar.png',
        teamId: 'team-1',
        teamName: 'Acme',
        role: 'member',
      },
    }),
    listMyAgents: async () => [
      {
        name: 'scout',
        contextRef: 'context1',
        provider: 'claude',
        mcpServers: [{ name: 'search' }],
        gfsSubject: { type: 'host', id: '1st:ns/scout' },
      },
    ],
    getAccessCatalog: async () =>
      ({
        userId: USER_ID,
        teamId: 'team-1',
        userContextIds: ['ctx-user'],
        userAgentNames: [],
        teamContextIds: ['ctx-team'],
        teamAgentNames: [],
        contextIds: [],
        agentNames: [],
        mcpServersByAgent: { scout: ['search'] },
      }) as never,
    listAccessibleMcpServers: async () =>
      ({
        userId: USER_ID,
        contextIds: [],
        servers: [{ name: 'search', url: 'http://search.mcp-server.svc.cluster.local:3000' }],
      }) as never,
    listAccessibleGfsResources: async () => ({ items: [], nextCursor: null }),
    listGfsChildren: async () => ({ items: [], nextCursor: null }),
    downloadGfsUri: async () => {
      throw new Error('not stubbed')
    },
    getPluginTheme: () => 'dark',
    showPluginNotification: async () => ({ delivered: true }),
    ...overrides,
  }
}

async function build(source = fakeSource()): Promise<void> {
  prompts = []
  sleeps = []
  nextDecision = request => request.rows.map(row => row.capability)
  userId = USER_ID
  store = new LocalConsentStore(path.join(tmpDir, 'consent'))
  audit = new PluginAuditLog(path.join(tmpDir, 'audit'))
  gate = new PluginConsentGate({
    store,
    presentPrompt: request => {
      prompts.push(request)
      // Answer on the next tick, the way a real renderer would.
      setTimeout(() => gate.resolvePrompt(request.promptId, nextDecision(request)), 0)
    },
    cancelPrompt: () => undefined,
    setSurfaceVisible: async () => undefined,
    isWindowReady: () => true,
    // Cooldowns are asserted directly in pluginConsentGate.test.ts; spending
    // ten real seconds per back-to-back prompt here would only slow the suite.
    sleep: async ms => {
      sleeps.push(ms)
    },
  })
  broker = new PluginSdkBroker({
    source,
    store,
    gate,
    limiter: new PluginRateLimiter(),
    audit,
    getEnvKey: () => ENV_KEY,
    getUserId: () => userId,
  })
  pinPluginSurface({
    pluginId: PLUGIN_ID,
    pluginTitle: 'LeadForge',
    surface: 'sandbox-ui-embed',
    webContentsId: SENDER_ID,
    generation: 1,
  })
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-sdk-broker-'))
  _resetPluginSurfacesForTests()
  await build()
})

afterEach(async () => {
  _resetPluginSurfacesForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function auditLines() {
  return audit.read(ENV_KEY, { limit: 100 })
}

describe('PluginSdkBroker — caller identity', () => {
  it('rejects an unpinned sender rather than treating it as an unknown plugin', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await broker.request(999, { v: 1, capability: 'identity.read' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: expect.any(String), retryable: false },
    })
    expect(prompts).toHaveLength(0)
  })

  it('derives the plugin id from the sender, never from the payload', async () => {
    await broker.request(SENDER_ID, {
      v: 1,
      capability: 'identity.read',
      // A plugin trying to claim someone else's identity gets ignored: the
      // broker never reads a pluginId off the wire.
      params: { pluginId: 'sandbox-recipes/other' },
    })
    const lines = await auditLines()
    expect(lines.every(line => line.pluginId === PLUGIN_ID)).toBe(true)
  })
})

describe('PluginSdkBroker — request gating', () => {
  it('rejects an unknown capability', async () => {
    const result = await broker.request(SENDER_ID, { v: 1, capability: 'identity.readAll' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_capability' } })
  })

  it('rejects an unknown protocol version', async () => {
    const result = await broker.request(SENDER_ID, { v: 99, capability: 'identity.read' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_version' } })
  })

  it('rejects unexpected params before prompting', async () => {
    const result = await broker.request(SENDER_ID, {
      v: 1,
      capability: 'identity.read',
      params: { verbose: true },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(prompts).toHaveLength(0)
  })

  it('fails closed when there is no session', async () => {
    userId = null
    const result = await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthenticated', retryable: true } })
  })

  it('prompts once, then serves later calls from the stored grant', async () => {
    const first = await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    expect(first).toMatchObject({ ok: true, data: { email: 'andres@example.com' } })
    expect(prompts).toHaveLength(1)

    const second = await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    expect(second).toMatchObject({ ok: true })
    expect(prompts).toHaveLength(1)
  })

  it('keeps a denial sticky for the rest of the mount', async () => {
    nextDecision = () => []
    const first = await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    expect(first).toMatchObject({ ok: false, error: { code: 'permission_denied' } })

    const second = await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    expect(second).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    // One prompt, not two: a refusal buys silence rather than a second ask.
    expect(prompts).toHaveLength(1)
  })

  it('does not prompt for an ambient capability', async () => {
    const result = await broker.request(SENDER_ID, { v: 1, capability: 'theme.read' })
    expect(result).toMatchObject({ ok: true, data: { theme: 'dark' } })
    expect(prompts).toHaveLength(0)
  })

  it('rate limits and refuses without calling the provider again', async () => {
    let calls = 0
    await build(
      fakeSource({
        getPluginTheme: () => {
          calls += 1
          return 'light'
        },
      })
    )
    // theme.read allows 60/min.
    for (let i = 0; i < 60; i += 1) {
      await broker.request(SENDER_ID, { v: 1, capability: 'theme.read' })
    }
    const limited = await broker.request(SENDER_ID, { v: 1, capability: 'theme.read' })
    expect(limited).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true } })
    expect(calls).toBe(60)
  })

  it('returns permission_revoked when a grant disappears mid-flight', async () => {
    await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    const source = fakeSource({
      getSessionState: async () => {
        // Simulate the user revoking in Settings while the provider is working.
        await store.revoke({
          envKey: ENV_KEY,
          userId: USER_ID,
          pluginId: PLUGIN_ID,
          capability: 'identity.read',
        })
        return {
          authenticated: true,
          me: {
            id: USER_ID,
            email: 'andres@example.com',
            name: 'Andres',
            picture: null,
            teamId: null,
            teamName: null,
            role: null,
          },
        }
      },
    })
    const racing = new PluginSdkBroker({
      source,
      store,
      gate,
      limiter: new PluginRateLimiter(),
      audit,
      getEnvKey: () => ENV_KEY,
      getUserId: () => USER_ID,
    })
    const result = await racing.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    expect(result).toMatchObject({ ok: false, error: { code: 'permission_revoked' } })
  })
})

describe('PluginSdkBroker — batched permissions', () => {
  it('opens one prompt for the whole batch and returns a per-row map', async () => {
    nextDecision = request =>
      request.rows.map(row => row.capability).filter(capability => capability !== 'gfs.list')

    const result = await broker.requestPermissions(SENDER_ID, {
      v: 1,
      capabilities: ['identity.read', 'org.read', 'agents.read', 'gfs.list'],
    })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.rows).toHaveLength(4)
    expect(result).toEqual({
      ok: true,
      data: {
        granted: {
          'identity.read': true,
          'org.read': true,
          'agents.read': true,
          'gfs.list': false,
        },
        all: false,
      },
    })
  })

  it('orders rows most-sensitive-first', async () => {
    await broker.requestPermissions(SENDER_ID, {
      v: 1,
      capabilities: ['agents.read', 'identity.read'],
    })
    expect(prompts[0]?.rows.map(row => row.capability)).toEqual(['identity.read', 'agents.read'])
  })

  it('drops already-granted ids from the prompt but keeps them in the answer', async () => {
    await broker.requestPermissions(SENDER_ID, { v: 1, capabilities: ['identity.read'] })
    prompts.length = 0

    const result = await broker.requestPermissions(SENDER_ID, {
      v: 1,
      capabilities: ['identity.read', 'org.read'],
    })
    expect(prompts[0]?.rows.map(row => row.capability)).toEqual(['org.read'])
    expect(result).toMatchObject({ data: { granted: { 'identity.read': true, 'org.read': true } } })
    // The second modal waited out the anti-fatigue cooldown before opening.
    expect(sleeps[0]).toBeGreaterThan(0)
  })

  it('rejects duplicates, unknown ids, and oversized batches before prompting', async () => {
    for (const capabilities of [
      ['identity.read', 'identity.read'],
      ['identity.read', 'nope.read'],
      new Array(9).fill('identity.read'),
      [],
    ]) {
      const result = await broker.requestPermissions(SENDER_ID, { v: 1, capabilities })
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    }
    expect(prompts).toHaveLength(0)
  })

  it('writes one audit line per row', async () => {
    nextDecision = () => ['identity.read']
    await broker.requestPermissions(SENDER_ID, {
      v: 1,
      capabilities: ['identity.read', 'org.read'],
    })
    const lines = await auditLines()
    expect(lines.filter(line => line.capability === 'identity.read')[0]?.outcome).toBe('granted')
    expect(lines.filter(line => line.capability === 'org.read')[0]?.outcome).toBe('denied')
  })
})

describe('PluginSdkBroker — permission state', () => {
  it('reports grant state without prompting', async () => {
    const before = await broker.permissionState(SENDER_ID, ['identity.read'])
    expect(before).toMatchObject({ data: { granted: { 'identity.read': false } } })
    expect(prompts).toHaveLength(0)

    await broker.requestPermissions(SENDER_ID, { v: 1, capabilities: ['identity.read'] })
    const after = await broker.permissionState(SENDER_ID, ['identity.read'])
    expect(after).toMatchObject({ data: { granted: { 'identity.read': true } } })
  })
})

describe('PluginSdkBroker — audit', () => {
  it('records the shape of a payload and never its contents', async () => {
    await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    const file = path.join(tmpDir, 'audit', `${ENV_KEY}.jsonl`)
    const raw = await fs.readFile(file, 'utf8')

    // The single most important property of the audit log: reading it must not
    // hand you the data it is auditing.
    expect(raw).not.toContain('andres@example.com')
    expect(raw).not.toContain('Andres')
    expect(raw).toContain('"fields":["email","name","userId"]')
  })

  it('records denials and rate limits, not just successes', async () => {
    nextDecision = () => []
    await broker.request(SENDER_ID, { v: 1, capability: 'identity.read' })
    const lines = await auditLines()
    expect(lines[0]).toMatchObject({ outcome: 'denied', consent: 'prompt_denied' })
  })
})
