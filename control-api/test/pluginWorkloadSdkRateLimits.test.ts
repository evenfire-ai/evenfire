import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { requireMcpHostJwt } from '../src/middleware/mcpHostJwtAuth.js'
import {
  createPluginWorkloadSdkAnonymousPreauthRateLimit,
  createPluginWorkloadSdkAuthenticatedPreauthRateLimit,
  pluginWorkloadSdkCredentialBucketKey,
  pluginWorkloadSdkRequestBucketKey,
} from '../src/middleware/pluginWorkloadSdkRateLimits.js'
import {
  issueMcpHostAccessJwt,
  mcpHostRateLimitBucketKey,
  verifyMcpHostAccessJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'

function reqForToken(token: string) {
  return {
    mcpHostJwt: verifyMcpHostAccessJwt(token) ?? undefined,
  } as express.Request
}

describe('pluginWorkloadSdkRateLimits standalone isolation', () => {
  it('isolates standalone hosts that share the sentinel recipeName', () => {
    const chatllm = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['chatllm'], {
      workflowControlScopes: ['plugin-workload-sdk'],
    }).token
    const trader = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['trader'], {
      workflowControlScopes: ['plugin-workload-sdk'],
    }).token
    const recipe = issueMcpHostAccessJwt('sandbox-recipes', 'research-host', ['research-host'], {
      workflowControlScopes: ['plugin-workload-sdk'],
    }).token

    expect(pluginWorkloadSdkRequestBucketKey(reqForToken(chatllm))).toBe(
      `plugin_workload_sdk_request:${config.hostsNamespace}/host/chatllm`
    )
    expect(pluginWorkloadSdkRequestBucketKey(reqForToken(trader))).toBe(
      `plugin_workload_sdk_request:${config.hostsNamespace}/host/trader`
    )
    expect(pluginWorkloadSdkRequestBucketKey(reqForToken(chatllm))).not.toBe(
      pluginWorkloadSdkRequestBucketKey(reqForToken(trader))
    )
    expect(pluginWorkloadSdkRequestBucketKey(reqForToken(recipe))).toBe(
      'plugin_workload_sdk_request:sandbox-recipes/research-host'
    )
    expect(pluginWorkloadSdkRequestBucketKey({} as express.Request)).toBe(
      'plugin_workload_sdk_request:unauthenticated'
    )

    expect(pluginWorkloadSdkCredentialBucketKey(reqForToken(chatllm))).toBe(
      `plugin_workload_sdk_credential:${config.hostsNamespace}/host/chatllm`
    )
    expect(pluginWorkloadSdkCredentialBucketKey(reqForToken(trader))).toBe(
      `plugin_workload_sdk_credential:${config.hostsNamespace}/host/trader`
    )
    expect(pluginWorkloadSdkCredentialBucketKey({} as express.Request)).toBeNull()

    expect(mcpHostRateLimitBucketKey('recipe', verifyMcpHostAccessJwt(chatllm))).toBe(
      `recipe:${config.hostsNamespace}/host/chatllm`
    )
    expect(mcpHostRateLimitBucketKey('recipe', verifyMcpHostAccessJwt(trader))).toBe(
      `recipe:${config.hostsNamespace}/host/trader`
    )
    expect(mcpHostRateLimitBucketKey('recipe', verifyMcpHostAccessJwt(recipe))).toBe(
      'recipe:sandbox-recipes/research-host'
    )
  })
})

describe('authenticated SDK pre-auth calendar recovery', () => {
  const originalAuthenticated = config.pluginSdkAuthenticatedPreauthRlPerMin
  const originalAnonymous = config.pluginSdkPreauthRlPerMin

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T12:00:17.500Z'))
    config.pluginSdkAuthenticatedPreauthRlPerMin = 2
    config.pluginSdkPreauthRlPerMin = 2
  })

  afterEach(() => {
    config.pluginSdkAuthenticatedPreauthRlPerMin = originalAuthenticated
    config.pluginSdkPreauthRlPerMin = originalAnonymous
    vi.useRealTimers()
  })

  function app() {
    const instance = express()
    instance.use(createPluginWorkloadSdkAnonymousPreauthRateLimit())
    instance.use(createPluginWorkloadSdkAuthenticatedPreauthRateLimit())
    instance.get('/sdk-gate', requireMcpHostJwt, (_req, res) => res.json({ ok: true }))
    return instance
  }

  function signedCaller() {
    return issueMcpHostAccessJwt('sandbox-recipes', 'calendar-sdk', undefined, {
      workflowControlScopes: ['plugin-workload-sdk'],
    }).token
  }

  it('allows the verified caller at the PG calendar boundary instead of waiting until its first-hit deadline', async () => {
    const instance = app()
    const authorization = `Bearer ${signedCaller()}`
    await request(instance).get('/sdk-gate').set('Authorization', authorization).expect(200)
    await request(instance).get('/sdk-gate').set('Authorization', authorization).expect(200)
    const denied = await request(instance).get('/sdk-gate').set('Authorization', authorization)
    expect(denied.status).toBe(429)
    expect(denied.headers['retry-after']).toBe('43')
    vi.setSystemTime(new Date('2026-10-02T12:01:00.000Z'))
    await request(instance).get('/sdk-gate').set('Authorization', authorization).expect(200)
  })

  it('retains anonymous first-hit denial across that boundary without consuming the verified caller allowance', async () => {
    const instance = app()
    await request(instance).get('/sdk-gate').expect(401)
    await request(instance).get('/sdk-gate').expect(401)
    await request(instance).get('/sdk-gate').expect(429)
    const authorization = `Bearer ${signedCaller()}`
    await request(instance).get('/sdk-gate').set('Authorization', authorization).expect(200)
    vi.setSystemTime(new Date('2026-10-02T12:01:00.000Z'))
    await request(instance).get('/sdk-gate').expect(429)
    await request(instance).get('/sdk-gate').set('Authorization', authorization).expect(200)
  })
})
