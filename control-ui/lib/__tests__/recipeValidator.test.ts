import { describe, expect, it } from 'vitest'
import { DEFAULT_OPERATOR_DEFAULTS } from '../recipeDefaults'
import { WORKFLOW_RECIPE_UI_LIMITS, validateRecipe } from '../recipeValidator'

// ── helpers ────────────────────────────────────────────────────────────────
function makeValid(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'my-recipe' },
    spec: {
      workloads: [{ id: 'api-server', type: 'deployment', image: 'my-api:latest' }],
    },
    ...overrides,
  })
}

// ── Phase 1: JSON parse ────────────────────────────────────────────────────
describe('Phase 1 – JSON parse', () => {
  it('returns error for invalid JSON', () => {
    const r = validateRecipe('{bad json}')
    expect(r.valid).toBe(false)
    expect(r.issues[0].phase).toBe('parse')
    expect(r.issues[0].severity).toBe('error')
  })

  it('returns error for JSON array', () => {
    const r = validateRecipe('[]')
    expect(r.valid).toBe(false)
    expect(r.issues[0].message).toMatch(/object/)
  })

  it('returns error for JSON null', () => {
    const r = validateRecipe('null')
    expect(r.valid).toBe(false)
  })

  it('parses valid JSON and exposes `parsed`', () => {
    const r = validateRecipe(makeValid())
    expect(r.parsed).toBeDefined()
    expect(r.parsed?.metadata?.name).toBe('my-recipe')
  })
})

// ── Phase 2: Schema ────────────────────────────────────────────────────────
describe('Phase 2 – Schema', () => {
  it('passes a fully valid recipe', () => {
    const r = validateRecipe(makeValid())
    expect(r.valid).toBe(true)
    expect(r.issues.filter(i => i.severity === 'error')).toHaveLength(0)
  })

  it('rejects wrong apiVersion', () => {
    const r = validateRecipe(makeValid({ apiVersion: 'wrong/v1' }))
    const err = r.issues.find(i => i.path === 'apiVersion')
    expect(err?.severity).toBe('error')
  })

  it('rejects wrong kind', () => {
    const r = validateRecipe(makeValid({ kind: 'Recipe' }))
    const err = r.issues.find(i => i.path === 'kind')
    expect(err?.severity).toBe('error')
  })

  it('ignores metadata.namespace=sandbox-recipes without any namespace warning', () => {
    const r = validateRecipe(
      makeValid({
        metadata: { name: 'my-recipe', namespace: 'sandbox-recipes' },
      })
    )
    expect(r.issues.some(i => i.path === 'metadata.namespace' && i.severity === 'warning')).toBe(
      false
    )
  })

  it('ignores metadata.namespace=mcp-server because platform placement is server-owned', () => {
    const r = validateRecipe(
      makeValid({
        metadata: { name: 'my-recipe', namespace: 'mcp-server' },
      })
    )
    expect(r.valid).toBe(true)
    expect(r.issues.some(i => i.path === 'metadata.namespace')).toBe(false)
  })

  it('ignores arbitrary metadata.namespace because control-api strips it before write', () => {
    const r = validateRecipe(
      makeValid({
        metadata: { name: 'my-recipe', namespace: 'control-plane' },
      })
    )
    expect(r.valid).toBe(true)
    expect(r.issues.some(i => i.path === 'metadata.namespace')).toBe(false)
  })

  it('rejects missing metadata.name', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: {},
        spec: { workloads: [{ id: 'a', type: 'deployment', image: 'x' }] },
      })
    )
    expect(r.issues.some(i => i.path === 'metadata.name')).toBe(true)
  })

  it('warns when workflow step output previews can exceed the Kubernetes object budget', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'large-preview-budget' },
        spec: {
          triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
          steps: Array.from({ length: 48 }, (_, i) => ({
            id: `s-${i}`,
            instruction: `step ${i}`,
          })),
        },
      })
    )

    expect(r.valid).toBe(true)
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.steps',
        severity: 'warning',
        message: expect.stringContaining('Kubernetes object budget'),
      })
    )
  })

  it('rejects non-RFC1123 name (uppercase)', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'MyRecipe' },
        spec: { workloads: [{ id: 'a', type: 'deployment', image: 'x' }] },
      })
    )
    expect(r.issues.some(i => i.path === 'metadata.name')).toBe(true)
  })

  it('rejects empty workloads array', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: { workloads: [] },
      })
    )
    expect(r.issues.some(i => i.path === 'spec.workloads')).toBe(true)
  })

  it('rejects workload missing id', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: { workloads: [{ type: 'deployment', image: 'x' }] },
      })
    )
    expect(r.issues.some(i => i.path?.includes('.id'))).toBe(true)
  })

  it('rejects duplicate workload ids', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            { id: 'same', type: 'deployment', image: 'a' },
            { id: 'same', type: 'deployment', image: 'b' },
          ],
        },
      })
    )
    expect(r.issues.some(i => i.message?.includes('Duplicate'))).toBe(true)
  })

  it('rejects invalid workload type', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: { workloads: [{ id: 'w', type: 'pod', image: 'x' }] },
      })
    )
    expect(r.issues.some(i => i.path?.includes('.type'))).toBe(true)
  })

  it('rejects workload missing image', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: { workloads: [{ id: 'w', type: 'deployment' }] },
      })
    )
    expect(r.issues.some(i => i.path?.includes('.image'))).toBe(true)
  })

  it('rejects inline sensitive workload env values', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'COINGECKO_API_KEY', value: 'CG-very-secret-token' }],
            },
          ],
        },
      })
    )

    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.workloads[0].env[0].value',
        severity: 'error',
        message: expect.stringContaining('move this value to envSecret'),
      })
    )
  })

  it('rejects explicit token-like workload env values', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'EXTERNAL_REFERENCE', value: 'sk-testTokenValue1234567890' }],
            },
          ],
        },
      })
    )

    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.workloads[0].env[0].value',
        severity: 'error',
        message: expect.stringContaining('move this value to envSecret'),
      })
    )
  })

  it('still rejects literal credentials embedded in workload env URL values', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'DATABASE_URL', value: 'postgres://app:literal-value@db' }],
            },
          ],
        },
      })
    )

    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.workloads[0].env[0].value',
        severity: 'error',
        message: expect.stringContaining('env value looks sensitive'),
      })
    )
  })

  it('warns when workload env.value references a sensitive input template', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          inputContract: {
            properties: {
              db_password: { type: 'string' },
            },
          },
          inputs: {
            db_password: 'placeholder',
          },
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'DATABASE_URL', value: 'postgres://app:{{inputs.db_password}}@db' }],
            },
          ],
        },
      })
    )

    expect(r.valid).toBe(true)
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.workloads[0].env[0].value',
        severity: 'warning',
        message: expect.stringContaining('{{inputs.db_password}}'),
      })
    )
    expect(r.issues.some(issue => issue.severity === 'error')).toBe(false)
  })

  it('warns instead of blocking when a sensitive env name uses a sensitive input template', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          inputContract: {
            properties: {
              db_password: { type: 'string' },
            },
          },
          inputs: {
            db_password: 'placeholder',
          },
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'POSTGRES_PASSWORD', value: '{{inputs.db_password}}' }],
            },
          ],
        },
      })
    )

    expect(r.valid).toBe(true)
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.workloads[0].env[0].value',
        severity: 'warning',
        message: expect.stringContaining('{{inputs.db_password}}'),
      })
    )
    expect(r.issues.some(issue => issue.severity === 'error')).toBe(false)
  })

  it('does not warn for non-sensitive input templates in workload env.value', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          inputContract: {
            properties: {
              db_name: { type: 'string' },
            },
          },
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'DATABASE_URL', value: 'postgres://app@db/{{inputs.db_name}}' }],
            },
          ],
        },
      })
    )

    expect(r.valid).toBe(true)
    expect(r.issues.some(issue => issue.severity === 'warning')).toBe(false)
  })

  it('accepts benign long workload env values', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [
                {
                  name: 'INTERNAL_BUILD_METADATA',
                  value: 'some-long-build-metadata-value-for-tracking-purposes-20260512',
                },
              ],
            },
          ],
        },
      })
    )

    expect(r.valid).toBe(true)
  })

  it('rejects dependsOn referencing unknown workload id', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [{ id: 'a', type: 'deployment', image: 'x', dependsOn: ['nonexistent'] }],
        },
      })
    )
    expect(r.issues.some(i => i.message?.includes('nonexistent'))).toBe(true)
  })

  it('accepts a binding from an MCP transport workload to a backend workload', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          contextRef: 'context1',
          workloads: [
            {
              id: 'mcp-api',
              type: 'deployment',
              image: 'mcp:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
            },
            { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
          ],
          bindings: [{ from: 'mcp-api', to: 'db', port: 5432 }],
        },
      })
    )

    expect(r.issues.filter(i => i.severity === 'error')).toHaveLength(0)
  })

  it('rejects bindings that reference unknown workloads', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          contextRef: 'context1',
          workloads: [
            {
              id: 'mcp-api',
              type: 'deployment',
              image: 'mcp:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
            },
          ],
          bindings: [{ from: 'mcp-api', to: 'missing-db', port: 5432 }],
        },
      })
    )

    expect(r.issues.some(i => i.path === 'spec.bindings[0].to')).toBe(true)
    expect(r.issues.some(i => i.message.includes('missing-db'))).toBe(true)
  })

  it('rejects bindings without exactly one MCP transport workload endpoint', () => {
    const noTransport = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
            { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
          ],
          bindings: [{ from: 'app', to: 'db', port: 5432 }],
        },
      })
    )
    const bothTransport = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          contextRef: 'context1',
          workloads: [
            {
              id: 'mcp-a',
              type: 'deployment',
              image: 'mcp-a:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
            },
            {
              id: 'mcp-b',
              type: 'deployment',
              image: 'mcp-b:latest',
              port: 3001,
              transport: { type: 'streamableHttp' },
            },
          ],
          bindings: [{ from: 'mcp-a', to: 'mcp-b', port: 3001 }],
        },
      })
    )

    expect(noTransport.issues.some(i => i.path === 'spec.bindings[0]')).toBe(true)
    expect(bothTransport.issues.some(i => i.path === 'spec.bindings[0]')).toBe(true)
  })

  it('rejects binding ports and protocols outside the supported range', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          contextRef: 'context1',
          workloads: [
            {
              id: 'mcp-api',
              type: 'deployment',
              image: 'mcp:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
            },
            { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
          ],
          bindings: [{ from: 'mcp-api', to: 'db', port: 70000, protocol: 'ICMP' }],
        },
      })
    )

    expect(r.issues.some(i => i.path === 'spec.bindings[0].port')).toBe(true)
    expect(r.issues.some(i => i.path === 'spec.bindings[0].protocol')).toBe(true)
  })

  it('accepts all valid workload types', () => {
    const types = ['deployment', 'statefulset', 'cronjob', 'job', 'daemonset']
    types.forEach(type => {
      const r = validateRecipe(
        JSON.stringify({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'r' },
          spec: { workloads: [{ id: 'w', type, image: 'x' }] },
        })
      )
      expect(
        r.issues.filter(i => i.severity === 'error' && i.path?.includes('.type'))
      ).toHaveLength(0)
    })
  })

  it('rejects WorkflowRecipe egressBindings using CIDR notation in dns', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              egressBindings: [{ dns: '0.0.0.0/0', port: 443 }],
            },
          ],
        },
      })
    )

    expect(r.issues.some(i => i.path === 'spec.workloads[0].egressBindings[0].dns')).toBe(true)
    expect(r.issues.some(i => i.message.includes('CIDR notation'))).toBe(true)
  })

  it('rejects WorkflowRecipe egressBindings using wildcard dns', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              egressBindings: [{ dns: '*.internal.local', port: 443 }],
            },
          ],
        },
      })
    )

    expect(r.issues.some(i => i.message.includes('wildcard dns values'))).toBe(true)
  })

  it('rejects WorkflowRecipe egressBindings smuggling cidr and extra keys', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              egressBindings: [
                {
                  dns: 'api.openai.com',
                  port: 443,
                  cidr: '10.0.0.0/8',
                  note: 'unexpected',
                },
              ],
            },
          ],
        },
      })
    )

    expect(r.issues.some(i => i.path === 'spec.workloads[0].egressBindings[0].cidr')).toBe(true)
    expect(r.issues.some(i => i.path === 'spec.workloads[0].egressBindings[0].note')).toBe(true)
  })

  it('accepts explicit public-web egressBindings with an operator warning', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              port: 3000,
              transport: { type: 'streamableHttp' },
              egressBindings: [{ egressClass: 'public-web' }],
            },
          ],
        },
      })
    )

    expect(r.issues.filter(i => i.severity === 'error')).toHaveLength(0)
    expect(
      r.issues.some(
        i =>
          i.severity === 'warning' &&
          i.path === 'spec.workloads[0].egressBindings[0].egressClass' &&
          i.message.includes('public internet egress')
      )
    ).toBe(true)
  })

  it('rejects public-web egressBindings that also declare exact-host fields', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              port: 3000,
              transport: { type: 'streamableHttp' },
              egressBindings: [{ egressClass: 'public-web', dns: 'api.example.com', port: 443 }],
            },
          ],
        },
      })
    )

    expect(
      r.issues.some(i => i.message.includes('public-web egressBindings must not declare'))
    ).toBe(true)
  })
})

describe('WorkflowRecipe egress limits', () => {
  it.each(['deployment', 'statefulset', 'job', 'cronjob', 'daemonset'])(
    'accepts exact-host egressBindings on non-transport %s workloads',
    type => {
      const r = validateRecipe(
        makeValid({
          spec: {
            workloads: [
              {
                id: 'worker',
                type,
                image: 'worker:latest',
                egressBindings: [{ dns: 'api.example.com', port: 443 }],
              },
            ],
          },
        })
      )

      expect(r.issues.filter(i => i.severity === 'error')).toHaveLength(0)
    }
  )

  it('rejects public-web egressBindings on non-transport workloads', () => {
    const r = validateRecipe(
      makeValid({
        spec: {
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:latest',
              egressBindings: [{ egressClass: 'public-web' }],
            },
          ],
        },
      })
    )

    expect(r.valid).toBe(false)
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.workloads[0].egressBindings[0].egressClass',
        message:
          'public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings',
      })
    )
  })

  it('rejects transport workload egressBindings over the CRD maximum', () => {
    const r = validateRecipe(
      makeValid({
        spec: {
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'web-search:latest',
              transport: { type: 'streamableHttp', port: 3000 },
              egressBindings: Array.from({ length: 21 }, (_, index) => ({
                dns: `api-${index}.example.com`,
                port: 443,
                protocol: 'TCP',
              })),
            },
          ],
        },
      })
    )

    expect(r.valid).toBe(false)
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.workloads[0].egressBindings',
        message: expect.stringContaining('at most 20'),
      })
    )
  })

  it('rejects runtime and step HTTP allowedHosts over the maximum', () => {
    const hosts = Array.from({ length: 21 }, (_, index) => `api-${index}.example.com`)
    const r = validateRecipe(
      makeValid({
        spec: {
          workloads: [{ id: 'api-server', type: 'deployment', image: 'my-api:latest' }],
          runtimeEgress: { http: { allowedHosts: hosts } },
          steps: [
            {
              id: 'fetch',
              run: {
                type: 'snippet',
                language: 'typescript',
                code: 'export default async () => ({ ok: true })',
                capabilities: { http: { allowedHosts: hosts } },
              },
            },
          ],
        },
      })
    )

    expect(r.valid).toBe(false)
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.runtimeEgress.http.allowedHosts',
        message: expect.stringContaining('at most 20'),
      })
    )
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.steps[0].run.capabilities.http.allowedHosts',
        message: expect.stringContaining('at most 20'),
      })
    )
  })
})

// ── Phase 3: Security ──────────────────────────────────────────────────────
describe('Phase 3 – Security compliance', () => {
  it('rejects runAsUser = 0 (root)', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              security: { runAsUser: 0 },
            },
          ],
        },
      }),
      DEFAULT_OPERATOR_DEFAULTS
    )
    expect(r.issues.some(i => i.path?.includes('runAsUser') && i.severity === 'error')).toBe(true)
  })

  it('allows runAsUser >= 1', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [{ id: 'w', type: 'deployment', image: 'x', security: { runAsUser: 1000 } }],
        },
      }),
      DEFAULT_OPERATOR_DEFAULTS
    )
    expect(r.issues.filter(i => i.path?.includes('runAsUser'))).toHaveLength(0)
  })

  it('rejects capability not in allowlist', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              security: { addCapabilities: ['NET_ADMIN'] },
            },
          ],
        },
      }),
      DEFAULT_OPERATOR_DEFAULTS
    )
    expect(r.issues.some(i => i.message?.includes('NET_ADMIN') && i.severity === 'error')).toBe(
      true
    )
  })

  it('allows capabilities in the allowlist', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              security: { addCapabilities: ['CHOWN', 'FOWNER'] },
            },
          ],
        },
      }),
      DEFAULT_OPERATOR_DEFAULTS
    )
    expect(r.issues.filter(i => i.severity === 'error')).toHaveLength(0)
  })

  it('rejects privilege-boundary capabilities', () => {
    const deniedCapabilities = ['SETUID', 'SETGID', 'SYS_CHROOT', 'KILL', 'AUDIT_WRITE']
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              security: { addCapabilities: deniedCapabilities },
            },
          ],
        },
      }),
      DEFAULT_OPERATOR_DEFAULTS
    )
    deniedCapabilities.forEach(cap => {
      expect(r.issues.some(i => i.message?.includes(cap) && i.severity === 'error')).toBe(true)
    })
  })

  it('warns when PVC size exceeds operator max', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'statefulset',
              image: 'x',
              volumeClaimTemplates: [{ name: 'data', size: '500Gi' }],
            },
          ],
        },
      }),
      DEFAULT_OPERATOR_DEFAULTS
    )
    expect(r.issues.some(i => i.severity === 'warning' && i.path?.includes('size'))).toBe(true)
  })

  it('skips security checks when no defaults provided', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'r' },
        spec: {
          workloads: [
            {
              id: 'w',
              type: 'deployment',
              image: 'x',
              security: { runAsUser: 0 },
            },
          ],
        },
      })
      // no defaults passed
    )
    expect(r.issues.filter(i => i.phase === 'security')).toHaveLength(0)
  })
})

// ── Triggers & RunRetention ─────────────────────────────────────────────
function makeWorkflow(specOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'triggered-recipe' },
    spec: {
      workloads: [
        { id: 'mock-mcp', type: 'deployment', image: 'mock:latest', transport: { type: 'http' } },
      ],
      contextRef: 'context1',
      steps: [{ id: 'step1', instruction: 'Do something', mcpServers: ['mock-mcp'] }],
      mcpServers: [{ id: 'mock-mcp', endpoint: 'http://mock:3000/mcp' }],
      ...specOverrides,
    },
  })
}

describe('Step kind validation', () => {
  it('accepts a snippet step with run and no instruction', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'make-id',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { id: "abc" }',
            },
          },
        ],
      })
    )

    expect(
      r.issues.filter(i => i.path?.startsWith('spec.steps') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('accepts a TypeScript snippet step with artifacts capability', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'emit',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: { artifacts: { maxCount: 1 } },
            },
          },
        ],
      })
    )

    expect(
      r.issues.filter(i => i.path?.startsWith('spec.steps') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('rejects a step with both instruction and run', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'ambiguous',
            instruction: 'Do this with an agent.',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
            },
          },
        ],
      })
    )

    expect(
      r.issues.some(
        i =>
          i.path === 'spec.steps[0]' && i.message === 'Step cannot declare both instruction and run'
      )
    ).toBe(true)
  })

  it('rejects a step with neither instruction nor run', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [{ id: 'empty-step' }],
      })
    )

    expect(
      r.issues.some(
        i =>
          i.path === 'spec.steps[0]' &&
          i.message === 'Step must declare exactly one of instruction or run'
      )
    ).toBe(true)
  })

  it('rejects duplicate step ids before submit', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          { id: 'research', instruction: 'Research' },
          { id: 'research', instruction: 'Duplicate' },
        ],
      })
    )

    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.steps[1].id',
        message: 'Duplicate step id "research"',
        severity: 'error',
      })
    )
  })

  it('accepts id-only steps when a custom coordinator image is declared', () => {
    const r = validateRecipe(
      makeWorkflow({
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'custom-step' }],
      })
    )

    expect(
      r.issues.filter(i => i.path?.startsWith('spec.steps') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('rejects run without snippet type', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [{ id: 'missing-type', run: { language: 'typescript', code: 'return {}' } }],
      })
    )

    expect(
      r.issues.some(
        i =>
          i.path === 'spec.steps[0].run.type' &&
          i.message === 'run.type must be "snippet"' &&
          i.severity === 'error'
      )
    ).toBe(true)
  })

  it('rejects run without snippet code', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'missing-code',
            run: {
              type: 'snippet',
              language: 'typescript',
            },
          },
        ],
      })
    )

    expect(
      r.issues.some(
        i =>
          i.path === 'spec.steps[0].run.code' &&
          i.message === 'snippet code must be a non-empty string' &&
          i.severity === 'error'
      )
    ).toBe(true)
  })

  it('rejects snippet steps that are not TypeScript', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'bad-language',
            run: {
              type: 'snippet',
              language: 'javascript',
              code: 'return { ok: true }',
            },
          },
        ],
      })
    )

    expect(
      r.issues.some(i => i.path === 'spec.steps[0].run.language' && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects non-object snippet capabilities', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'bad-capabilities',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return {}',
              capabilities: [],
            },
          },
        ],
      })
    )

    expect(
      r.issues.some(
        i =>
          i.path === 'spec.steps[0].run.capabilities' &&
          i.message === 'snippet capabilities must be an object' &&
          i.severity === 'error'
      )
    ).toBe(true)
  })

  it('rejects unsupported run fields', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'extra-run-field',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return {}',
              unexpected: true,
            },
          },
        ],
      })
    )

    expect(
      r.issues.some(
        i =>
          i.path === 'spec.steps[0].run.unexpected' &&
          i.message === 'unsupported run field' &&
          i.severity === 'error'
      )
    ).toBe(true)
  })

  it('rejects legacy run.handler fields explicitly', () => {
    const r = validateRecipe(
      makeWorkflow({
        steps: [
          {
            id: 'legacy-handler',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return {}',
              handler: 'noop',
            },
          },
        ],
      })
    )

    expect(r.issues).toContainEqual(
      expect.objectContaining({
        path: 'spec.steps[0].run.handler',
        message: 'unsupported run field',
        severity: 'error',
      })
    )
  })
})

describe('Triggers validation', () => {
  it('rejects workflow steps without any trigger declaration', () => {
    const r = validateRecipe(makeWorkflow({ triggers: undefined }))
    expect(
      r.issues.some(
        i =>
          i.path === 'spec.triggers' &&
          i.severity === 'error' &&
          i.message.includes('must declare spec.triggers.onDemand or spec.triggers.schedule')
      )
    ).toBe(true)
  })

  it('accepts valid triggers with onDemand only', () => {
    const r = validateRecipe(
      makeWorkflow({ triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } } })
    )
    expect(
      r.issues.filter(i => i.path?.startsWith('spec.triggers') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('accepts trigger-level approval without workflow steps', () => {
    const r = validateRecipe(
      makeWorkflow({ triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } } })
    )

    expect(
      r.issues.filter(i => i.path?.startsWith('spec.triggers') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('accepts trigger-level approval when a step approval target exists', () => {
    const r = validateRecipe(
      makeWorkflow({
        triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } },
        steps: [
          {
            id: 'step1',
            instruction: 'Do something',
            mcpServers: ['mock-mcp'],
            requiresApproval: {
              target: { userId: '00000000-0000-4000-8000-000000000001' },
              message: 'Approve this workflow step',
              timeoutSeconds: 3600,
            },
          },
        ],
      })
    )

    expect(
      r.issues.filter(i => i.path?.startsWith('spec.triggers') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('accepts valid triggers with schedule only', () => {
    const r = validateRecipe(
      makeWorkflow({ triggers: { schedule: { cron: '0 */6 * * *', timezone: 'UTC' } } })
    )
    expect(
      r.issues.filter(i => i.path?.startsWith('spec.triggers') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('accepts triggers with both onDemand and schedule', () => {
    const r = validateRecipe(
      makeWorkflow({
        triggers: {
          onDemand: { requiresApproval: false },
          schedule: { cron: '30 2 * * 1', concurrencyPolicy: 'Forbid' },
        },
      })
    )
    expect(
      r.issues.filter(i => i.path?.startsWith('spec.triggers') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('rejects triggers without onDemand or schedule', () => {
    const r = validateRecipe(makeWorkflow({ triggers: {} }))
    expect(
      r.issues.some(i => i.path === 'spec.triggers' && i.message.includes('at least one'))
    ).toBe(true)
  })

  it('rejects invalid allowedActors value', () => {
    const r = validateRecipe(makeWorkflow({ triggers: { onDemand: { allowedActors: ['admin'] } } }))
    expect(r.issues.some(i => i.path?.includes('allowedActors') && i.severity === 'error')).toBe(
      true
    )
  })

  it('rejects missing schedule.cron', () => {
    const r = validateRecipe(makeWorkflow({ triggers: { schedule: { timezone: 'UTC' } } }))
    expect(
      r.issues.some(i => i.path === 'spec.triggers.schedule.cron' && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects invalid cron expression', () => {
    const r = validateRecipe(makeWorkflow({ triggers: { schedule: { cron: 'every 5 minutes' } } }))
    expect(
      r.issues.some(
        i => i.path === 'spec.triggers.schedule.cron' && i.message.includes('five-field')
      )
    ).toBe(true)
  })

  it('rejects invalid concurrencyPolicy', () => {
    const r = validateRecipe(
      makeWorkflow({ triggers: { schedule: { cron: '0 0 * * *', concurrencyPolicy: 'Queue' } } })
    )
    expect(
      r.issues.some(i => i.path?.includes('concurrencyPolicy') && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects triggers on recipe without steps', () => {
    const r = validateRecipe(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'no-steps' },
        spec: {
          workloads: [{ id: 'w', type: 'deployment', image: 'x' }],
          triggers: { onDemand: {} },
        },
      })
    )
    expect(
      r.issues.some(i => i.path === 'spec.triggers' && i.message.includes('requires spec.steps'))
    ).toBe(true)
  })
})

describe('RunRetention validation', () => {
  it('accepts valid runRetention', () => {
    const r = validateRecipe(
      makeWorkflow({
        runRetention: {
          successfulHistoryLimit: 5,
          failedHistoryLimit: 3,
          ttlSecondsAfterFinished: 3600,
          maxRunDurationSeconds: 7200,
        },
      })
    )
    expect(
      r.issues.filter(i => i.path?.startsWith('spec.runRetention') && i.severity === 'error')
    ).toHaveLength(0)
  })

  it('rejects successfulHistoryLimit > 50', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { successfulHistoryLimit: 100 } }))
    expect(
      r.issues.some(i => i.path?.includes('successfulHistoryLimit') && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects negative failedHistoryLimit', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { failedHistoryLimit: -1 } }))
    expect(
      r.issues.some(i => i.path?.includes('failedHistoryLimit') && i.severity === 'error')
    ).toBe(true)
  })

  it('accepts failedHistoryLimit values allowed by the CRD', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { failedHistoryLimit: 75 } }))
    expect(
      r.issues.some(i => i.path?.includes('failedHistoryLimit') && i.severity === 'error')
    ).toBe(false)
  })

  it('rejects failedHistoryLimit values above the CRD maximum', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { failedHistoryLimit: 101 } }))
    expect(
      r.issues.some(i => i.path?.includes('failedHistoryLimit') && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects negative ttlSecondsAfterFinished', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { ttlSecondsAfterFinished: -1 } }))
    expect(
      r.issues.some(i => i.path?.includes('ttlSecondsAfterFinished') && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects ttlSecondsAfterFinished above the 30 day maximum', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { ttlSecondsAfterFinished: 2_592_001 } }))
    expect(
      r.issues.some(i => i.path?.includes('ttlSecondsAfterFinished') && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects zero maxRunDurationSeconds', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { maxRunDurationSeconds: 0 } }))
    expect(
      r.issues.some(i => i.path?.includes('maxRunDurationSeconds') && i.severity === 'error')
    ).toBe(true)
  })

  it('rejects negative maxRunDurationSeconds', () => {
    const r = validateRecipe(makeWorkflow({ runRetention: { maxRunDurationSeconds: -1 } }))
    expect(
      r.issues.some(i => i.path?.includes('maxRunDurationSeconds') && i.severity === 'error')
    ).toBe(true)
  })
})

// ── contextRef optional when WRC auto-creates wf-<recipeName> ─────────────
describe('contextRef optionality with transport workloads', () => {
  const transportRecipe = (withContextRef: boolean) =>
    JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'my-recipe' },
      spec: {
        workloads: [
          { id: 'mcp-a', type: 'deployment', image: 'mcp:latest', transport: { type: 'http' } },
        ],
        ...(withContextRef ? { contextRef: 'context1' } : {}),
      },
    })

  it('does NOT error when contextRef is omitted but a transport workload exists (auto-context path)', () => {
    const r = validateRecipe(transportRecipe(false))
    const err = r.issues.find(i => i.path === 'spec.contextRef' && i.severity === 'error')
    expect(err).toBeUndefined()
  })

  it('emits an info hint (not an error) when contextRef is omitted with a transport workload', () => {
    const r = validateRecipe(transportRecipe(false))
    const info = r.issues.find(i => i.path === 'spec.contextRef' && i.severity === 'info')
    expect(info).toBeDefined()
    expect(info?.message).toMatch(/auto-create|wf-/i)
  })

  it('does NOT emit the info hint when contextRef is explicitly declared', () => {
    const r = validateRecipe(transportRecipe(true))
    const info = r.issues.find(i => i.path === 'spec.contextRef' && i.severity === 'info')
    expect(info).toBeUndefined()
  })
})

// ── WorkflowRecipe secret reference validation ─────────────────────────────
describe('WorkflowRecipe secret references', () => {
  function secretRecipe(spec: Record<string, unknown>) {
    return JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'secret-ref-recipe' },
      spec: {
        triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
        ...spec,
      },
    })
  }

  it('rejects reserved snippet secret names and invalid secret keys before deploy', () => {
    const r = validateRecipe(
      secretRecipe({
        steps: [
          {
            id: 'run',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                secrets: [
                  {
                    alias: 'config_token',
                    secretRef: { name: 'wf-reserved-runtime-config', key: 'bad/key' },
                  },
                ],
              },
            },
          },
        ],
      })
    )

    expect(r.valid).toBe(false)
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'spec.steps[0].run.capabilities.secrets[0].secretRef.name',
          severity: 'error',
          message: expect.stringContaining('platform-managed'),
        }),
        expect.objectContaining({
          path: 'spec.steps[0].run.capabilities.secrets[0].secretRef.key',
          severity: 'error',
          message: expect.stringContaining('secret key must contain only'),
        }),
      ])
    )
  })

  it('rejects reserved workload envSecret names and invalid secret keys before deploy', () => {
    const r = validateRecipe(
      secretRecipe({
        workloads: [
          {
            id: 'mock-tools',
            type: 'deployment',
            image: 'clerum/mock-mcp-server:test',
            envSecret: {
              name: 'wf-reserved-runtime-config',
              keys: [{ secretKey: 'bad/key', envVar: 'CONFIG_TOKEN' }],
            },
          },
        ],
        steps: [
          {
            id: 'run',
            run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
          },
        ],
      })
    )

    expect(r.valid).toBe(false)
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'spec.workloads[0].envSecret.name',
          severity: 'error',
          message: expect.stringContaining('platform-managed'),
        }),
        expect.objectContaining({
          path: 'spec.workloads[0].envSecret.keys[0].secretKey',
          severity: 'error',
          message: expect.stringContaining('secret key must contain only'),
        }),
      ])
    )
  })
})

// ── Workflow runtime list limits ───────────────────────────────────────────
describe('Workflow runtime list limits', () => {
  it('keeps UI defaults aligned with runtime config defaults', () => {
    expect(WORKFLOW_RECIPE_UI_LIMITS).toEqual({
      maxSteps: 100,
      stepDependsOnMaxItems: 100,
      stepAllowedToolsMaxItems: 50,
      stepMcpServersMaxItems: 20,
    })
  })

  function workflowRecipe(spec: Record<string, unknown>) {
    return JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'limits-recipe' },
      spec: {
        triggers: { onDemand: { allowedActors: ['user'] } },
        ...spec,
      },
    })
  }

  function agenticStep(id: string, overrides: Record<string, unknown> = {}) {
    return { id, instruction: `Run ${id}`, ...overrides }
  }

  it('accepts the 100-step CRD/runtime boundary', () => {
    const r = validateRecipe(
      workflowRecipe({
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: Array.from({ length: 100 }, (_, i) => agenticStep(`s${i}`)),
      })
    )

    expect(r.issues.some(i => i.path === 'spec.steps' && i.severity === 'error')).toBe(false)
  })

  it('rejects more than 100 workflow steps', () => {
    const r = validateRecipe(
      workflowRecipe({
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: Array.from({ length: 101 }, (_, i) => agenticStep(`s${i}`)),
      })
    )

    expect(r.issues).toContainEqual(
      expect.objectContaining({ path: 'spec.steps', severity: 'error' })
    )
  })

  it('accepts step dependency fan-in above 20 up to 100', () => {
    const r = validateRecipe(
      workflowRecipe({
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [
          agenticStep('s0'),
          agenticStep('aggregate', { dependsOn: Array.from({ length: 100 }, () => 's0') }),
        ],
      })
    )

    expect(r.issues.some(i => i.path === 'spec.steps[1].dependsOn' && i.severity === 'error')).toBe(
      false
    )
  })

  it('rejects step dependency fan-in above 100', () => {
    const r = validateRecipe(
      workflowRecipe({
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [
          agenticStep('s0'),
          agenticStep('aggregate', { dependsOn: Array.from({ length: 101 }, () => 's0') }),
        ],
      })
    )

    expect(r.issues).toEqual([
      expect.objectContaining({
        path: 'spec.steps[1].dependsOn',
        message: 'Must contain at most 100 items',
        severity: 'error',
      }),
    ])
  })

  it('keeps step mcpServers capped at 20', () => {
    const r = validateRecipe(
      workflowRecipe({
        agent: { provider: 'zai', model: 'glm-4.7' },
        mcpServers: Array.from({ length: 21 }, (_, i) => ({
          id: `srv${i}`,
          endpoint: `http://srv${i}.test/mcp`,
        })),
        steps: [
          agenticStep('research', {
            mcpServers: Array.from({ length: 21 }, (_, i) => `srv${i}`),
          }),
        ],
      })
    )

    expect(r.issues).toEqual([
      expect.objectContaining({
        path: 'spec.steps[0].mcpServers',
        message: 'Must contain at most 20 items',
        severity: 'error',
      }),
    ])
  })

  it('mirrors the default allowedTools include runtime limit of 50', () => {
    const tools = Array.from({ length: 51 }, (_, i) => `web__tool${i}`)
    const r = validateRecipe(
      workflowRecipe({
        agent: { provider: 'zai', model: 'glm-4.7' },
        mcpServers: [{ id: 'web', endpoint: 'http://web.test/mcp' }],
        steps: [agenticStep('research', { mcpServers: ['web'], allowedTools: { include: tools } })],
      })
    )

    expect(r.issues).toEqual([
      expect.objectContaining({
        path: 'spec.steps[0].allowedTools.include',
        message: 'Must contain at most 50 items',
        severity: 'error',
      }),
    ])
  })
})

// ── Built-in tool prefix whitelist (clerum__*) ─────────────────────────────
describe('Built-in tool prefixes', () => {
  const baseAgenticRecipe = (allowedTools: string[]) =>
    JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'agentic' },
      spec: {
        contextRef: 'context1',
        mcpServers: [{ id: 'web-search' }],
        steps: [
          {
            id: 'summarize',
            instruction: 'Summarize.',
            mcpServers: ['web-search'],
            allowedTools: { include: allowedTools },
          },
        ],
      },
    })

  it('does not warn about clerum__* tools missing from mcpServers', () => {
    const r = validateRecipe(
      baseAgenticRecipe(['clerum__generate_pdf', 'clerum__generate_markdown'])
    )
    const warn = r.issues.find(
      i => i.path?.startsWith('spec.steps[0].allowedTools') && i.severity === 'warning'
    )
    expect(warn).toBeUndefined()
  })

  it('still warns about non-whitelisted prefixes not in mcpServers', () => {
    const r = validateRecipe(baseAgenticRecipe(['mystery__do_thing']))
    const warn = r.issues.find(
      i =>
        i.path === 'spec.steps[0].allowedTools.include[0]' &&
        i.severity === 'warning' &&
        i.message.includes('mystery')
    )
    expect(warn).toBeDefined()
  })
})
