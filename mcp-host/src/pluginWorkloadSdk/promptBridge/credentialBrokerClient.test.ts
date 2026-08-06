import { describe, expect, it, vi } from 'vitest'
import type { PromptBridgeTarget } from '../domain/types'
import { PluginWorkloadSdkCredentialBrokerClient } from './credentialBrokerClient'

const target: PromptBridgeTarget = {
  targetRef: 'primary-openai',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  credentialSlot: 'openai-api-key',
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('PluginWorkloadSdkCredentialBrokerClient', () => {
  it('redeems one exact target ticket using the live runtime token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        provider: target.provider,
        model: target.model,
        credentialSlot: target.credentialSlot,
        credentials: { 'openai-api-key': 'provider-secret' },
        llmSecretName: 'chatllm-api-keys',
      })
    )
    const client = new PluginWorkloadSdkCredentialBrokerClient({
      baseUrl: 'http://wrc:8082/',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-a',
      getAccessToken: () => 'runtime-jwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await client.resolve({
      invocationId: 'inv-1',
      attemptGeneration: 1,
      target,
      credentialTicket: 'signed-ticket',
    })

    expect(result.keys.openai?.['openai-api-key']).toBe('provider-secret')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://wrc:8082/api/v1/workflow/recipe-a/plugin-workload-sdk/credentials')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer runtime-jwt')
    expect(JSON.parse(String(init.body))).toEqual({
      recipeNamespace: 'sandbox-recipes',
      invocationId: 'inv-1',
      attemptGeneration: 1,
      target,
      credentialTicket: 'signed-ticket',
    })
  })

  it.each([403, 503])('collapses broker %s into a terminal non-enumerable error', async status => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(status, { error: 'secret-name-that-must-not-leak' }))
    const client = new PluginWorkloadSdkCredentialBrokerClient({
      baseUrl: 'http://wrc:8082',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-a',
      getAccessToken: () => 'runtime-jwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const error = await client
      .resolve({
        invocationId: 'inv-1',
        attemptGeneration: 1,
        target,
        credentialTicket: 'signed-ticket',
      })
      .catch(caught => caught)
    expect(error).toMatchObject({ code: 'provider_unavailable', retryable: false })
    expect(String(error.message)).not.toContain('secret-name-that-must-not-leak')
  })

  it('rejects a response for a different target and never returns its credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        provider: 'claude',
        model: target.model,
        credentialSlot: target.credentialSlot,
        credentials: { 'claude-api-key': 'wrong-secret' },
        llmSecretName: 'wrong-secret-name',
      })
    )
    const client = new PluginWorkloadSdkCredentialBrokerClient({
      baseUrl: 'http://wrc:8082',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-a',
      getAccessToken: () => 'runtime-jwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(
      client.resolve({
        invocationId: 'inv-1',
        attemptGeneration: 1,
        target,
        credentialTicket: 'signed-ticket',
      })
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: false })
  })
})
