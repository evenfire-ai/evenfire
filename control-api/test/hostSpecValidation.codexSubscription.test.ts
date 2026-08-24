import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { validateHostSpec } from '../src/routes/admin/hostSpecValidation.js'

const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')

afterEach(() => {
  delete process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED
})

describe('codex-subscription Host admission', () => {
  it('rejects a Codex target when the management flag is absent or false', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { model: { provider: 'codex-subscription', name: 'gpt-5.1' } },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].message).toMatch(/disabled|not enabled/i)
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('allows a Codex-only Host without secretRef when the flag is on', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { model: { provider: 'codex-subscription', name: 'gpt-5.1' } },
      { isModelAllowed }
    )
    expect(res).toBeNull()
  })

  it('requires secretRef when a Codex Host also has a static fallback', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      {
        model: { provider: 'codex-subscription', name: 'gpt-5.1' },
        llmPolicy: {
          fallbacks: [{ provider: 'openai', model: 'gpt-5.4-mini' }],
        },
      },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].field).toBe('spec.secretRef')
  })

  it('persists an unassigned connectionRef without rematching deployment-default', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(false)
    const spec = {
      model: {
        provider: 'codex-subscription',
        name: 'gpt-5.1',
        connectionRef: 'unassigned',
      },
    }
    const res = await validateHostSpec(spec, { isModelAllowed })
    expect(res).toBeNull()
    expect(isModelAllowed).not.toHaveBeenCalled()
    expect((spec.model as { connectionRef?: string }).connectionRef).toBe('unassigned')
  })

  it('defaults a missing connectionRef to deployment-default and checks that grant', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const spec = { model: { provider: 'codex-subscription', name: 'gpt-5.1' } }
    const res = await validateHostSpec(spec, { isModelAllowed })
    expect(res).toBeNull()
    expect(isModelAllowed).toHaveBeenCalledWith(
      'codex-subscription',
      'gpt-5.1',
      'deployment-default'
    )
    expect((spec.model as { connectionRef?: string }).connectionRef).toBeUndefined()
  })

  it('evaluates allowedModels and fallbacks against the Host connectionRef', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      {
        model: { provider: 'codex-subscription', name: 'gpt-5.1', connectionRef: 'team-plus' },
        allowedModels: [
          { provider: 'codex-subscription', model: 'gpt-5.1' },
          { provider: 'codex-subscription', model: 'gpt-5.3-codex' },
        ],
      },
      { isModelAllowed }
    )
    expect(res).toBeNull()
    expect(isModelAllowed).toHaveBeenCalledWith('codex-subscription', 'gpt-5.1', 'team-plus')
    expect(isModelAllowed).toHaveBeenCalledWith('codex-subscription', 'gpt-5.3-codex', 'team-plus')
  })

  it('does not tolerate switching to a revoked connectionRef with the same model', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn(async (_provider, _model, connectionRef) => {
      return connectionRef === 'personal-pro'
    })
    const tolerations: Array<Record<string, unknown>> = []
    const res = await validateHostSpec(
      {
        model: {
          provider: 'codex-subscription',
          name: 'gpt-5.1',
          connectionRef: 'team-plus',
        },
      },
      { isModelAllowed },
      {
        stored: {
          model: {
            provider: 'codex-subscription',
            name: 'gpt-5.1',
            connectionRef: 'personal-pro',
          },
        },
        hostRef: { namespace: 'mcp-host', name: 'agent-a' },
        tolerations,
      }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].message).toContain('model_not_allowed')
    expect(tolerations).toEqual([])
  })

  it('tolerates an unchanged revoked connectionRef so identity/channels PUTs can persist', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(false)
    const tolerations: Array<Record<string, unknown>> = []
    const spec = {
      channels: ['telegram'],
      model: {
        provider: 'codex-subscription',
        name: 'gpt-5.1',
        connectionRef: 'team-plus',
      },
    }
    const res = await validateHostSpec(
      spec,
      { isModelAllowed },
      {
        stored: {
          model: {
            provider: 'codex-subscription',
            name: 'gpt-5.1',
            connectionRef: 'team-plus',
          },
        },
        hostRef: { namespace: 'mcp-host', name: 'agent-a' },
        tolerations,
      }
    )
    expect(res).toBeNull()
    expect(tolerations).toHaveLength(1)
  })

  it('rejects a revoked or unknown connectionRef when the allowlist says no', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(false)
    const res = await validateHostSpec(
      {
        model: {
          provider: 'codex-subscription',
          name: 'gpt-5.1',
          connectionRef: 'team-plus',
        },
      },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].field).toBe('spec.model.name')
    expect(isModelAllowed).toHaveBeenCalledWith('codex-subscription', 'gpt-5.1', 'team-plus')
  })

  it('rejects credentialSlot on a broker fallback', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      {
        secretRef: 'llm-keys',
        model: { provider: 'codex-subscription', name: 'gpt-5.1' },
        llmPolicy: {
          fallbacks: [
            {
              provider: 'codex-subscription',
              model: 'gpt-5.1',
              credentialSlot: 'openai-api-key',
            },
          ],
        },
      },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].field).toMatch(/credentialSlot/)
    expect(res!.errors[0].message).toMatch(/broker|oauth|credentialSlot/i)
  })
})

describe('codex-subscription CRD contract', () => {
  it('makes secretRef optional and requires it via CEL for any static target', () => {
    const doc = parse(readFileSync(resolve(crdsDir, 'host.yaml'), 'utf8')) as {
      spec: {
        versions: Array<{
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: {
                  required?: string[]
                  'x-kubernetes-validations'?: Array<{ rule: string; message: string }>
                }
              }
            }
          }
        }>
      }
    }
    const spec = doc.spec.versions[0].schema.openAPIV3Schema.properties.spec
    expect(spec.required).not.toContain('secretRef')
    const modelProps = (
      spec as {
        properties?: {
          model?: { properties?: { connectionRef?: { type?: string; pattern?: string } } }
        }
      }
    ).properties?.model?.properties
    expect(modelProps?.connectionRef?.type).toBe('string')
    expect(modelProps?.connectionRef?.pattern).toContain('a-z0-9')
    const rules = spec['x-kubernetes-validations'] ?? []
    expect(
      rules.some(r => r.rule.includes('secretRef') && r.rule.includes('codex-subscription'))
    ).toBe(true)
    expect(rules.some(r => r.rule.includes('credentialSlot'))).toBe(true)
  })

  it('does not expose llm:codex:execute as a user-declarable CRD scope', () => {
    for (const file of ['host.yaml', 'workflowrecipe.yaml']) {
      const text = readFileSync(resolve(crdsDir, file), 'utf8')
      expect(text).not.toMatch(/llm:codex:execute/)
    }
  })
})
