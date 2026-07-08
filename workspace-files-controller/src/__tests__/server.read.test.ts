import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SignJWT, importPKCS8 } from 'jose'
import { generateKeyPairSync } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import request from 'supertest'
import { WFC_FILE_READ_SCOPE, WFC_FILE_WRITE_SCOPE, type WfcFileScope } from '../auth/jwtVerifier'
import type { Config } from '../config'
import { createApp } from '../server'

let publicKeyPem: string
let privatePem: string
let mountPath: string
let outsidePath: string

beforeAll(async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

  mountPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wfc-test-'))
  outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'wfc-outside-'))
  await fs.mkdir(path.join(mountPath, 'docs'))
  await fs.mkdir(path.join(outsidePath, 'docs'))
  await fs.writeFile(path.join(mountPath, 'mission.md'), '# Team mission\n')
  await fs.writeFile(path.join(mountPath, 'report "final".md'), 'quoted filename\n')
  await fs.writeFile(path.join(mountPath, 'docs', 'runbook.md'), 'do not panic\n')
  await fs.writeFile(path.join(outsidePath, 'victim.txt'), 'outside-victim\n')
  await fs.writeFile(path.join(outsidePath, 'docs', 'listed.txt'), 'outside-listed\n')
  // A symlink we expect the server to refuse to surface.
  await fs.symlink('../mission.md', path.join(mountPath, 'docs', 'link-to-mission.md'))
  await fs.symlink(outsidePath, path.join(mountPath, 'linkdir'))
})

afterAll(async () => {
  await fs.rm(mountPath, { recursive: true, force: true })
  await fs.rm(outsidePath, { recursive: true, force: true })
})

function makeConfig(): Config {
  return {
    port: 0,
    mountPath,
    sharedFileSystemName: 'team-mission',
    sharedFileSystemNamespace: 'mcp-host',
    jwtPublicKey: publicKeyPem,
    jwtIssuer: 'control-api',
    jwtAudience: 'workspace-files-controller',
    maxUploadBytes: 100 * 1024 * 1024,
    maxListEntries: 5000,
    maxPathDepth: 32,
  }
}

async function token(
  sfs = 'team-mission',
  scopes: readonly WfcFileScope[] = [WFC_FILE_READ_SCOPE, WFC_FILE_WRITE_SCOPE]
): Promise<string> {
  const key = await importPKCS8(privatePem, 'RS256')
  return new SignJWT({ sharedFileSystem: sfs, sharedFileSystemNamespace: 'mcp-host', scopes })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('control-api')
    .setAudience('workspace-files-controller')
    .setSubject('admin-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

describe('wfc server — health', () => {
  it('GET /healthz returns 200 even without auth', async () => {
    const app = createApp(makeConfig())
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, status: 'alive' })
  })

  it('GET /readyz returns 200 when the mount exists and is writable', async () => {
    const app = createApp(makeConfig())
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ready')
  })
})

describe('wfc server — auth gating on /v1/*', () => {
  it('401 when no Authorization header is present', async () => {
    const app = createApp(makeConfig())
    const res = await request(app).get('/v1/files').query({ path: '' })
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })

  it('403 when token is for a different SharedFileSystem', async () => {
    const app = createApp(makeConfig())
    const wrong = await token('some-other-workspace')
    const res = await request(app).get('/v1/files').set('authorization', `Bearer ${wrong}`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
  })

  it('403 when token lacks read scope', async () => {
    const app = createApp(makeConfig())
    const writeOnly = await token('team-mission', [WFC_FILE_WRITE_SCOPE])
    const res = await request(app).get('/v1/files').set('authorization', `Bearer ${writeOnly}`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
  })

  it('allows read endpoints when token has only read scope', async () => {
    const app = createApp(makeConfig())
    const readOnly = await token('team-mission', [WFC_FILE_READ_SCOPE])

    const list = await request(app).get('/v1/files').set('authorization', `Bearer ${readOnly}`)
    expect(list.status).toBe(200)
    expect(list.body.ok).toBe(true)

    const stat = await request(app)
      .get('/v1/files/stat')
      .query({ path: 'mission.md' })
      .set('authorization', `Bearer ${readOnly}`)
    expect(stat.status).toBe(200)
    expect(stat.body.data).toMatchObject({ kind: 'file', path: 'mission.md' })

    const download = await request(app)
      .get('/v1/files/download')
      .query({ path: 'mission.md' })
      .set('authorization', `Bearer ${readOnly}`)
    expect(download.status).toBe(200)
  })
})

describe('wfc server — read endpoints (P2)', () => {
  it('GET /v1/files lists root entries and skips symlinks', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app).get('/v1/files').set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const names = (res.body.data.entries as Array<{ name: string }>).map(e => e.name).sort()
    expect(names).toContain('docs')
    expect(names).toContain('mission.md')
    // Symlink in /docs is filtered, but /docs itself is a real dir.
    const docsRes = await request(app)
      .get('/v1/files')
      .query({ path: 'docs' })
      .set('authorization', `Bearer ${t}`)
    const docNames = (docsRes.body.data.entries as Array<{ name: string }>).map(e => e.name)
    expect(docNames).toContain('runbook.md')
    expect(docNames).not.toContain('link-to-mission.md')
  })

  it('GET /v1/files/stat returns metadata for a regular file', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files/stat')
      .query({ path: 'mission.md' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ kind: 'file', path: 'mission.md' })
    expect(res.body.data.size).toBeGreaterThan(0)
  })

  it('GET /v1/files/download streams file bytes with attachment disposition', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files/download')
      .query({ path: 'mission.md' })
      .set('authorization', `Bearer ${t}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''mission.md")
    expect((res.body as Buffer).toString('utf8')).toBe('# Team mission\n')
  })

  it('GET /v1/files/download RFC5987-encodes attachment filenames', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files/download')
      .query({ path: 'report "final".md' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''report%20%22final%22.md"
    )
  })

  it('GET /v1/files/download refuses to stream a directory (400 is_a_directory)', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files/download')
      .query({ path: 'docs' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('is_a_directory')
  })

  it('GET /v1/files/download refuses to stream a symlink (400 path_invalid)', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files/download')
      .query({ path: 'docs/link-to-mission.md' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })

  it('GET /v1/files rejects a symlinked ancestor and does not list external files', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files')
      .query({ path: 'linkdir/docs' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    expect(JSON.stringify(res.body)).not.toContain('listed.txt')
  })

  it('GET /v1/files/stat rejects a symlinked ancestor', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files/stat')
      .query({ path: 'linkdir/victim.txt' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })

  it('GET /v1/files/download rejects a symlinked ancestor and does not stream external bytes', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files/download')
      .query({ path: 'linkdir/victim.txt' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    expect(JSON.stringify(res.body)).not.toContain('outside-victim')
  })

  it('GET /v1/files for a missing path returns 404 not_found', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files')
      .query({ path: 'no-such-dir' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('GET /v1/files with a traversal path returns 400 path_invalid', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .get('/v1/files')
      .query({ path: '../etc' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })
})

describe('wfc server — 404 envelope on unknown routes', () => {
  it('returns the standard error envelope', async () => {
    const app = createApp(makeConfig())
    const res = await request(app).get('/v9/nope')
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})
