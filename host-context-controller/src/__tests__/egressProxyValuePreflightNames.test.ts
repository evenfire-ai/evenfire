import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FORBIDDEN_CRD_ENV_NAMES, RESERVED_PROXY_ENV } from '../reconciler'

/**
 * SC-1: the operator script keeps its two name lists on
 * greppable `RESERVED_NAMES=` / `FORBIDDEN_NAMES=` lines so that this test can
 * compare them with the exported TypeScript sets instead of duplicating them.
 * A drift on either side fails here; the script test's own SC-1 section pins the
 * same comparison from the shell side.
 */
vi.mock('../config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    mcpServerImagePullPolicy: 'IfNotPresent',
    egressProxyImage: 'clerum/nginx-egress-proxy:0.1.0',
    stdioBridgeImage: 'clerum/stdio-bridge:test',
    stdioBridgeResources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    },
    devMcpServers: [],
    devContexts: [],
    devAuthTokens: new Map(),
  },
}))

const SCRIPT_PATH = resolve(__dirname, '../../../scripts/ops/egress-proxy-value-preflight.sh')

/** The single-quoted, space-separated list on the `KEY=` line of the script. */
function listedNames(key: 'RESERVED_NAMES' | 'FORBIDDEN_NAMES'): string[] {
  const lines = readFileSync(SCRIPT_PATH, 'utf8')
    .split('\n')
    .filter(line => line.startsWith(`${key}='`))
  expect(lines, `${key}= line must appear exactly once`).toHaveLength(1)
  const match = /^([A-Z_]+)='([^']*)'$/.exec(lines[0])
  expect(match, `${key} must be a single-quoted space-separated list`).not.toBeNull()
  const names = (match?.[2] ?? '').split(/\s+/).filter(name => name !== '')
  // Witness: the line is parsed and non-empty.
  expect(names.length, `${key} must hold at least one name`).toBeGreaterThan(0)
  return names
}

function sorted(names: Iterable<string>): string[] {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

describe('operator script name lists match the HCC sets (SC-1)', () => {
  it('RESERVED_NAMES equals the exported RESERVED_PROXY_ENV (8)', () => {
    expect(sorted(listedNames('RESERVED_NAMES'))).toEqual(sorted(RESERVED_PROXY_ENV))
    expect(RESERVED_PROXY_ENV.size).toBe(8)
    // Witness: both halves are there, so the union is not silently one subset.
    expect(RESERVED_PROXY_ENV.has('NGINX_ENVSUBST_FILTER')).toBe(true)
    expect(RESERVED_PROXY_ENV.has('NGINX_LOCAL_RESOLVERS')).toBe(true)
  })

  it('FORBIDDEN_NAMES equals the exported FORBIDDEN_CRD_ENV_NAMES (9)', () => {
    expect(sorted(listedNames('FORBIDDEN_NAMES'))).toEqual(sorted(FORBIDDEN_CRD_ENV_NAMES))
    expect(FORBIDDEN_CRD_ENV_NAMES.size).toBe(9)
    expect(FORBIDDEN_CRD_ENV_NAMES.has('LD_PRELOAD')).toBe(true)
  })
})
