import { describe, expect, it } from 'vitest'
import {
  checkLiveRuntimeBinding,
  shouldStartPluginWorkloadSdk,
  validatePluginWorkloadSdkCredentialBrokerUrl,
} from './sdkServer'

/**
 * Triple activation gate (plan §6.3): 2^3 combinations — only
 * flag=true + recipeNamespace=sandbox-recipes + podNamespace=sandbox-recipes
 * starts the server. Everything else fails CLOSED.
 */

function makeRuntimeToken(recipeNamespace: string | null): string {
  const payload: Record<string, unknown> = {
    sub: 'x',
    hostRefs: ['sandbox-recipes/r1'],
    recipeName: 'r1',
  }
  if (recipeNamespace !== null) payload.recipeNamespace = recipeNamespace
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `eyJhbGciOiJSUzI1NiJ9.${body}.signature`
}

const SANDBOX_TOKEN = makeRuntimeToken('sandbox-recipes')
const HOST_NS_TOKEN = makeRuntimeToken('mcp-host')
const UNBOUND_TOKEN = makeRuntimeToken(null)
const BROKER_URL = 'http://workflow-recipes:8082'

describe('shouldStartPluginWorkloadSdk — behavior matrix', () => {
  const cases: Array<{
    name: string
    enabled: boolean
    token: string
    podNamespace: string
    start: boolean
  }> = [
    {
      name: 'flag off / any / any',
      enabled: false,
      token: SANDBOX_TOKEN,
      podNamespace: 'sandbox-recipes',
      start: false,
    },
    {
      name: 'flag off / wrong ns / wrong pod',
      enabled: false,
      token: HOST_NS_TOKEN,
      podNamespace: 'mcp-host',
      start: false,
    },
    {
      name: 'flag on / unbound token (chat host)',
      enabled: true,
      token: UNBOUND_TOKEN,
      podNamespace: 'sandbox-recipes',
      start: false,
    },
    {
      name: 'flag on / empty token',
      enabled: true,
      token: '',
      podNamespace: 'sandbox-recipes',
      start: false,
    },
    {
      name: 'flag on / mcp-host ns / mcp-host pod',
      enabled: true,
      token: HOST_NS_TOKEN,
      podNamespace: 'mcp-host',
      start: false,
    },
    {
      name: 'flag on / sandbox claim / mcp-host pod (mismatch)',
      enabled: true,
      token: SANDBOX_TOKEN,
      podNamespace: 'mcp-host',
      start: false,
    },
    {
      name: 'flag on / mcp-host claim / sandbox pod (mismatch)',
      enabled: true,
      token: HOST_NS_TOKEN,
      podNamespace: 'sandbox-recipes',
      start: false,
    },
    {
      name: 'flag on / sandbox claim / empty downward API (fail closed)',
      enabled: true,
      token: SANDBOX_TOKEN,
      podNamespace: '',
      start: false,
    },
    {
      name: 'flag on / sandbox claim / whitespace downward API',
      enabled: true,
      token: SANDBOX_TOKEN,
      podNamespace: '   ',
      start: false,
    },
    {
      name: 'ALL THREE satisfied',
      enabled: true,
      token: SANDBOX_TOKEN,
      podNamespace: 'sandbox-recipes',
      start: true,
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const result = shouldStartPluginWorkloadSdk({
        pluginWorkloadSdkEnabled: c.enabled,
        mcpHostRuntimeAccessToken: c.token,
        podNamespace: c.podNamespace,
        pluginWorkloadSdkCredentialBrokerUrl: c.enabled ? BROKER_URL : '',
      })
      expect(result.start).toBe(c.start)
      expect(result.reason).toBeTruthy()
    })
  }

  it('explains the failing condition in the reason', () => {
    expect(
      shouldStartPluginWorkloadSdk({
        pluginWorkloadSdkEnabled: false,
        mcpHostRuntimeAccessToken: SANDBOX_TOKEN,
        podNamespace: 'sandbox-recipes',
        pluginWorkloadSdkCredentialBrokerUrl: '',
      }).reason
    ).toContain('PLUGIN_WORKLOAD_SDK_ENABLED')
    expect(
      shouldStartPluginWorkloadSdk({
        pluginWorkloadSdkEnabled: true,
        mcpHostRuntimeAccessToken: HOST_NS_TOKEN,
        podNamespace: 'sandbox-recipes',
        pluginWorkloadSdkCredentialBrokerUrl: BROKER_URL,
      }).reason
    ).toContain("recipeNamespace is 'mcp-host'")
    expect(
      shouldStartPluginWorkloadSdk({
        pluginWorkloadSdkEnabled: true,
        mcpHostRuntimeAccessToken: SANDBOX_TOKEN,
        podNamespace: '',
        pluginWorkloadSdkCredentialBrokerUrl: BROKER_URL,
      }).reason
    ).toContain('(empty)')
  })
})

describe('validatePluginWorkloadSdkCredentialBrokerUrl', () => {
  it.each(['', '   ', 'workflow-recipes:8082', 'ftp://workflow-recipes:8082'])(
    'rejects %j',
    value => {
      expect(validatePluginWorkloadSdkCredentialBrokerUrl(value)).toBeTruthy()
    }
  )

  it('accepts an internal service base URL and rejects URL authority/path injection', () => {
    expect(validatePluginWorkloadSdkCredentialBrokerUrl('http://workflow-recipes:8082')).toBeNull()
    expect(validatePluginWorkloadSdkCredentialBrokerUrl('https://wrc.example.test')).toBeNull()
    expect(
      validatePluginWorkloadSdkCredentialBrokerUrl('http://user:pass@workflow-recipes:8082')
    ).toBeTruthy()
    expect(
      validatePluginWorkloadSdkCredentialBrokerUrl('http://workflow-recipes:8082/api')
    ).toBeTruthy()
  })
})

describe('checkLiveRuntimeBinding — per-request token re-validation', () => {
  const boundBinding = {
    hostRef: 'sandbox-recipes/r1',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'r1',
  }

  it('accepts a live binding matching the boot binding', () => {
    expect(checkLiveRuntimeBinding(boundBinding, 'r1')).toBeNull()
  })

  it('rejects when the live token has no decodable binding', () => {
    expect(checkLiveRuntimeBinding(null, 'r1')).toContain('no decodable')
  })

  it('rejects when the refreshed token namespace drifted', () => {
    expect(
      checkLiveRuntimeBinding({ ...boundBinding, recipeNamespace: 'mcp-host' }, 'r1')
    ).toContain("drifted to 'mcp-host'")
  })

  it('rejects when the refreshed token recipe name drifted', () => {
    expect(checkLiveRuntimeBinding({ ...boundBinding, recipeName: 'other' }, 'r1')).toContain(
      "drifted to 'other'"
    )
  })
})
