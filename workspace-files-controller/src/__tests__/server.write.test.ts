import { generateKeyPairSync } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SignJWT, importPKCS8 } from 'jose'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WFC_FILE_READ_SCOPE, WFC_FILE_WRITE_SCOPE, type WfcFileScope } from '../auth/jwtVerifier'
import type { Config } from '../config'
import { createApp } from '../server'

let publicKeyPem: string
let privatePem: string

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
})

let mountPath: string
let extraCleanupPaths: string[]

beforeEach(async () => {
  // Fresh mount per test so writes/deletes don't leak across cases.
  mountPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wfc-write-'))
  extraCleanupPaths = []
})

afterEach(async () => {
  await fs.rm(mountPath, { recursive: true, force: true })
  await Promise.all(extraCleanupPaths.map(p => fs.rm(p, { recursive: true, force: true })))
})

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    mountPath,
    sharedFileSystemName: 'team-mission',
    sharedFileSystemNamespace: 'mcp-host',
    jwtPublicKey: publicKeyPem,
    jwtIssuer: 'control-api',
    jwtAudience: 'workspace-files-controller',
    maxUploadBytes: 100 * 1024,
    maxListEntries: 5000,
    maxPathDepth: 32,
    ...overrides,
  }
}

async function token(
  scopes: readonly WfcFileScope[] = [WFC_FILE_READ_SCOPE, WFC_FILE_WRITE_SCOPE]
): Promise<string> {
  const key = await importPKCS8(privatePem, 'RS256')
  return new SignJWT({
    sharedFileSystem: 'team-mission',
    sharedFileSystemNamespace: 'mcp-host',
    scopes,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('control-api')
    .setAudience('workspace-files-controller')
    .setSubject('admin-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

async function setupSymlinkedAncestor(): Promise<string> {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wfc-outside-'))
  extraCleanupPaths.push(outside)
  await fs.mkdir(path.join(outside, 'docs'), { recursive: true })
  await fs.writeFile(path.join(outside, 'existing.txt'), 'outside-original')
  await fs.writeFile(path.join(outside, 'victim.txt'), 'outside-victim')
  await fs.writeFile(path.join(outside, 'docs', 'inside.txt'), 'outside-inside')
  await fs.symlink(outside, path.join(mountPath, 'linkdir'))
  return outside
}

describe('POST /v1/files/upload', () => {
  it('creates a new file from a multipart upload (201)', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'notes.md')
      .attach('file', Buffer.from('hello world\n'), 'notes.md')

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ path: 'notes.md', kind: 'file' })
    const onDisk = await fs.readFile(path.join(mountPath, 'notes.md'), 'utf8')
    expect(onDisk).toBe('hello world\n')
  })

  it('upload to a nested path mkdirs intermediate dirs', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'a/b/c/file.md')
      .attach('file', Buffer.from('x'), 'file.md')
    expect(res.status).toBe(201)
    const stat = await fs.lstat(path.join(mountPath, 'a/b/c/file.md'))
    expect(stat.isFile()).toBe(true)
  })

  it('refuses to overwrite an existing file (409)', async () => {
    await fs.writeFile(path.join(mountPath, 'notes.md'), 'original')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'notes.md')
      .attach('file', Buffer.from('new'), 'notes.md')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('already_exists')
    // Original content untouched.
    expect(await fs.readFile(path.join(mountPath, 'notes.md'), 'utf8')).toBe('original')
  })

  it('413 when the file exceeds maxUploadBytes', async () => {
    const app = createApp(makeConfig({ maxUploadBytes: 16 }))
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'big.bin')
      .attach('file', Buffer.alloc(64), 'big.bin')
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('payload_too_large')
  })

  it('400 when no file is attached', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'x.md')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })

  it('rejects unsupported extra multipart fields', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'x.md')
      .field('extra', 'unsupported')
      .attach('file', Buffer.from('x'), 'x.md')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    await expect(fs.lstat(path.join(mountPath, 'x.md'))).rejects.toThrow()
  })

  it('rejects deeply nested multipart field names', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path[first][second]', 'x.md')
      .attach('file', Buffer.from('x'), 'x.md')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    await expect(fs.lstat(path.join(mountPath, 'x.md'))).rejects.toThrow()
  })

  it('rejects traversal in the path field (400 path_invalid)', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', '../escape.md')
      .attach('file', Buffer.from('x'), 'escape.md')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })

  it('rejects upload through a symlinked ancestor and leaves the external target untouched', async () => {
    const outside = await setupSymlinkedAncestor()
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'linkdir/created.txt')
      .attach('file', Buffer.from('new'), 'created.txt')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    await expect(fs.lstat(path.join(outside, 'created.txt'))).rejects.toThrow()
  })
})

describe('PUT /v1/files/replace', () => {
  it('overwrites an existing file (200)', async () => {
    await fs.writeFile(path.join(mountPath, 'notes.md'), 'before')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .put('/v1/files/replace')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'notes.md')
      .attach('file', Buffer.from('after'), 'notes.md')
    expect(res.status).toBe(200)
    expect(await fs.readFile(path.join(mountPath, 'notes.md'), 'utf8')).toBe('after')
  })

  it('404 if the target does not exist', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .put('/v1/files/replace')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'missing.md')
      .attach('file', Buffer.from('x'), 'missing.md')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('400 if the target is a directory', async () => {
    await fs.mkdir(path.join(mountPath, 'docs'))
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .put('/v1/files/replace')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'docs')
      .attach('file', Buffer.from('x'), 'docs')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('is_a_directory')
  })

  it('rejects replace through a symlinked ancestor and preserves the external file', async () => {
    const outside = await setupSymlinkedAncestor()
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .put('/v1/files/replace')
      .set('authorization', `Bearer ${t}`)
      .field('path', 'linkdir/existing.txt')
      .attach('file', Buffer.from('changed'), 'existing.txt')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    expect(await fs.readFile(path.join(outside, 'existing.txt'), 'utf8')).toBe('outside-original')
  })
})

describe('POST /v1/files/mkdir', () => {
  it('creates the directory and any parents (201)', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', `Bearer ${t}`)
      .send({ path: 'a/b/c' })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(true)
    const lst = await fs.lstat(path.join(mountPath, 'a/b/c'))
    expect(lst.isDirectory()).toBe(true)
  })

  it('idempotent: returns 200 created=false when the dir already exists', async () => {
    await fs.mkdir(path.join(mountPath, 'docs'))
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', `Bearer ${t}`)
      .send({ path: 'docs' })
    expect(res.status).toBe(200)
    expect(res.body.data.created).toBe(false)
  })

  it('refuses to mkdir over a file (409 already_exists)', async () => {
    await fs.writeFile(path.join(mountPath, 'oops'), 'plain file')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', `Bearer ${t}`)
      .send({ path: 'oops' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('already_exists')
  })

  it('400 when path is missing', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', `Bearer ${t}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })

  it('rejects mkdir through a symlinked ancestor and does not create an external directory', async () => {
    const outside = await setupSymlinkedAncestor()
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', `Bearer ${t}`)
      .send({ path: 'linkdir/newdir' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    await expect(fs.lstat(path.join(outside, 'newdir'))).rejects.toThrow()
  })
})

describe('POST /v1/files/move', () => {
  it('renames a file', async () => {
    await fs.writeFile(path.join(mountPath, 'old.md'), 'x')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'old.md', to: 'new.md' })
    expect(res.status).toBe(200)
    await expect(fs.lstat(path.join(mountPath, 'old.md'))).rejects.toThrow()
    expect(await fs.readFile(path.join(mountPath, 'new.md'), 'utf8')).toBe('x')
  })

  it('moves a file into a new subdirectory (creating it)', async () => {
    await fs.writeFile(path.join(mountPath, 'a.md'), 'x')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'a.md', to: 'archive/2026/a.md' })
    expect(res.status).toBe(200)
    expect(await fs.readFile(path.join(mountPath, 'archive/2026/a.md'), 'utf8')).toBe('x')
  })

  it('refuses to overwrite an existing destination (409)', async () => {
    await fs.writeFile(path.join(mountPath, 'a.md'), 'A')
    await fs.writeFile(path.join(mountPath, 'b.md'), 'B')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'a.md', to: 'b.md' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('already_exists')
    // Both files still present.
    expect(await fs.readFile(path.join(mountPath, 'a.md'), 'utf8')).toBe('A')
    expect(await fs.readFile(path.join(mountPath, 'b.md'), 'utf8')).toBe('B')
  })

  it('404 if from does not exist', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'missing.md', to: 'new.md' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('rejects traversal in either argument', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const a = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: '../etc', to: 'x' })
    expect(a.status).toBe(400)
    const b = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'x', to: '../etc' })
    expect(b.status).toBe(400)
  })

  it('rejects move to a symlinked ancestor and leaves source plus external target unchanged', async () => {
    const outside = await setupSymlinkedAncestor()
    await fs.writeFile(path.join(mountPath, 'source.md'), 'inside-source')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'source.md', to: 'linkdir/moved.md' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    expect(await fs.readFile(path.join(mountPath, 'source.md'), 'utf8')).toBe('inside-source')
    await expect(fs.lstat(path.join(outside, 'moved.md'))).rejects.toThrow()
  })

  it('rejects move from a symlinked source ancestor and does not create a destination', async () => {
    const outside = await setupSymlinkedAncestor()
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'linkdir/victim.txt', to: 'copied.txt' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    await expect(fs.lstat(path.join(mountPath, 'copied.txt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('outside-victim')
  })

  it('rejects a symlinked destination before source existence checks', async () => {
    const outside = await setupSymlinkedAncestor()
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${t}`)
      .send({ from: 'missing.md', to: 'linkdir/moved.md' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    await expect(fs.lstat(path.join(outside, 'moved.md'))).rejects.toThrow()
  })
})

describe('DELETE /v1/files', () => {
  it('deletes a file', async () => {
    await fs.writeFile(path.join(mountPath, 'a.md'), 'x')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: 'a.md' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(200)
    await expect(fs.lstat(path.join(mountPath, 'a.md'))).rejects.toThrow()
  })

  it('deletes an empty directory', async () => {
    await fs.mkdir(path.join(mountPath, 'empty'))
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: 'empty' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(200)
    await expect(fs.lstat(path.join(mountPath, 'empty'))).rejects.toThrow()
  })

  it('refuses to delete a non-empty directory without recursive flag (409 not_empty)', async () => {
    await fs.mkdir(path.join(mountPath, 'docs'))
    await fs.writeFile(path.join(mountPath, 'docs', 'inside.md'), 'x')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: 'docs' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('not_empty')
    // Children still present.
    expect((await fs.readFile(path.join(mountPath, 'docs/inside.md'), 'utf8'))).toBe('x')
  })

  it('recursively deletes when recursive=true', async () => {
    await fs.mkdir(path.join(mountPath, 'docs'))
    await fs.writeFile(path.join(mountPath, 'docs', 'inside.md'), 'x')
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: 'docs', recursive: 'true' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(200)
    await expect(fs.lstat(path.join(mountPath, 'docs'))).rejects.toThrow()
  })

  it('refuses to delete the mount root', async () => {
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: '' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })

  it('refuses to delete a symlink (path_invalid)', async () => {
    await fs.writeFile(path.join(mountPath, 'real.md'), 'x')
    await fs.symlink('real.md', path.join(mountPath, 'link.md'))
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: 'link.md' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
  })

  it('rejects delete through a symlinked ancestor and leaves the external file untouched', async () => {
    const outside = await setupSymlinkedAncestor()
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: 'linkdir/victim.txt' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    expect(await fs.readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('outside-victim')
  })

  it('rejects recursive delete through a symlinked ancestor and leaves the external subtree untouched', async () => {
    const outside = await setupSymlinkedAncestor()
    const app = createApp(makeConfig())
    const t = await token()
    const res = await request(app)
      .delete('/v1/files')
      .query({ path: 'linkdir/docs', recursive: 'true' })
      .set('authorization', `Bearer ${t}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('path_invalid')
    expect(await fs.readFile(path.join(outside, 'docs', 'inside.txt'), 'utf8')).toBe(
      'outside-inside'
    )
  })
})

describe('write endpoints — auth gating', () => {
  it('401 on POST upload without auth', async () => {
    const app = createApp(makeConfig())
    const res = await request(app)
      .post('/v1/files/upload')
      .field('path', 'x.md')
      .attach('file', Buffer.from('y'), 'x.md')
    expect(res.status).toBe(401)
  })

  it('401 on DELETE without auth', async () => {
    const app = createApp(makeConfig())
    const res = await request(app).delete('/v1/files').query({ path: 'x' })
    expect(res.status).toBe(401)
  })

  it('allows write endpoints when token has only write scope', async () => {
    await fs.writeFile(path.join(mountPath, 'replace.md'), 'before')
    await fs.writeFile(path.join(mountPath, 'move-source.md'), 'source')
    const app = createApp(makeConfig())
    const writeOnly = await token([WFC_FILE_WRITE_SCOPE])

    const upload = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${writeOnly}`)
      .field('path', 'write-only-upload.md')
      .attach('file', Buffer.from('created'), 'write-only-upload.md')
    expect(upload.status).toBe(201)
    expect(await fs.readFile(path.join(mountPath, 'write-only-upload.md'), 'utf8')).toBe('created')

    const replace = await request(app)
      .put('/v1/files/replace')
      .set('authorization', `Bearer ${writeOnly}`)
      .field('path', 'replace.md')
      .attach('file', Buffer.from('after'), 'replace.md')
    expect(replace.status).toBe(200)
    expect(await fs.readFile(path.join(mountPath, 'replace.md'), 'utf8')).toBe('after')

    const mkdir = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', `Bearer ${writeOnly}`)
      .send({ path: 'write-only-dir' })
    expect(mkdir.status).toBe(201)
    expect((await fs.lstat(path.join(mountPath, 'write-only-dir'))).isDirectory()).toBe(true)

    const move = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${writeOnly}`)
      .send({ from: 'move-source.md', to: 'move-dest.md' })
    expect(move.status).toBe(200)
    await expect(fs.lstat(path.join(mountPath, 'move-source.md'))).rejects.toThrow()
    expect(await fs.readFile(path.join(mountPath, 'move-dest.md'), 'utf8')).toBe('source')

    const del = await request(app)
      .delete('/v1/files')
      .query({ path: 'write-only-upload.md' })
      .set('authorization', `Bearer ${writeOnly}`)
    expect(del.status).toBe(200)
    await expect(fs.lstat(path.join(mountPath, 'write-only-upload.md'))).rejects.toThrow()
  })

  it('403 on write endpoints when token lacks write scope', async () => {
    await fs.writeFile(path.join(mountPath, 'a.md'), 'x')
    await fs.writeFile(path.join(mountPath, 'replace.md'), 'before')
    await fs.writeFile(path.join(mountPath, 'move-source.md'), 'source')
    const app = createApp(makeConfig())
    const readOnly = await token([WFC_FILE_READ_SCOPE])

    const upload = await request(app)
      .post('/v1/files/upload')
      .set('authorization', `Bearer ${readOnly}`)
      .field('path', 'new.md')
      .attach('file', Buffer.from('new'), 'new.md')
    expect(upload.status).toBe(403)
    await expect(fs.lstat(path.join(mountPath, 'new.md'))).rejects.toThrow()

    const replace = await request(app)
      .put('/v1/files/replace')
      .set('authorization', `Bearer ${readOnly}`)
      .field('path', 'replace.md')
      .attach('file', Buffer.from('after'), 'replace.md')
    expect(replace.status).toBe(403)
    expect(await fs.readFile(path.join(mountPath, 'replace.md'), 'utf8')).toBe('before')

    const mkdir = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', `Bearer ${readOnly}`)
      .send({ path: 'read-only-created' })
    expect(mkdir.status).toBe(403)
    await expect(fs.lstat(path.join(mountPath, 'read-only-created'))).rejects.toThrow()

    const move = await request(app)
      .post('/v1/files/move')
      .set('authorization', `Bearer ${readOnly}`)
      .send({ from: 'move-source.md', to: 'move-dest.md' })
    expect(move.status).toBe(403)
    expect(await fs.readFile(path.join(mountPath, 'move-source.md'), 'utf8')).toBe('source')
    await expect(fs.lstat(path.join(mountPath, 'move-dest.md'))).rejects.toThrow()

    const del = await request(app)
      .delete('/v1/files')
      .query({ path: 'a.md' })
      .set('authorization', `Bearer ${readOnly}`)
    expect(del.status).toBe(403)
    expect(await fs.readFile(path.join(mountPath, 'a.md'), 'utf8')).toBe('x')
  })
})
