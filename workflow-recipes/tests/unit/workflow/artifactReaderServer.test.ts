import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SignJWT, importPKCS8 } from 'jose'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../src/workflow/artifactReaderServer'

let publicKeyPem = ''
let privateKeyPem = ''

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  publicKeyPem = pair.publicKey
  privateKeyPem = pair.privateKey
})

async function signArtifactToken(claims: Record<string, unknown> = {}): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'RS256')
  return new SignJWT({
    sub: 'wrc',
    recipeName: 'child-run',
    recipeNamespace: 'sandbox-recipes',
    scopes: ['artifact_read'],
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('clerum-wrc')
    .setAudience('mcp-host')
    .setExpirationTime('5m')
    .sign(key)
}

function listen(server: http.Server): Promise<string> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

describe('artifactReaderServer', () => {
  let outputDir = ''
  let server: http.Server | null = null
  let baseUrl = ''

  async function start(): Promise<void> {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-reader-'))
    process.env.CLERUM_OUTPUT_DIR = outputDir
    process.env.CLERUM_WORKFLOW_RECIPE = 'child-run'
    process.env.CLERUM_WORKFLOW_NAMESPACE = 'sandbox-recipes'
    process.env.WRC_PUBLIC_KEY_PEM = publicKeyPem
    server = createServer()
    baseUrl = await listen(server)
  }

  afterEach(async () => {
    if (server) {
      await close(server)
      server = null
    }
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true })
      outputDir = ''
    }
    delete process.env.CLERUM_OUTPUT_DIR
    delete process.env.CLERUM_WORKFLOW_RECIPE
    delete process.env.CLERUM_WORKFLOW_NAMESPACE
    delete process.env.WRC_PUBLIC_KEY_PEM
  })

  it('serves health without auth', async () => {
    await start()

    const res = await fetch(`${baseUrl}/health`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('streams an artifact when token recipe and namespace bindings match', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'custom-sdk-result.json'), '{"ok":true}\n')
    const token = await signArtifactToken({ artifactName: 'custom-sdk-result.json' })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="custom-sdk-result.json"'
    )
    expect(await res.text()).toBe('{"ok":true}\n')
  })

  it('rejects requests without a bearer token', async () => {
    await start()

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`)

    expect(res.status).toBe(401)
  })

  it('rejects tokens without artifact_read scope', async () => {
    await start()
    const token = await signArtifactToken({ scopes: ['status_read'] })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Missing scope: artifact_read' })
  })

  it('rejects artifact reads from non-WRC subjects', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'custom-sdk-result.json'), '{}')
    const token = await signArtifactToken({
      sub: 'coordinator',
      artifactName: 'custom-sdk-result.json',
    })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Only WRC may read artifacts' })
  })

  it('rejects recipeName, recipeNamespace, and artifactName mismatches', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'custom-sdk-result.json'), '{}')

    const wrongRecipe = await signArtifactToken({ recipeName: 'other-child' })
    const wrongNamespace = await signArtifactToken({ recipeNamespace: 'other-namespace' })
    const wrongArtifact = await signArtifactToken({ artifactName: 'other.json' })

    const recipeRes = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`, {
      headers: { authorization: `Bearer ${wrongRecipe}` },
    })
    const namespaceRes = await fetch(
      `${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`,
      {
        headers: { authorization: `Bearer ${wrongNamespace}` },
      }
    )
    const artifactRes = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`, {
      headers: { authorization: `Bearer ${wrongArtifact}` },
    })

    expect(recipeRes.status).toBe(403)
    expect(await recipeRes.json()).toEqual({ error: 'recipeName mismatch' })
    expect(namespaceRes.status).toBe(403)
    expect(await namespaceRes.json()).toEqual({ error: 'recipeNamespace mismatch' })
    expect(artifactRes.status).toBe(403)
    expect(await artifactRes.json()).toEqual({ error: 'artifactName mismatch' })
  })

  it('fails closed when required workflow bindings are not configured', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'custom-sdk-result.json'), '{}')
    delete process.env.CLERUM_WORKFLOW_NAMESPACE
    const token = await signArtifactToken({ artifactName: 'custom-sdk-result.json' })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Workflow artifact reader is not configured' })
  })

  it('requires tokens to be bound to the requested artifact', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'custom-sdk-result.json'), '{}')
    const token = await signArtifactToken()

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/custom-sdk-result.json`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Missing artifactName binding' })
  })

  it('rejects unsafe filenames and does not traverse outside output', async () => {
    await start()
    const token = await signArtifactToken()

    const res = await fetch(
      `${baseUrl}/api/v1/workflow/artifacts/${encodeURIComponent('..secret.json')}`,
      {
        headers: { authorization: `Bearer ${token}` },
      }
    )

    expect([400, 404]).toContain(res.status)
    expect(fs.existsSync(path.join(outputDir, '..secret.json'))).toBe(false)
  })

  it('returns artifact_gone for declared artifacts missing from the output PVC', async () => {
    await start()
    const token = await signArtifactToken({ artifactName: 'missing.json' })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/missing.json`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'artifact_gone',
      code: 'artifact_gone',
      message: 'Artifact "missing.json" is no longer available on the workflow output PVC',
    })
  })

  it('does not follow symlink artifacts outside the output mount', async () => {
    await start()
    const outside = path.join(os.tmpdir(), `clerum-artifact-outside-${Date.now()}.txt`)
    fs.writeFileSync(outside, 'secret\n')
    fs.symlinkSync(outside, path.join(outputDir, 'linked.txt'))
    const token = await signArtifactToken({ artifactName: 'linked.txt' })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/linked.txt`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(404)
    expect(fs.existsSync(outside)).toBe(true)
    fs.rmSync(outside, { force: true })
  })

  it('deletes one artifact only with a WRC artifact_delete token', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), '%PDF-1.4\n')
    fs.writeFileSync(path.join(outputDir, 'keep.json'), '{}')
    const token = await signArtifactToken({
      scopes: ['artifact_delete'],
      artifactName: 'report.pdf',
    })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.pdf`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(204)
    expect(fs.existsSync(path.join(outputDir, 'report.pdf'))).toBe(false)
    expect(fs.existsSync(path.join(outputDir, 'keep.json'))).toBe(true)
  })

  it('rejects file cleanup without an artifactName binding', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), '%PDF-1.4\n')
    const token = await signArtifactToken({ scopes: ['artifact_delete'] })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.pdf`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Missing artifactName binding' })
    expect(fs.existsSync(path.join(outputDir, 'report.pdf'))).toBe(true)
  })

  it('rejects file cleanup when artifactName targets a different file', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), '%PDF-1.4\n')
    const token = await signArtifactToken({
      scopes: ['artifact_delete'],
      artifactName: 'other.pdf',
    })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.pdf`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'artifactName mismatch' })
    expect(fs.existsSync(path.join(outputDir, 'report.pdf'))).toBe(true)
  })

  it('does not follow symlink artifacts during file cleanup', async () => {
    await start()
    const outside = path.join(os.tmpdir(), `clerum-artifact-delete-outside-${Date.now()}.txt`)
    fs.writeFileSync(outside, 'secret\n')
    fs.symlinkSync(outside, path.join(outputDir, 'linked.txt'))
    const token = await signArtifactToken({
      scopes: ['artifact_delete'],
      artifactName: 'linked.txt',
    })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/linked.txt`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(404)
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(path.join(outputDir, 'linked.txt'))).toBe(true)
    fs.rmSync(outside, { force: true })
  })

  it('bulk deletes artifact directory contents without removing the mount directory', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), '%PDF-1.4\n')
    fs.mkdirSync(path.join(outputDir, '.clerum'), { recursive: true })
    fs.writeFileSync(path.join(outputDir, '.clerum', 'state.json'), '{}')
    const token = await signArtifactToken({ scopes: ['artifact_delete'] })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(204)
    expect(fs.existsSync(outputDir)).toBe(true)
    expect(fs.readdirSync(outputDir)).toEqual([])
  })

  it('bulk cleanup unlinks symlinks without following them outside the output mount', async () => {
    await start()
    const outside = path.join(os.tmpdir(), `clerum-artifact-bulk-outside-${Date.now()}.txt`)
    fs.writeFileSync(outside, 'secret\n')
    fs.symlinkSync(outside, path.join(outputDir, 'linked.txt'))
    const token = await signArtifactToken({ scopes: ['artifact_delete'] })

    const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(204)
    expect(fs.existsSync(path.join(outputDir, 'linked.txt'))).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
    fs.rmSync(outside, { force: true })
  })

  it('rejects artifact cleanup without artifact_delete scope and WRC subject', async () => {
    await start()
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), '%PDF-1.4\n')
    const readOnlyToken = await signArtifactToken({
      scopes: ['artifact_read'],
      artifactName: 'report.pdf',
    })
    const coordinatorToken = await signArtifactToken({
      sub: 'coordinator',
      scopes: ['artifact_delete'],
    })

    const readOnlyRes = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    })
    const coordinatorRes = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${coordinatorToken}` },
    })

    expect(readOnlyRes.status).toBe(403)
    expect(await readOnlyRes.json()).toEqual({ error: 'Missing scope: artifact_delete' })
    expect(coordinatorRes.status).toBe(403)
    expect(await coordinatorRes.json()).toEqual({ error: 'Only WRC may delete artifacts' })
    expect(fs.existsSync(path.join(outputDir, 'report.pdf'))).toBe(true)
  })
})
