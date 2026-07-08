import { generateKeyPairSync } from 'node:crypto'
import { SignJWT, importPKCS8 } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { HttpError } from '../errors'
import {
  JwtVerifier,
  WFC_FILE_READ_SCOPE,
  WFC_FILE_SCOPES,
  WFC_FILE_WRITE_SCOPE,
} from '../auth/jwtVerifier'

let publicKeyPem: string
let privatePem: string

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
})

async function mintToken(opts: {
  issuer?: string
  audience?: string
  sharedFileSystem?: string
  sharedFileSystemNamespace?: string | null
  scopes?: unknown[] | null
  expiresIn?: string
}): Promise<string> {
  const key = await importPKCS8(privatePem, 'RS256')
  const payload: Record<string, unknown> = {}
  if (opts.sharedFileSystem !== undefined) payload.sharedFileSystem = opts.sharedFileSystem
  if (opts.sharedFileSystemNamespace !== null) {
    payload.sharedFileSystemNamespace = opts.sharedFileSystemNamespace ?? 'mcp-host'
  }
  if (opts.scopes !== null) {
    payload.scopes = opts.scopes ?? [WFC_FILE_READ_SCOPE, WFC_FILE_WRITE_SCOPE]
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts.issuer ?? 'control-api')
    .setAudience(opts.audience ?? 'workspace-files-controller')
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(key)
}

function makeVerifier(overrides?: Partial<ConstructorParameters<typeof JwtVerifier>[0]>) {
  return new JwtVerifier({
    publicKeyPem,
    issuer: 'control-api',
    audience: 'workspace-files-controller',
    expectedSharedFileSystem: 'team-mission',
    expectedSharedFileSystemNamespace: 'mcp-host',
    ...overrides,
  })
}

describe('wfc file scope wire contract', () => {
  // Cross-service contract with control-api's wfcBrowsingToken (WFC_BROWSING_*).
  // If either side changes these literals, browsing tokens are rejected at
  // runtime by the scope checks. Keep both lists in sync.
  it('pins the scope literals shared with control-api', () => {
    expect(WFC_FILE_READ_SCOPE).toBe('files:read')
    expect(WFC_FILE_WRITE_SCOPE).toBe('files:write')
    expect(WFC_FILE_SCOPES).toEqual(['files:read', 'files:write'])
  })
})

describe('JwtVerifier', () => {
  it('accepts a well-formed token whose sharedFileSystem matches', async () => {
    const verifier = makeVerifier()
    const token = await mintToken({ sharedFileSystem: 'team-mission' })
    const payload = await verifier.verifyBearer(`Bearer ${token}`)
    expect(payload.sharedFileSystem).toBe('team-mission')
    expect(payload.sharedFileSystemNamespace).toBe('mcp-host')
    expect(payload.scopes).toEqual([WFC_FILE_READ_SCOPE, WFC_FILE_WRITE_SCOPE])
    expect(payload.sub).toBe('user-1')
  })

  it('rejects a missing Authorization header', async () => {
    const verifier = makeVerifier()
    await expect(verifier.verifyBearer(undefined)).rejects.toBeInstanceOf(HttpError)
    await expect(verifier.verifyBearer('')).rejects.toBeInstanceOf(HttpError)
  })

  it('rejects a non-Bearer scheme', async () => {
    const verifier = makeVerifier()
    await expect(verifier.verifyBearer('Basic abcdef')).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('rejects an expired token (401 unauthorized)', async () => {
    const verifier = makeVerifier()
    const token = await mintToken({ sharedFileSystem: 'team-mission', expiresIn: '0s' })
    await new Promise(r => setTimeout(r, 50))
    await expect(verifier.verifyBearer(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('rejects a wrong-audience token (403 forbidden — token signed by trusted issuer but for someone else)', async () => {
    const verifier = makeVerifier()
    const token = await mintToken({ sharedFileSystem: 'team-mission', audience: 'profile-ui' })
    await expect(verifier.verifyBearer(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects a wrong-issuer token (403)', async () => {
    const verifier = makeVerifier()
    const token = await mintToken({ sharedFileSystem: 'team-mission', issuer: 'someone-else' })
    await expect(verifier.verifyBearer(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects a token whose sharedFileSystem claim does not match this wfc (403)', async () => {
    const verifier = makeVerifier()
    const token = await mintToken({ sharedFileSystem: 'other-workspace' })
    await expect(verifier.verifyBearer(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects a token missing the sharedFileSystem claim', async () => {
    const verifier = makeVerifier()
    const token = await mintToken({}) // no sharedFileSystem
    await expect(verifier.verifyBearer(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects a token signed with a different key (signature failure)', async () => {
    const otherKp = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const otherPriv = otherKp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const otherKey = await importPKCS8(otherPriv, 'RS256')
    const token = await new SignJWT({ sharedFileSystem: 'team-mission' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('control-api')
      .setAudience('workspace-files-controller')
      .setExpirationTime('5m')
      .setIssuedAt()
      .sign(otherKey)
    const verifier = makeVerifier()
    await expect(verifier.verifyBearer(`Bearer ${token}`)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('rejects a mismatched sharedFileSystemNamespace claim', async () => {
    const verifier = makeVerifier()
    const jwt = await mintToken({
      sharedFileSystem: 'team-mission',
      sharedFileSystemNamespace: 'other-namespace',
    })
    await expect(verifier.verifyBearer(`Bearer ${jwt}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects a missing sharedFileSystemNamespace claim', async () => {
    const verifier = makeVerifier()
    const jwt = await mintToken({
      sharedFileSystem: 'team-mission',
      sharedFileSystemNamespace: null,
    })
    await expect(verifier.verifyBearer(`Bearer ${jwt}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects an empty sharedFileSystemNamespace claim', async () => {
    const verifier = makeVerifier()
    const signed = await mintToken({
      sharedFileSystem: 'team-mission',
      sharedFileSystemNamespace: '',
    })
    await expect(verifier.verifyBearer(`Bearer ${signed}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects a missing scopes claim', async () => {
    const verifier = makeVerifier()
    const signed = await mintToken({
      sharedFileSystem: 'team-mission',
      scopes: null,
    })
    await expect(verifier.verifyBearer(`Bearer ${signed}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects an empty scopes claim', async () => {
    const verifier = makeVerifier()
    const signed = await mintToken({
      sharedFileSystem: 'team-mission',
      scopes: [],
    })
    await expect(verifier.verifyBearer(`Bearer ${signed}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('rejects unknown or duplicate scopes', async () => {
    const verifier = makeVerifier()
    const unknown = await mintToken({
      sharedFileSystem: 'team-mission',
      scopes: [WFC_FILE_READ_SCOPE, 'files:admin'],
    })
    await expect(verifier.verifyBearer(`Bearer ${unknown}`)).rejects.toMatchObject({
      code: 'forbidden',
    })

    const duplicate = await mintToken({
      sharedFileSystem: 'team-mission',
      scopes: [WFC_FILE_READ_SCOPE, WFC_FILE_READ_SCOPE],
    })
    await expect(verifier.verifyBearer(`Bearer ${duplicate}`)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })
})
