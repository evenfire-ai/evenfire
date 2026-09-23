import { describe, expect, it, vi } from 'vitest'
import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
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
        capabilityFamily: 'promptBridge',
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
      { provider: 'openai', model: 'gpt-5.4-mini', contractVersion: 2 }
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
        capabilityFamily: 'promptBridge',
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

  it('publishes Codex SDK bootstrap as v3 without reading ConfigMaps or Secrets', async () => {
    // The hash is re-derived from the five fields on the way back, so a
    // placeholder digest is not a valid echo — it must be the real one.
    const binding = {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 1,
      model: 'gpt-5.1',
      bindingHash: computeCodexPolicyHash({
        model: 'gpt-5.1',
        catalogRevision: 4,
        credentialRevision: 1,
        connectionKey: 'team-plus',
      }),
    }
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: true,
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          contractVersion: 3,
          policyReady: true,
          policyState: 'active',
          codexBinding: { ...binding, leaked: 'drop-me' },
        },
      })),
    }
    const k8s = reader()
    const handler = new ModelConfigHandler(k8s, mcpHost)
    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'codex-subscription',
      'gpt-5.1',
      'http://mcp-host:8090',
      'wrc-token',
      'promptBridge',
      binding
    )

    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({
      contractVersion: 3,
      provider: 'codex-subscription',
      model: 'gpt-5.1',
      codexBinding: binding,
    })
    expect(result.body.codexBinding).not.toHaveProperty('leaked')
    expect(mcpHost.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledWith(
      'http://mcp-host:8090',
      'wrc-token',
      {
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        contractVersion: 3,
        codexBinding: binding,
      }
    )
    expect(k8s.readConfigMapWithPresence).not.toHaveBeenCalled()
    expect(k8s.readSecret).not.toHaveBeenCalled()
  })

  it('publishes Grok SDK bootstrap as v3 with subscriptionBinding only', async () => {
    const binding = {
      connectionKey: 'team-grok',
      catalogRevision: 5,
      credentialRevision: 2,
      model: 'grok-4.6',
      bindingHash: computeGrokPolicyHash({
        model: 'grok-4.6',
        catalogRevision: 5,
        credentialRevision: 2,
        connectionKey: 'team-grok',
      }),
    }
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: true,
          provider: 'grok-subscription',
          model: 'grok-4.6',
          contractVersion: 3,
          policyReady: true,
          policyState: 'active',
          subscriptionBinding: { ...binding, leaked: 'drop-me' },
        },
      })),
    }
    const k8s = reader()
    const handler = new ModelConfigHandler(k8s, mcpHost)
    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'grok-subscription',
      'grok-4.6',
      'http://mcp-host:8090',
      'wrc-token',
      'promptBridge',
      binding
    )

    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({
      contractVersion: 3,
      provider: 'grok-subscription',
      model: 'grok-4.6',
      subscriptionBinding: binding,
    })
    expect(result.body).not.toHaveProperty('codexBinding')
    expect(result.body.subscriptionBinding).not.toHaveProperty('leaked')
    expect(mcpHost.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledWith(
      'http://mcp-host:8090',
      'wrc-token',
      {
        provider: 'grok-subscription',
        model: 'grok-4.6',
        contractVersion: 3,
        subscriptionBinding: binding,
      }
    )
  })

  it('drops an echoed Codex binding whose hash does not verify', async () => {
    // Shape validation alone would republish this binding to WRC. The hash is
    // the only thing tying the five fields to the policy WRC minted, so an
    // unverifiable digest must not survive the broker.
    const minted = {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 1,
      model: 'gpt-5.1',
      bindingHash: computeCodexPolicyHash({
        model: 'gpt-5.1',
        catalogRevision: 4,
        credentialRevision: 1,
        connectionKey: 'team-plus',
      }),
    }
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: true,
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          contractVersion: 3,
          policyReady: true,
          policyState: 'active',
          // Same shape, tampered revision: the digest no longer matches.
          codexBinding: { ...minted, credentialRevision: 99 },
        },
      })),
    }
    const handler = new ModelConfigHandler(reader(), mcpHost)

    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'codex-subscription',
      'gpt-5.1',
      'http://mcp-host:8090',
      'wrc-token',
      'promptBridge',
      minted
    )

    expect(result.status).toBe(202)
    expect(result.body).not.toHaveProperty('codexBinding')
  })

  it('drops an echoed Codex binding minted for another model', async () => {
    const otherModel = {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 1,
      model: 'gpt-5.3-codex',
      bindingHash: computeCodexPolicyHash({
        model: 'gpt-5.3-codex',
        catalogRevision: 4,
        credentialRevision: 1,
        connectionKey: 'team-plus',
      }),
    }
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: true,
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          contractVersion: 3,
          policyReady: true,
          policyState: 'active',
          codexBinding: otherModel,
        },
      })),
    }
    const handler = new ModelConfigHandler(reader(), mcpHost)

    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'codex-subscription',
      'gpt-5.1',
      'http://mcp-host:8090',
      'wrc-token',
      'promptBridge'
    )

    expect(result.status).toBe(202)
    expect(result.body).not.toHaveProperty('codexBinding')
  })

  it('tags a pre-v3 Codex bootstrap answer as a stale contract, not a generic failure', async () => {
    // A host running an old image answers the v3 Codex bootstrap with a v2
    // identity. WRC needs to tell that apart from a broker outage, otherwise
    // the CR reports "the configured provider is unavailable" for what is
    // really a stale workload image.
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: true,
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          contractVersion: 2,
          policyReady: true,
          policyState: 'active',
        },
      })),
    }
    const handler = new ModelConfigHandler(reader(), mcpHost)

    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'codex-subscription',
      'gpt-5.1',
      'http://mcp-host:8090',
      'wrc-token',
      'promptBridge'
    )

    expect(result.status).toBe(502)
    expect(result.body.policyReason).toBe('codex_bootstrap_contract_stale')
  })

  it('does not tag an unrelated v3 bootstrap rejection as a stale contract', async () => {
    const mcpHost: McpHostClient = {
      configure: vi.fn(async () => ({ status: 500, body: {} })),
      configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
        status: 200,
        body: {
          configured: true,
          ready: false,
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          contractVersion: 3,
        },
      })),
    }
    const handler = new ModelConfigHandler(reader(), mcpHost)

    const result = await handler.configurePluginWorkloadSdkBootstrap(
      'codex-subscription',
      'gpt-5.1',
      'http://mcp-host:8090',
      'wrc-token',
      'promptBridge'
    )

    expect(result.status).toBe(502)
    expect(result.body).not.toHaveProperty('policyReason')
  })

  // B-L14: strict binding slots. mcp-host answers a Grok bootstrap with
  // `subscriptionBinding` only and a Codex bootstrap with `codexBinding` only;
  // the broker republishes nothing from the other provider's slot.
  describe('strict binding slots', () => {
    const fields = { catalogRevision: 5, credentialRevision: 2 }
    const grokSlot = (model: string) => ({
      connectionKey: 'team-key',
      model,
      ...fields,
      bindingHash: computeGrokPolicyHash({ connectionKey: 'team-key', model, ...fields }),
    })
    const codexSlot = (model: string) => ({
      connectionKey: 'team-key',
      model,
      ...fields,
      bindingHash: computeCodexPolicyHash({ connectionKey: 'team-key', model, ...fields }),
    })

    async function publish(provider: string, model: string, echo: Record<string, unknown>) {
      const mcpHost: McpHostClient = {
        configure: vi.fn(async () => ({ status: 500, body: {} })),
        configurePluginWorkloadSdkBootstrap: vi.fn(async () => ({
          status: 200,
          body: {
            configured: true,
            ready: true,
            provider,
            model,
            contractVersion: 3,
            policyReady: true,
            policyState: 'active',
            ...echo,
          },
        })),
      }
      const result = await new ModelConfigHandler(
        reader(),
        mcpHost
      ).configurePluginWorkloadSdkBootstrap(
        provider,
        model,
        'http://mcp-host:8090',
        'wrc-token',
        'promptBridge',
        null
      )
      expect(result.status).toBe(202)
      return result.body
    }

    it('never republishes a codexBinding for a Grok bootstrap', async () => {
      // Mutation caught: verifying `codexBinding` regardless of provider — a
      // Codex digest verifies as a Codex binding and leaked onto a Grok proof.
      const body = await publish('grok-subscription', 'grok-4.6', {
        subscriptionBinding: grokSlot('grok-4.6'),
        codexBinding: codexSlot('grok-4.6'),
      })
      expect(body.subscriptionBinding).toEqual(grokSlot('grok-4.6'))
      expect(body).not.toHaveProperty('codexBinding')
    })

    it('never reads a Grok binding out of the codexBinding slot', async () => {
      // Mutation caught: reading Grok as `subscriptionBinding ?? codexBinding`.
      const body = await publish('grok-subscription', 'grok-4.6', {
        codexBinding: grokSlot('grok-4.6'),
      })
      expect(body).not.toHaveProperty('subscriptionBinding')
      expect(body).not.toHaveProperty('codexBinding')
    })

    it('never republishes a subscriptionBinding for a Codex bootstrap', async () => {
      // Mutation caught: verifying `subscriptionBinding` regardless of provider.
      const body = await publish('codex-subscription', 'gpt-5.1', {
        codexBinding: codexSlot('gpt-5.1'),
        subscriptionBinding: grokSlot('gpt-5.1'),
      })
      expect(body.codexBinding).toEqual(codexSlot('gpt-5.1'))
      expect(body).not.toHaveProperty('subscriptionBinding')
    })

    it('never reads a Codex binding out of the subscriptionBinding slot', async () => {
      // Mutation caught: reading Codex as `codexBinding ?? subscriptionBinding`.
      const body = await publish('codex-subscription', 'gpt-5.1', {
        subscriptionBinding: codexSlot('gpt-5.1'),
      })
      expect(body).not.toHaveProperty('codexBinding')
      expect(body).not.toHaveProperty('subscriptionBinding')
    })

    it('republishes no binding for a static-provider bootstrap', async () => {
      // Mutation caught: slot reads not gated on the provider at all.
      const body = await publish('openai', 'gpt-5.1', {
        codexBinding: codexSlot('gpt-5.1'),
        subscriptionBinding: grokSlot('gpt-5.1'),
        contractVersion: 2,
      })
      expect(body).not.toHaveProperty('codexBinding')
      expect(body).not.toHaveProperty('subscriptionBinding')
    })
  })
})
