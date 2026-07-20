import { describe, expect, it, vi } from 'vitest'
import {
  type K8sSecretReader,
  type McpHostClient,
  ModelConfigHandler,
} from '../../../src/workflow/modelConfigHandler'

/**
 * Provider-fallback (R5 F6) — WRC secret broker transport.
 *
 * The broker resolves each fallback's credential slot and forwards a RESOLVED
 * `llmPolicy` on the mcp-host `configure` leg only. Non-disruption (spec V16):
 * a fallback not in the allowlist, or with an unresolved slot, is skipped.
 */

function mockK8s(
  configMap: Record<string, string>,
  secret: Record<string, string>,
  allowlist: Record<string, string> | null
): K8sSecretReader {
  return {
    readConfigMap: vi.fn(async (_ns: string, name: string) =>
      name === 'clerum-llm-allowed-models' ? allowlist : configMap
    ),
    readConfigMapWithPresence: vi.fn(async () =>
      allowlist === null
        ? ({ exists: false } as const)
        : ({ exists: true, data: allowlist } as const)
    ),
    readSecret: vi.fn(async () => secret),
  }
}

function mockMcpHost(): McpHostClient & { lastBody?: Record<string, unknown> } {
  const host = {
    lastBody: undefined as Record<string, unknown> | undefined,
    configure: vi.fn(async (_endpoint: string, _token: string, body: Record<string, unknown>) => {
      host.lastBody = body
      return { status: 200, body: { configured: true } }
    }),
  }
  return host
}

const CONFIGMAP = {
  openai: 'openai-secret/apiKey',
  claude: 'claude-secret/claude-api-key',
}
const SECRET = {
  apiKey: 'sk-openai',
  'openai-api-key-fb1': 'sk-openai-fb',
  'claude-api-key': 'sk-claude',
}
const ALLOWLIST = {
  openai: JSON.stringify([{ model: 'gpt-primary' }, { model: 'gpt-2' }]),
  claude: JSON.stringify([{ model: 'claude-fb' }]),
}

describe('ModelConfigHandler — provider-fallback transport (R5 F6)', () => {
  it('forwards a resolved cross-provider fallback in llmPolicy', async () => {
    const host = mockMcpHost()
    const handler = new ModelConfigHandler(mockK8s(CONFIGMAP, SECRET, ALLOWLIST), host)

    const result = await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-primary',
        fallbacks: [{ provider: 'claude', model: 'claude-fb' }],
        cooldownSeconds: 120,
        triggerOn: ['rate_limited'],
      },
      'http://mcp:8080',
      'token'
    )

    expect(result.status).toBe(202)
    expect(host.lastBody?.llmPolicy).toEqual({
      cooldownSeconds: 120,
      triggerOn: ['rate_limited'],
      fallbacks: [
        {
          provider: 'claude',
          model: 'claude-fb',
          apiKey: 'sk-claude',
          llmSecretName: 'claude-secret',
        },
      ],
    })
    // Never leaks the credential back to the coordinator.
    expect(JSON.stringify(result.body)).not.toContain('sk-claude')
  })

  it('resolves a same-provider fallback via its credential slot', async () => {
    const host = mockMcpHost()
    const handler = new ModelConfigHandler(mockK8s(CONFIGMAP, SECRET, ALLOWLIST), host)

    await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-primary',
        fallbacks: [{ provider: 'openai', model: 'gpt-2', credentialSlot: 'openai-api-key-fb1' }],
      },
      'http://mcp:8080',
      'token'
    )

    expect(host.lastBody?.llmPolicy).toEqual({
      fallbacks: [
        {
          provider: 'openai',
          model: 'gpt-2',
          apiKey: 'sk-openai-fb', // the slot key, not the default apiKey
          llmSecretName: 'openai-secret',
        },
      ],
    })
  })

  it('skips a fallback whose model is not in the allowlist (non-disruption)', async () => {
    const host = mockMcpHost()
    const handler = new ModelConfigHandler(mockK8s(CONFIGMAP, SECRET, ALLOWLIST), host)

    await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-primary',
        fallbacks: [{ provider: 'claude', model: 'claude-not-allowed' }],
      },
      'http://mcp:8080',
      'token'
    )

    // No usable fallback → no llmPolicy forwarded.
    expect(host.lastBody?.llmPolicy).toBeUndefined()
  })

  it('drops all fallbacks in degraded mode (allowlist ConfigMap absent)', async () => {
    const host = mockMcpHost()
    const handler = new ModelConfigHandler(mockK8s(CONFIGMAP, SECRET, null), host)

    await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-primary',
        fallbacks: [{ provider: 'claude', model: 'claude-fb' }],
      },
      'http://mcp:8080',
      'token'
    )

    expect(host.lastBody?.llmPolicy).toBeUndefined()
  })

  it('sends no llmPolicy when no fallbacks are provided (byte-identical to before)', async () => {
    const host = mockMcpHost()
    const handler = new ModelConfigHandler(mockK8s(CONFIGMAP, SECRET, ALLOWLIST), host)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-primary' },
      'http://mcp:8080',
      'token'
    )

    expect(host.lastBody).toBeDefined()
    expect(host.lastBody?.llmPolicy).toBeUndefined()
    expect(host.lastBody?.provider).toBe('openai')
  })
})
