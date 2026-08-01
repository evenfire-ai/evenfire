import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import { config } from '../src/config.js'
import {
  PLUGIN_SDK_CREDENTIAL_TICKET_AUDIENCE,
  issuePluginWorkloadSdkCredentialTicket,
} from '../src/services/pluginWorkloadSdkCredentialTicket.js'

describe('plugin workload SDK credential ticket', () => {
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
    expect(JSON.stringify(claims)).not.toContain('secret-value')
  })
})
