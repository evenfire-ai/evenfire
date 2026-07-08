import { describe, expect, it } from 'vitest'
import { extractSecrets } from '../RecipeEditor'

/**
 * extractSecrets maps recipe secret references to the namespace where the
 * consuming pod runs: snippet-step + non-transport workload secrets -> sandbox
 * namespace; transport (MCP) workload secrets -> mcp-server namespace. The two
 * namespaces are passed in (tenant-aware) rather than hardcoded.
 */
describe('extractSecrets — tenant-aware namespace assignment', () => {
  const SANDBOX = 'sandbox-recipes-acme'
  const MCP = 'mcp-server-acme'

  it('assigns snippet-step secrets to the sandbox namespace', () => {
    const parsed = {
      spec: {
        steps: [
          {
            run: {
              type: 'snippet',
              capabilities: { secrets: [{ secretRef: { name: 'app-secret', key: 'api-key' } }] },
            },
          },
        ],
      },
    }
    const out = extractSecrets(parsed, SANDBOX, MCP)
    expect(out).toHaveLength(1)
    expect(out[0].secretName).toBe('app-secret')
    expect(out[0].keys[0].targetNamespaces).toEqual([SANDBOX])
  })

  it('assigns non-transport workload envSecrets to the sandbox namespace', () => {
    const parsed = {
      spec: {
        workloads: [
          {
            id: 'api',
            envSecret: { name: 'app-secret', keys: [{ secretKey: 'db-pass', envVar: 'DB_PASS' }] },
          },
        ],
      },
    }
    const out = extractSecrets(parsed, SANDBOX, MCP)
    expect(out[0].keys[0].targetNamespaces).toEqual([SANDBOX])
  })

  it('assigns transport (MCP) workload envSecrets to the mcp-server namespace', () => {
    const parsed = {
      spec: {
        workloads: [
          {
            id: 'mongo',
            transport: 'http',
            envSecret: { name: 'mongo-secret', keys: [{ secretKey: 'uri', envVar: 'MONGO_URI' }] },
          },
        ],
      },
    }
    const out = extractSecrets(parsed, SANDBOX, MCP)
    expect(out[0].keys[0].targetNamespaces).toEqual([MCP])
  })

  it('assigns the UI workload envSecret to the sandbox-ui namespace', () => {
    const parsed = {
      spec: {
        ui: { workloadRef: 'frontend' },
        workloads: [
          {
            id: 'frontend',
            envSecret: { name: 'ui-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
      },
    }
    const out = extractSecrets(parsed, SANDBOX, MCP)
    expect(out[0].keys[0].targetNamespaces).toEqual(['sandbox-ui'])
  })

  it('single-tenant bare namespaces flow through unchanged', () => {
    const parsed = {
      spec: {
        workloads: [{ id: 'api', envSecret: { name: 's', keys: [{ secretKey: 'k' }] } }],
      },
    }
    const out = extractSecrets(parsed, 'sandbox-recipes', 'mcp-server')
    expect(out[0].keys[0].targetNamespaces).toEqual(['sandbox-recipes'])
  })

  it('targets BOTH namespaces when one secret is referenced by a snippet AND a transport workload', () => {
    const parsed = {
      spec: {
        steps: [
          {
            run: {
              type: 'snippet',
              capabilities: { secrets: [{ secretRef: { name: 'shared', key: 'token' } }] },
            },
          },
        ],
        workloads: [
          {
            id: 'mongo',
            transport: 'http',
            envSecret: { name: 'shared', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
      },
    }
    const out = extractSecrets(parsed, SANDBOX, MCP)
    expect(out).toHaveLength(1)
    expect(out[0].secretName).toBe('shared')
    // accumulated across both references, in encounter order (snippet first)
    expect(out[0].keys[0].targetNamespaces).toEqual([SANDBOX, MCP])
    expect(out[0].targetNamespaces).toEqual([SANDBOX, MCP])
  })
})
