import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import {
  LlmProviderAttemptAuthorizeError,
  type LlmProviderAttemptAuthorizerDeps,
  authorizeLlmProviderAttempt,
} from '../src/services/llmProviderAttemptAuthorizer.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'

// B-L6: a deeply nested authorize body must fail closed as invalid_request
// before the authorizer serializes it. Without the guard, JSON.stringify throws
// a RangeError that the route maps to a 500.

const PROVIDERS = [
  {
    provider: 'codex-subscription',
    schemaVersion: 'codex-completion-request.v1',
    model: 'gpt-5.1',
    scope: 'llm:codex:execute',
  },
  {
    provider: 'grok-subscription',
    schemaVersion: 'grok-completion-request.v1',
    model: 'grok-4.6',
    scope: 'llm:grok:execute',
  },
] as const

type ProviderCase = (typeof PROVIDERS)[number]

function claims(scope: string): McpHostAccessClaims {
  return {
    sub: 'default/research-host',
    recipeNamespace: 'default',
    recipeName: 'research-host',
    hostRefs: ['research-host'],
    scope: 'workflow:approval:request',
    workflowControlScopes: [scope],
    iss: 'control-api',
    aud: 'workflow-approvals',
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 60,
  }
}

/** Parses JSON text the way express.json does, so the body is a plain tree. */
function wireBody(p: ProviderCase, parametersJson: string, extra = ''): Record<string, unknown> {
  const request =
    `{"schemaVersion":"${p.schemaVersion}","requestId":"req-1","idempotencyKey":"idem-1",` +
    `"provider":"${p.provider}","model":"${p.model}","messages":[{"role":"user","content":"hi"}],` +
    `"tools":[{"name":"t","description":"d","parameters":${parametersJson}}]}`
  return JSON.parse(
    `{"request":${request},"invocationId":"inv-1","attemptGeneration":1,` +
      `"policyRevision":1,"policyHash":"${'a'.repeat(64)}"${extra}}`
  ) as Record<string, unknown>
}

function nestedArrays(depth: number): string {
  return `{"x":${'['.repeat(depth)}${']'.repeat(depth)}}`
}

function nestedObjects(depth: number): string {
  return `${'{"n":'.repeat(depth - 1)}{}${'}'.repeat(depth - 1)}`
}

const GUARD_PASSED = new Error('guard passed: assignment lookup reached')

function deps(): Partial<LlmProviderAttemptAuthorizerDeps> {
  return {
    enabled: true,
    resolveAssignment: vi.fn().mockRejectedValue(GUARD_PASSED),
  }
}

describe('authorizeLlmProviderAttempt nesting depth guard', () => {
  const previousGrokFlag = config.grokSubscriptionEnabled

  beforeEach(() => {
    config.grokSubscriptionEnabled = true
  })

  afterEach(() => {
    config.grokSubscriptionEnabled = previousGrokFlag
  })

  for (const p of PROVIDERS) {
    for (const depth of [5000, 150000]) {
      it(`rejects a ${depth}-deep ${p.provider} request with invalid_request, not a RangeError`, async () => {
        const body = wireBody(p, nestedArrays(depth))
        // Proves the fixture really is deep enough to overflow serialization.
        if (depth === 150000) expect(() => JSON.stringify(body)).toThrow(RangeError)
        const current = deps()
        const attempt = authorizeLlmProviderAttempt(claims(p.scope), body, current)
        await expect(attempt).rejects.toBeInstanceOf(LlmProviderAttemptAuthorizeError)
        await expect(attempt).rejects.toMatchObject({ code: 'invalid_request' })
        await expect(attempt).rejects.toThrow(/nesting depth/)
        expect(current.resolveAssignment).not.toHaveBeenCalled()
      })
    }

    it(`rejects deep nesting under an unknown ${p.provider} body key before serializing`, async () => {
      const body = wireBody(p, '{"type":"object"}', `,"extra":${nestedArrays(150000)}`)
      const current = deps()
      const attempt = authorizeLlmProviderAttempt(claims(p.scope), body, current)
      await expect(attempt).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(attempt).rejects.toThrow(/nesting depth/)
    })

    it(`lets a ${p.provider} request with 64-deep tool parameters past the guard`, async () => {
      const body = wireBody(p, nestedObjects(64))
      const current = deps()
      await expect(authorizeLlmProviderAttempt(claims(p.scope), body, current)).rejects.toBe(
        GUARD_PASSED
      )
      expect(current.resolveAssignment).toHaveBeenCalledTimes(1)
    })

    it(`lets a ${p.provider} request with 64-deep assistant tool-call arguments past the guard`, async () => {
      // The deepest accepted tree: body > request > messages[] > message >
      // toolCalls[] > call > arguments, then 64 levels inside arguments.
      const body = wireBody(p, '{"type":"object"}')
      const request = body.request as Record<string, unknown>
      request.messages = JSON.parse(
        `[{"role":"assistant","content":"","toolCalls":[{"id":"c1","name":"t","arguments":${nestedObjects(64)}}]}]`
      )
      const current = deps()
      await expect(authorizeLlmProviderAttempt(claims(p.scope), body, current)).rejects.toBe(
        GUARD_PASSED
      )
    })

    it(`still applies the contract cap to 65-deep ${p.provider} tool parameters`, async () => {
      const body = wireBody(p, nestedObjects(65))
      const current = deps()
      const attempt = authorizeLlmProviderAttempt(claims(p.scope), body, current)
      await expect(attempt).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(attempt).rejects.toThrow(/nesting depth/)
      expect(current.resolveAssignment).not.toHaveBeenCalled()
    })
  }
})
