import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import { config } from '../src/config.js'
import {
  PLUGIN_SDK_CREDENTIAL_TICKET_AUDIENCE,
  issuePluginWorkloadSdkCredentialTicket,
  verifyPluginWorkloadSdkCredentialTicket,
} from '../src/services/pluginWorkloadSdkCredentialTicket.js'

describe('plugin workload SDK credential ticket', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('binds one authorized target without exposing any credential value', () => {
    const ticket = issuePluginWorkloadSdkCredentialTicket({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'prompt-notify',
      invocationId: 'invocation-1',
      target: {
        targetRef: 'openai-fallback',
        provider: 'openai',
        model: 'gpt-5.4',
        credentialSlot: 'openai-api-key-fb1',
      },
      policyRevision: 7,
      policyHash: 'policy-hash',
    })
    const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const claims = jwt.verify(ticket, publicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: PLUGIN_SDK_CREDENTIAL_TICKET_AUDIENCE,
    }) as jwt.JwtPayload
    expect(claims).toMatchObject({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'prompt-notify',
      invocationId: 'invocation-1',
      targetRef: 'openai-fallback',
      provider: 'openai',
      model: 'gpt-5.4',
      credentialSlot: 'openai-api-key-fb1',
      policyRevision: 7,
      typ: 'plugin-sdk-credential-ticket',
    })
    expect(typeof claims.jti).toBe('string')
    expect(claims.jti).not.toHaveLength(0)
    expect(JSON.stringify(claims)).not.toContain('secret-value')
  })

  it('expires before a default-duration primary attempt can reach a fallback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
    const ticket = issuePluginWorkloadSdkCredentialTicket({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'prompt-notify',
      invocationId: 'invocation-slow-primary',
      target: {
        targetRef: 'openai-fallback',
        provider: 'openai',
        model: 'gpt-5.4',
        credentialSlot: 'openai-api-key-fb1',
      },
      policyRevision: 7,
      policyHash: 'policy-hash',
    })

    // Fallbacks must request a new JIT ticket. A ticket carried from initial
    // authorization intentionally cannot survive the 120s primary timeout.
    vi.advanceTimersByTime(120_000)
    expect(verifyPluginWorkloadSdkCredentialTicket(ticket)).toBeNull()
  })

  it('reissues a fresh jti without changing the invocation or policy binding', () => {
    const input = {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'prompt-notify',
      invocationId: 'invocation-1',
      target: {
        targetRef: 'openai-fallback',
        provider: 'openai',
        model: 'gpt-5.4',
        credentialSlot: 'openai-api-key-fb1',
      },
      policyRevision: 7,
      policyHash: 'policy-hash',
    }
    const original = verifyPluginWorkloadSdkCredentialTicket(
      issuePluginWorkloadSdkCredentialTicket(input)
    )
    const reissued = verifyPluginWorkloadSdkCredentialTicket(
      issuePluginWorkloadSdkCredentialTicket(input)
    )

    expect(original).not.toBeNull()
    expect(reissued).not.toBeNull()
    expect(reissued).toMatchObject({
      invocationId: original!.invocationId,
      targetRef: original!.targetRef,
      policyRevision: original!.policyRevision,
      policyHash: original!.policyHash,
    })
    expect(reissued!.jti).not.toBe(original!.jti)
  })
})
