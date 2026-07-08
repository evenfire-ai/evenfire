import { describe, expect, it } from 'vitest'
import type { WebhookDef, WorkflowRecipeCRD } from '../types'
import { validateWebhooks } from './webhookValidator'

const baseRecipe = (overrides: Partial<WorkflowRecipeCRD['spec']> = {}): WorkflowRecipeCRD => ({
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'r', namespace: 'sandbox-recipes' },
  spec: {
    workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 }],
    ...overrides,
  },
})

const validHmac: WebhookDef = {
  id: 'fireflies',
  workloadRef: 'handler',
  path: '/webhooks/fireflies',
  verification: {
    scheme: 'hmac-sha256-body',
    secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
    signatureHeader: 'X-Hub-Signature-256',
  },
}

describe('validateWebhooks (W2 runtime check)', () => {
  it('accepts a webhook pointing at a deployment with no transport', () => {
    const result = validateWebhooks(baseRecipe(), [validHmac])
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.handlers.fireflies.port).toBe(8080)
      expect(result.handlers.fireflies.path).toBe('/webhooks/fireflies')
      expect(result.handlers.fireflies.podName).toBe('handler')
    }
  })

  it('defaults handler port to 8080 when workload.port is omitted', () => {
    const r = baseRecipe({
      workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1' }],
    })
    const result = validateWebhooks(r, [validHmac])
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.handlers.fireflies.port).toBe(8080)
    }
  })

  it('rejects a webhook whose workloadRef does not match any workload', () => {
    const result = validateWebhooks(baseRecipe(), [{ ...validHmac, workloadRef: 'missing' }])
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') {
      expect(result.conditionType).toBe('WebhookHandlerInvalid')
      expect(result.message).toMatch(/does not match any workloads/)
    }
  })

  it('rejects a webhook whose workload is not type=deployment', () => {
    const r = baseRecipe({
      workloads: [{ id: 'handler', type: 'statefulset', image: 'pg:16', port: 5432 }],
    })
    const result = validateWebhooks(r, [validHmac])
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') {
      expect(result.message).toMatch(/must be type=deployment/)
    }
  })

  it('rejects a webhook whose workload has transport set (MCP server)', () => {
    const r = baseRecipe({
      workloads: [
        {
          id: 'handler',
          type: 'deployment',
          image: 'mcp-server:1',
          port: 3000,
          transport: { type: 'streamableHttp' },
        },
      ],
    })
    const result = validateWebhooks(r, [validHmac])
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') {
      expect(result.message).toMatch(/must not have transport set/)
    }
  })

  it('returns the FIRST failure when multiple webhooks are invalid', () => {
    const r = baseRecipe()
    const wh1: WebhookDef = { ...validHmac, id: 'a', workloadRef: 'missing-x' }
    const wh2: WebhookDef = { ...validHmac, id: 'b', workloadRef: 'missing-y' }
    const result = validateWebhooks(r, [wh1, wh2])
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') {
      // First-encountered failure surfaces. The condition message names webhook
      // 'a', not 'b' — keeps status output deterministic across runs.
      expect(result.message).toContain('webhooks[a]')
    }
  })
})
