import { describe, expect, it } from 'vitest'
import type express from 'express'
import { config } from '../src/config.js'
import {
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
