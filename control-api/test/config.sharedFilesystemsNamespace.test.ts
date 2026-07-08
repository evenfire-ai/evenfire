import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * SharedFileSystem CRDs live with the Hosts that mount their PVCs (the v1
 * invariant: "always in the mcp-host namespace"). On a per-tenant MCC cluster
 * the Hosts namespace is `mcp-host-<slug>`, set via CONTROL_API_HOSTS_NAMESPACE.
 *
 * The SharedFilesystems admin route must therefore resolve to the SAME
 * namespace the working CRD routes (Hosts) use — otherwise it queries the
 * untenanted `mcp-host` namespace and 403s (the route's RBAC is granted in
 * `mcp-host-<slug>`, never `mcp-host`).
 *
 * These tests pin that resolution:
 *  - default (no SFS var, no hosts var)         → `mcp-host`
 *  - tenant hosts var, no SFS var               → follows hosts namespace
 *  - explicit SFS var                           → wins over hosts namespace
 */

const KEYS = ['CONTROL_API_SHARED_FILESYSTEMS_NAMESPACE', 'CONTROL_API_HOSTS_NAMESPACE'] as const

async function loadConfigWith(overrides: Partial<Record<(typeof KEYS)[number], string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('control-api sharedFilesystemsNamespace config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults to mcp-host when neither var is set', async () => {
    const config = await loadConfigWith({})
    expect(config.hostsNamespace).toBe('mcp-host')
    expect(config.sharedFilesystemsNamespace).toBe('mcp-host')
  })

  it('follows the Hosts namespace when only CONTROL_API_HOSTS_NAMESPACE is set (per-tenant)', async () => {
    const config = await loadConfigWith({ CONTROL_API_HOSTS_NAMESPACE: 'mcp-host-deeptest1' })
    expect(config.hostsNamespace).toBe('mcp-host-deeptest1')
    expect(config.sharedFilesystemsNamespace).toBe('mcp-host-deeptest1')
  })

  it('honours an explicit CONTROL_API_SHARED_FILESYSTEMS_NAMESPACE over the Hosts namespace', async () => {
    const config = await loadConfigWith({
      CONTROL_API_HOSTS_NAMESPACE: 'mcp-host-deeptest1',
      CONTROL_API_SHARED_FILESYSTEMS_NAMESPACE: 'shared-fs-special',
    })
    expect(config.hostsNamespace).toBe('mcp-host-deeptest1')
    expect(config.sharedFilesystemsNamespace).toBe('shared-fs-special')
  })
})
