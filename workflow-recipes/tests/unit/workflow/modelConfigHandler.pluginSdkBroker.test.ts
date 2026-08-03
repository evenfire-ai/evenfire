import { describe, expect, it, vi } from 'vitest'
import {
  type K8sSecretReader,
  type McpHostClient,
  ModelConfigHandler,
} from '../../../src/workflow/modelConfigHandler'

function reader(
  overrides: {
    allowlist?: Record<string, string> | null
    mappings?: Record<string, string> | null
    secret?: Record<string, string> | null
  } = {}
): K8sSecretReader {
  const allowlist =
    overrides.allowlist === undefined
      ? { openai: JSON.stringify([{ model: 'gpt-5.4-mini' }]) }
      : overrides.allowlist
  return {
    readConfigMapWithPresence: vi.fn(async () =>
      allowlist === null
        ? ({ exists: false } as const)
        : ({ exists: true, data: allowlist } as const)
    ),
    readConfigMap: vi.fn(async () =>
      overrides.mappings === undefined
        ? { openai: 'chatllm-api-keys/openai-api-key' }
        : overrides.mappings
    ),
    readSecret: vi.fn(async () =>
      overrides.secret === undefined
        ? { 'openai-api-key': 'primary-secret', 'openai-api-key-blue': 'blue-secret' }
        : overrides.secret
    ),
  }
}

const unusedMcpHost: McpHostClient = {
  configure: vi.fn(async () => ({ status: 500, body: {} })),
}

describe('ModelConfigHandler Plugin SDK per-attempt credential broker', () => {
  it('returns only the selected slot remapped to the provider canonical key', async () => {
    const handler = new ModelConfigHandler(reader(), unusedMcpHost)
    const result = await handler.resolvePluginSdkCredential({
      targetRef: 'openai-blue',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      credentialSlot: 'openai-api-key-blue',
    })

    expect(result).toEqual({
      status: 200,
      body: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        credentialSlot: 'openai-api-key-blue',
        credentials: { 'openai-api-key': 'blue-secret' },
        llmSecretName: 'chatllm-api-keys',
      },
    })
    expect(JSON.stringify(result.body)).not.toContain('primary-secret')
  })

  it('fails closed before Secret lookup when the global allowlist is absent', async () => {
    const k8s = reader({ allowlist: null })
    const handler = new ModelConfigHandler(k8s, unusedMcpHost)
    const result = await handler.resolvePluginSdkCredential({
      targetRef: 'primary-openai',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      credentialSlot: 'openai-api-key',
    })
    expect(result.status).toBe(503)
    expect(k8s.readSecret).not.toHaveBeenCalled()
  })

  it('fails terminally without slot discovery when the signed slot is missing', async () => {
    const handler = new ModelConfigHandler(reader({ secret: {} }), unusedMcpHost)
    const result = await handler.resolvePluginSdkCredential({
      targetRef: 'openai-blue',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      credentialSlot: 'openai-api-key-blue',
    })
    expect(result).toEqual({
      status: 503,
      body: { error: 'Provider configuration unavailable' },
    })
    expect(JSON.stringify(result.body)).not.toContain('openai-api-key-blue')
  })

  it('rejects a slot owned by a different provider before any K8s lookup', async () => {
    const k8s = reader()
    const handler = new ModelConfigHandler(k8s, unusedMcpHost)
    const result = await handler.resolvePluginSdkCredential({
      targetRef: 'bad-slot',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      credentialSlot: 'claude-api-key',
    })
    expect(result.status).toBe(400)
    expect(k8s.readConfigMapWithPresence).not.toHaveBeenCalled()
  })

  it('publishes SDK bootstrap identity without reading ConfigMaps or Secrets', async () => {
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: true,
          provider: 'openai',
          model: 'gpt-5.4-mini',
          contractVersion: 2,
          policyRevision: 1,
          policyHash: 'a'.repeat(64),
          defaultTargetRef: 'primary-openai',
          defaultProvider: 'openai',
          defaultModel: 'gpt-5.4-mini',
        },
      })),
    }
    const k8s = reader()
    const handler = new ModelConfigHandler(k8s, mcpHost)
    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'openai',
      'gpt-5.4-mini',
      'http://mcp-host:8090',
      'wrc-token'
    )

    expect(result).toEqual({
      status: 202,
      body: {
        configured: true,
        ready: true,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        contractVersion: 2,
        policyRevision: 1,
        policyHash: 'a'.repeat(64),
        defaultTargetRef: 'primary-openai',
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.4-mini',
      },
    })
    expect(mcpHost.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledWith(
      'http://mcp-host:8090',
      'wrc-token',
      { provider: 'openai', model: 'gpt-5.4-mini' }
    )
    expect(k8s.readConfigMapWithPresence).not.toHaveBeenCalled()
    expect(k8s.readSecret).not.toHaveBeenCalled()
  })

  it('publishes identity readiness while an operator prompt grant is still missing', async () => {
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: true,
          provider: 'openai',
          model: 'gpt-5.4-mini',
          contractVersion: 2,
          policyReady: false,
          policyState: 'missing',
          policyReason: 'grant_missing',
        },
      })),
    }
    const k8s = reader()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'openai',
      'gpt-5.4-mini',
      'http://mcp-host:8090',
      'wrc-token'
    )

    expect(result).toEqual({
      status: 202,
      body: {
        configured: true,
        ready: true,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        contractVersion: 2,
        policyReady: false,
        policyState: 'missing',
        policyReason: 'grant_missing',
      },
    })
    expect(k8s.readConfigMapWithPresence).not.toHaveBeenCalled()
    expect(k8s.readSecret).not.toHaveBeenCalled()
  })
})
