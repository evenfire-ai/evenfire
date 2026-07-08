import { beforeAll, describe, expect, it } from 'vitest'
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose'
import { JwtTokenFactory } from '../../../src/workflow/jwtTokenFactory'

describe('JwtTokenFactory', () => {
  let factory: JwtTokenFactory
  let publicKeyPem: string

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const privateKeyPem = await exportPKCS8(privateKey)
    publicKeyPem = await exportSPKI(publicKey)
    factory = new JwtTokenFactory(privateKeyPem)
    await factory.initialize()
  })

  // ─── WRC → mcp-host configure token (long-lived, privileged scopes) ──────

  it('signWrcConfigureToken issues a 1h token with configure scopes', async () => {
    const token = await factory.signWrcConfigureToken('my-recipe', 'sandbox-recipes')
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'mcp-host', issuer: 'clerum-wrc' })

    expect(payload.sub).toBe('wrc')
    expect(payload.aud).toBe('mcp-host')
    expect(payload.iss).toBe('clerum-wrc')
    expect((payload as Record<string, unknown>).recipeName).toBe('my-recipe')
    expect((payload as Record<string, unknown>).scopes).toEqual([
      'configure',
      'health:read',
      'kill_switch:write',
    ])

    // 15m ± 10s window (default rotatable runtime JWT TTL).
    const now = Math.floor(Date.now() / 1000)
    expect(payload.exp).toBeDefined()
    expect(payload.exp! - now).toBeGreaterThan(900 - 10)
    expect(payload.exp! - now).toBeLessThanOrEqual(900)
  })

  it('signs runtime tokens with a configurable ttl independent from artifact tokens', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const privateKeyPem = await exportPKCS8(privateKey)
    const runtimeFactory = new JwtTokenFactory(privateKeyPem, { runtimeTokenTtlSeconds: 120 })
    await runtimeFactory.initialize()
    const key = await importSPKI(await exportSPKI(publicKey), 'RS256')

    const runtimeToken = await runtimeFactory.signCoordinatorToWrcToken(
      'my-recipe',
      'sandbox-recipes'
    )
    const artifactToken = await runtimeFactory.signWrcArtifactToken('my-recipe', 'sandbox-recipes')
    const runtimePayload = (await jwtVerify(runtimeToken, key, { audience: 'clerum-wrc' })).payload
    const artifactPayload = (await jwtVerify(artifactToken, key, { audience: 'mcp-host' })).payload
    const now = Math.floor(Date.now() / 1000)

    expect(runtimePayload.exp! - now).toBeGreaterThan(120 - 10)
    expect(runtimePayload.exp! - now).toBeLessThanOrEqual(120)
    expect(artifactPayload.exp! - now).toBeGreaterThan(60 - 5)
    expect(artifactPayload.exp! - now).toBeLessThanOrEqual(60)
  })

  // ─── WRC → mcp-host artifact read token (ephemeral, read-only) ───────────

  it('signWrcArtifactToken issues an ephemeral 60s token with artifact_read scope', async () => {
    const token = await factory.signWrcArtifactToken('my-recipe', 'sandbox-recipes')
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'mcp-host', issuer: 'clerum-wrc' })

    expect(payload.sub).toBe('wrc')
    expect(payload.aud).toBe('mcp-host')
    expect((payload as Record<string, unknown>).recipeName).toBe('my-recipe')
    expect((payload as Record<string, unknown>).scopes).toEqual(['artifact_read'])

    // 60s ± 5s window
    const now = Math.floor(Date.now() / 1000)
    expect(payload.exp).toBeDefined()
    expect(payload.exp! - now).toBeGreaterThan(60 - 5)
    expect(payload.exp! - now).toBeLessThanOrEqual(60)
  })

  it('signWrcArtifactToken can bind the token to a run and artifact name', async () => {
    const token = await factory.signWrcArtifactToken('my-recipe', 'sandbox-recipes', {
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
    })
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'mcp-host', issuer: 'clerum-wrc' })

    expect((payload as Record<string, unknown>).recipeName).toBe('my-recipe')
    expect((payload as Record<string, unknown>).recipeNamespace).toBe('sandbox-recipes')
    expect((payload as Record<string, unknown>).runId).toBe('run-123')
    expect((payload as Record<string, unknown>).artifactName).toBe('custom-sdk-result.json')
    expect((payload as Record<string, unknown>).scopes).toEqual(['artifact_read'])
  })

  // ─── WRC → mcp-host artifact delete token (ephemeral, isolated scope) ────

  it('signWrcArtifactDeleteToken issues an ephemeral 60s token with artifact_delete scope', async () => {
    const token = await factory.signWrcArtifactDeleteToken('my-recipe', 'sandbox-recipes')
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'mcp-host', issuer: 'clerum-wrc' })

    expect(payload.sub).toBe('wrc')
    expect((payload as Record<string, unknown>).scopes).toEqual(['artifact_delete'])
    // Delete scope must NOT overlap with read scope — separation of concerns
    expect((payload as Record<string, unknown>).scopes).not.toContain('artifact_read')

    const now = Math.floor(Date.now() / 1000)
    expect(payload.exp).toBeDefined()
    expect(payload.exp! - now).toBeGreaterThan(60 - 5)
    expect(payload.exp! - now).toBeLessThanOrEqual(60)
  })

  it('signWrcArtifactDeleteToken can bind cleanup to a run and artifact name', async () => {
    const token = await factory.signWrcArtifactDeleteToken('my-recipe', 'sandbox-recipes', {
      runId: 'run-123',
      artifactName: 'report.pdf',
    })
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'mcp-host', issuer: 'clerum-wrc' })

    expect((payload as Record<string, unknown>).recipeName).toBe('my-recipe')
    expect((payload as Record<string, unknown>).recipeNamespace).toBe('sandbox-recipes')
    expect((payload as Record<string, unknown>).runId).toBe('run-123')
    expect((payload as Record<string, unknown>).artifactName).toBe('report.pdf')
    expect((payload as Record<string, unknown>).scopes).toEqual(['artifact_delete'])
  })

  // ─── Coordinator → mcp-host token ────────────────────────────────────────

  it('signs Coordinator → mcp_host token with correct scopes', async () => {
    const token = await factory.signCoordinatorToMcpHostToken('my-recipe', 'sandbox-recipes')
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'mcp-host' })

    expect(payload.sub).toBe('coordinator')
    expect((payload as Record<string, unknown>).scopes).toEqual([
      'execute',
      'mode_read',
      'status_read',
      'health:read',
    ])
  })

  // ─── Coordinator → WRC token ─────────────────────────────────────────────

  it('signs Coordinator → WRC token with correct scopes', async () => {
    const token = await factory.signCoordinatorToWrcToken('my-recipe', 'sandbox-recipes')
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'clerum-wrc' })

    expect(payload.sub).toBe('coordinator')
    expect((payload as Record<string, unknown>).scopes).toEqual([
      'configure_model',
      'model_injection_request',
      'status_write',
      'status_read',
      'signal_read',
      'health_read',
      'trigger_write',
    ])
  })

  it('signs custom Coordinator → WRC token with reduced scopes', async () => {
    const token = await factory.signCustomCoordinatorToWrcToken('my-recipe', 'sandbox-recipes')
    const key = await importSPKI(publicKeyPem, 'RS256')
    const { payload } = await jwtVerify(token, key, { audience: 'clerum-wrc' })

    const scopes = (payload as Record<string, unknown>).scopes as string[]
    expect(payload.sub).toBe('custom-coordinator')
    expect(scopes).toEqual([
      'model_injection_request',
      'status_write',
      'status_read',
      'signal_read',
      'health_read',
    ])
    expect(scopes).not.toContain('configure_model')
    expect(scopes).not.toContain('trigger_write')
  })

  // ─── Uninitialized factory rejects signing ───────────────────────────────

  it('throws when signing without initialization', async () => {
    const uninitialized = new JwtTokenFactory('not-a-key')
    await expect(uninitialized.signWrcConfigureToken('test', 'sandbox-recipes')).rejects.toThrow(
      'not initialized'
    )
    await expect(uninitialized.signWrcArtifactToken('test', 'sandbox-recipes')).rejects.toThrow(
      'not initialized'
    )
    await expect(
      uninitialized.signWrcArtifactDeleteToken('test', 'sandbox-recipes')
    ).rejects.toThrow('not initialized')
    await expect(
      uninitialized.signCustomCoordinatorToWrcToken('test', 'sandbox-recipes')
    ).rejects.toThrow('not initialized')
  })

  it('rejects tokens without a recipe namespace before signing', async () => {
    await expect(
      factory.signCoordinatorToWrcToken('my-recipe', undefined as never)
    ).rejects.toThrow('recipeNamespace is required')
  })

  // ─── Non-overlapping scopes guarantee (privilege separation) ─────────────

  it('configure / artifact / artifact-delete tokens have non-overlapping scopes', async () => {
    const configureToken = await factory.signWrcConfigureToken('r1', 'sandbox-recipes')
    const artifactToken = await factory.signWrcArtifactToken('r1', 'sandbox-recipes')
    const deleteToken = await factory.signWrcArtifactDeleteToken('r1', 'sandbox-recipes')
    const key = await importSPKI(publicKeyPem, 'RS256')

    const configureScopes = (
      (await jwtVerify(configureToken, key, { audience: 'mcp-host' })).payload as Record<
        string,
        unknown
      >
    ).scopes as string[]
    const artifactScopes = (
      (await jwtVerify(artifactToken, key, { audience: 'mcp-host' })).payload as Record<
        string,
        unknown
      >
    ).scopes as string[]
    const deleteScopes = (
      (await jwtVerify(deleteToken, key, { audience: 'mcp-host' })).payload as Record<
        string,
        unknown
      >
    ).scopes as string[]

    // Artifact read scope must NEVER leak into configure or delete tokens.
    expect(configureScopes).not.toContain('artifact_read')
    expect(configureScopes).not.toContain('artifact_delete')
    expect(artifactScopes).not.toContain('configure')
    expect(artifactScopes).not.toContain('artifact_delete')
    expect(deleteScopes).not.toContain('configure')
    expect(deleteScopes).not.toContain('artifact_read')
  })
})
