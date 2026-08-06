import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PLUGIN_GLOBAL_LIMIT, PluginRateLimiter } from '../pluginRateLimiter.js'
import { CAPABILITY_IDS } from '../pluginSdkCapabilities.js'
import {
  PLUGIN_SDK_CAPABILITIES_CHANNEL,
  PLUGIN_SDK_EVENT_CHANNEL,
  PLUGIN_SDK_PERMISSIONS_CHANNEL,
  PLUGIN_SDK_PERMISSION_STATE_CHANNEL,
  PLUGIN_SDK_PROTOCOL,
  PLUGIN_SDK_REQUEST_CHANNEL,
  PLUGIN_SDK_VERSION,
} from '../pluginSdkProtocol.js'
import {
  _resetPluginSurfacesForTests,
  allPinnedSurfaces,
  pinPluginSurface,
  resolvePluginSurface,
  unpinPluginSurface,
  unpinPluginSurfacesOfKind,
} from '../pluginSurfaceRegistry.js'
import { classifyEmbedNavigation } from '../sandboxUiPartitionPolicies.js'

// `import.meta` is unavailable in this CommonJS build; resolve from cwd, which
// vitest sets to the desktop-app package root.
const PRELOAD_PATH = path.join(process.cwd(), 'src', 'sandboxUiEmbedPreload.ts')

describe('PluginRateLimiter', () => {
  let clock: number
  let limiter: PluginRateLimiter

  beforeEach(() => {
    clock = 0
    limiter = new PluginRateLimiter(() => clock)
  })

  it('allows up to the per-minute budget then refuses with a retry hint', () => {
    const spec = { perMinute: 3, perHour: 100 }
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.take('p', 'c', spec).allowed).toBe(true)
    }
    const denied = limiter.take('p', 'c', spec)
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  it('refills continuously rather than resetting on a window edge', () => {
    const spec = { perMinute: 60, perHour: 3600 }
    for (let i = 0; i < 60; i += 1) limiter.take('p', 'c', spec)
    expect(limiter.take('p', 'c', spec).allowed).toBe(false)
    clock += 1_000 // one second buys exactly one token at 60/min
    expect(limiter.take('p', 'c', spec).allowed).toBe(true)
  })

  it('stops a plugin round-robining past per-capability budgets', () => {
    const generous = { perMinute: 1000, perHour: 10_000 }
    let allowed = 0
    for (let i = 0; i < PLUGIN_GLOBAL_LIMIT.perMinute + 10; i += 1) {
      if (limiter.take('p', `cap-${i % 5}`, generous).allowed) allowed += 1
    }
    expect(allowed).toBe(PLUGIN_GLOBAL_LIMIT.perMinute)
  })

  it('refunds the capability token when only the global bucket is exhausted', () => {
    const generous = { perMinute: 1000, perHour: 10_000 }
    for (let i = 0; i < PLUGIN_GLOBAL_LIMIT.perMinute; i += 1) limiter.take('p', 'c', generous)
    expect(limiter.take('p', 'c', generous).allowed).toBe(false)
    // A globally throttled plugin should not also have burned its per-capability
    // budget: once the global bucket refills, the capability must be callable.
    clock += 60_000
    expect(limiter.take('p', 'c', generous).allowed).toBe(true)
  })

  it('keeps plugins independent and forgets a plugin on reset', () => {
    const spec = { perMinute: 1, perHour: 10 }
    expect(limiter.take('a', 'c', spec).allowed).toBe(true)
    expect(limiter.take('a', 'c', spec).allowed).toBe(false)
    expect(limiter.take('b', 'c', spec).allowed).toBe(true)
    limiter.reset('a')
    expect(limiter.take('a', 'c', spec).allowed).toBe(true)
  })
})

describe('pluginSurfaceRegistry', () => {
  beforeEach(() => _resetPluginSurfacesForTests())
  afterEach(() => _resetPluginSurfacesForTests())

  const surface = {
    pluginId: 'ns/plugin',
    pluginTitle: 'Plugin',
    surface: 'sandbox-ui-embed' as const,
    webContentsId: 7,
    generation: 1,
  }

  it('resolves a pinned sender and returns null for anything else', () => {
    pinPluginSurface(surface)
    expect(resolvePluginSurface(7)?.pluginId).toBe('ns/plugin')
    expect(resolvePluginSurface(8)).toBeNull()
  })

  it('forgets a surface on unpin', () => {
    pinPluginSurface(surface)
    unpinPluginSurface(7)
    expect(resolvePluginSurface(7)).toBeNull()
  })

  it('clears a whole kind and reports what it dropped', () => {
    pinPluginSurface(surface)
    pinPluginSurface({ ...surface, webContentsId: 8, pluginId: 'ns/other' })
    const dropped = unpinPluginSurfacesOfKind('sandbox-ui-embed')
    expect(dropped.map(item => item.pluginId).sort()).toEqual(['ns/other', 'ns/plugin'])
    expect(allPinnedSurfaces()).toEqual([])
  })
})

describe('embed preload contract', () => {
  /**
   * The embed preload runs with `sandbox: true`, where Electron's `require` is
   * a polyfill limited to `electron` and a few builtins — it cannot import the
   * protocol module. The channel names are therefore duplicated as literals in
   * that file, and this test is what stops the copies from drifting apart.
   */
  it('inlines exactly the channel names and version the protocol module defines', async () => {
    const source = await fs.readFile(PRELOAD_PATH, 'utf8')
    for (const value of [
      PLUGIN_SDK_REQUEST_CHANNEL,
      PLUGIN_SDK_PERMISSIONS_CHANNEL,
      PLUGIN_SDK_PERMISSION_STATE_CHANNEL,
      PLUGIN_SDK_CAPABILITIES_CHANNEL,
      PLUGIN_SDK_EVENT_CHANNEL,
      PLUGIN_SDK_VERSION,
    ]) {
      expect(source, `preload is missing ${value}`).toContain(`'${value}'`)
    }
    expect(source).toContain(`const PLUGIN_SDK_PROTOCOL = ${PLUGIN_SDK_PROTOCOL}`)
  })

  it('never imports a relative module at runtime', async () => {
    const source = await fs.readFile(PRELOAD_PATH, 'utf8')
    const relativeValueImports = source
      .split('\n')
      .filter(line => /^import\s/.test(line) && line.includes("'./"))
      .filter(line => !line.includes('import type'))
    // A value import of a relative module compiles to `require('./…')`, which
    // throws in a sandboxed preload at runtime — a failure no typecheck catches.
    expect(relativeValueImports).toEqual([])
  })

  it('exposes one wrapper per capability the catalog defines', async () => {
    const source = await fs.readFile(PRELOAD_PATH, 'utf8')
    for (const id of CAPABILITY_IDS) {
      expect(source, `preload has no wrapper for ${id}`).toContain(`'${id}'`)
    }
  })
})

describe('gfs:// links from an embed', () => {
  const PREFIX = 'https://proxy.example/api/v1/sandbox-ui/ns/plugin/view'

  it('classifies a gfs link as an open request instead of dropping it', () => {
    expect(classifyEmbedNavigation('gfs://main/reports/q3.png', PREFIX)).toEqual({
      kind: 'gfs_open',
      uri: 'gfs://main/reports/q3.png',
    })
  })

  it('still drops every other non-http scheme', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<h1>x', 'javascript:alert(1)']) {
      expect(classifyEmbedNavigation(url, PREFIX).kind, url).toBe('drop')
    }
  })

  it('drops an absurdly long gfs uri rather than forwarding it', () => {
    expect(classifyEmbedNavigation(`gfs://main/${'a'.repeat(4096)}`, PREFIX).kind).toBe('drop')
  })

  it('leaves in-app navigation and external links alone', () => {
    expect(classifyEmbedNavigation(`${PREFIX}/dashboard`, PREFIX).kind).toBe('allow')
    expect(classifyEmbedNavigation('https://example.com', PREFIX).kind).toBe('external')
  })
})
