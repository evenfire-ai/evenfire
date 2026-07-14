import { describe, expect, it, vi } from 'vitest'
import { SignJWT, exportSPKI, generateKeyPair } from 'jose'

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

async function freshAuthModule() {
  vi.resetModules()
  return import('../../../src/workflow/workflowAuth')
}

async function createSigningPair(): Promise<{ privateKey: SigningKey; publicKeyPem: string }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  return { privateKey, publicKeyPem: await exportSPKI(publicKey) }
}

async function signWorkflowToken(
  privateKey: SigningKey,
  issuer: string,
  audience = 'clerum-wrc'
): Promise<string> {
  return new SignJWT({
    recipeName: 'recipe-one',
    recipeNamespace: 'sandbox-recipes',
    scopes: ['workflow:read'],
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('coordinator')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

describe('workflow auth token verification', () => {
  it('rejects a token with the wrong audience', async () => {
    const auth = await freshAuthModule()
    const wrcKey = await createSigningPair()

    await auth.initializePublicKey(wrcKey.publicKeyPem)

    const token = await signWorkflowToken(wrcKey.privateKey, auth.WRC_ISSUER, 'mcp-host')

    await expect(auth.verifyIncomingToken(token)).rejects.toThrow(/aud/i)
  })

  it('rejects a control-api token signed with the WRC key', async () => {
    const auth = await freshAuthModule()
    const wrcKey = await createSigningPair()
    const controlApiKey = await createSigningPair()

    await auth.initializePublicKey(wrcKey.publicKeyPem)
    await auth.initializeControlApiPublicKey(controlApiKey.publicKeyPem)

    const token = await signWorkflowToken(wrcKey.privateKey, auth.CONTROL_API_ISSUER)

    await expect(auth.verifyIncomingToken(token)).rejects.toThrow(/signature/i)
  })

  it('rejects an unknown issuer before key verification', async () => {
    const auth = await freshAuthModule()
    const key = await createSigningPair()
    const token = await signWorkflowToken(key.privateKey, 'unknown-service')

    await expect(auth.verifyIncomingToken(token)).rejects.toThrow(
      'Unknown token issuer: unknown-service'
    )
  })

  it('rejects a WRC token before the WRC public key is initialized', async () => {
    const auth = await freshAuthModule()
    const wrcKey = await createSigningPair()
    const token = await signWorkflowToken(wrcKey.privateKey, auth.WRC_ISSUER)

    await expect(auth.verifyIncomingToken(token)).rejects.toThrow(
      "Public key for issuer 'clerum-wrc' not initialized"
    )
  })

  it('rejects a control-api token before the control-api public key is initialized', async () => {
    const auth = await freshAuthModule()
    const controlApiKey = await createSigningPair()
    const token = await signWorkflowToken(controlApiKey.privateKey, auth.CONTROL_API_ISSUER)

    await expect(auth.verifyIncomingToken(token)).rejects.toThrow(
      "Public key for issuer 'control-api' not initialized"
    )
  })
})
