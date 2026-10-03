import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  defaultDevSigningKeyStoreDir,
  loadOrGenerateDevJwtPrivateKey,
} from '../src/devSigningKeys.js'

const require = createRequire(import.meta.url)

let compiledModulePath = ''
const tempDirs: string[] = []

function publicIdentityFingerprint(material: string): string {
  return createHash('sha256')
    .update(createPublicKey(material).export({ type: 'spki', format: 'der' }))
    .digest('hex')
}

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evenfire-dev-keys-'))
  tempDirs.push(dir)
  return dir
}

beforeAll(() => {
  const compileDir = mkdtempSync(join(tmpdir(), 'evenfire-dev-key-provider-'))
  tempDirs.push(compileDir)
  const tsc = require.resolve('typescript/lib/tsc.js')
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      join(process.cwd(), 'src/devSigningKeys.ts'),
      join(process.cwd(), 'src/bannedDevSigningKeys.ts'),
      '--outDir',
      join(compileDir, 'dist'),
      '--rootDir',
      join(process.cwd(), 'src'),
      '--module',
      'NodeNext',
      '--target',
      'es2022',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      '--esModuleInterop',
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'provider compilation failed')
  }
  // This closure build exercises the actual wrapper in another process; full
  // service/production-only layout validation is a separate build gate.
  symlinkSync(join(process.cwd(), 'node_modules'), join(compileDir, 'node_modules'), 'dir')
  compiledModulePath = join(compileDir, 'dist/devSigningKeys.js')
})

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runProviderScript(
  script: string,
  storeDir: string,
  override?: string
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKEY_MODULE: compiledModulePath,
    DEVKEY_STORE: storeDir,
  }
  delete env.EVENFIRE_DEV_KEY_STORE
  if (override !== undefined) env.EVENFIRE_DEV_KEY_STORE = override
  return spawnSync(process.execPath, ['-e', script], {
    cwd: storeDir,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

function runWrapperRuntime(runtime: 'src' | 'dist', override: string | undefined) {
  const layout = realpathSync(tempStore())
  const service = join(layout, 'control-api')
  const moduleDir = join(service, runtime)
  mkdirSync(moduleDir, { recursive: true })
  symlinkSync(join(process.cwd(), 'node_modules'), join(service, 'node_modules'), 'dir')
  if (runtime === 'src') {
    for (const relative of [
      'devSigningKeys.ts',
      'observability/logger.ts',
      'utils/log/redact.ts',
    ]) {
      const destination = join(moduleDir, relative)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(process.cwd(), 'src', relative), destination)
    }
  } else {
    cpSync(dirname(compiledModulePath), moduleDir, { recursive: true })
  }
  const modulePath = join(moduleDir, `devSigningKeys.${runtime === 'src' ? 'ts' : 'js'}`)
  // Control API declares ts-node (not tsx). Its documented resolver maps the
  // production .js import specifiers to these actual copied TypeScript files.
  const sourceLoader =
    runtime === 'src'
      ? `require(${JSON.stringify(require.resolve('ts-node'))}).register({
        project: ${JSON.stringify(join(process.cwd(), 'tsconfig.json'))}, experimentalResolver: true,
        compilerOptions: { rootDir: ${JSON.stringify(service)} }
      });`
      : ''
  const runner = `
    ${sourceLoader}
    const provider = require(${JSON.stringify(modulePath)});
    const { createHash, createPublicKey } = require('node:crypto');
    const material = provider.loadOrGenerateDevJwtPrivateKey('rpc');
    process.stdout.write(JSON.stringify({ storeDir: provider.defaultDevSigningKeyStoreDir(),
      fingerprint: createHash('sha256').update(createPublicKey(material).export({ type: 'spki', format: 'der' })).digest('hex') }));
  `
  const env: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: 'silent' }
  delete env.EVENFIRE_DEV_KEY_STORE
  if (override !== undefined) env.EVENFIRE_DEV_KEY_STORE = override
  const args = ['-e', runner]
  const execute = () => {
    const result = spawnSync(process.execPath, args, {
      cwd: layout,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (result.status !== 0)
      throw new Error(`Wrapper runtime failed with process exit ${result.status}`)
    return JSON.parse(result.stdout) as { storeDir: string; fingerprint: string }
  }
  return { first: execute(), second: execute(), serviceRoot: service }
}

function runChild(slot: 'rpc' | 'session' | 'admin', storeDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const provider = require(process.env.DEVKEY_MODULE)
       const { createHash, createPublicKey } = require('node:crypto')
       const resolved = provider.loadOrGenerateDevJwtPrivateKey(
         process.env.DEVKEY_SLOT,
         process.env.DEVKEY_STORE
       )
       console.log(JSON.stringify({ fingerprint: createHash('sha256').update(createPublicKey(resolved).export({ type: 'spki', format: 'der' })).digest('hex') }))`,
      ],
      {
        env: {
          ...process.env,
          DEVKEY_MODULE: compiledModulePath,
          DEVKEY_SLOT: slot,
          DEVKEY_STORE: storeDir,
        },
        timeout: 15_000,
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('close', code =>
      code === 0
        ? resolve((JSON.parse(stdout.trim()) as { fingerprint: string }).fingerprint)
        : reject(new Error(stderr || `child exited with ${code}`))
    )
  })
}

describe('devSigningKeys persistence contract', () => {
  for (const runtime of ['src', 'dist'] as const) {
    for (const override of [undefined, '', ' \t ']) {
      it(`${runtime} creates and preserves its default identity with ${JSON.stringify(override)} override from another cwd`, () => {
        const result = runWrapperRuntime(runtime, override)
        expect(result.first.storeDir).toBe(join(result.serviceRoot, '.dev-keys'))
        expect(result.second.fingerprint).toBe(result.first.fingerprint)
      })
    }
    it(`${runtime} creates and preserves identity in an absolute store from another cwd`, () => {
      const store = realpathSync(tempStore())
      const result = runWrapperRuntime(runtime, store)
      expect(result.first.storeDir).toBe(store)
      expect(result.second.fingerprint).toBe(result.first.fingerprint)
    })
  }

  it('generates a 0600 file in a 0700 store and reuses it across calls', () => {
    const store = tempStore()
    const first = loadOrGenerateDevJwtPrivateKey('rpc', store)
    const second = loadOrGenerateDevJwtPrivateKey('rpc', store)
    expect(second === first).toBe(true)
    expect(statSync(join(store, 'rpc.pem')).mode & 0o777).toBe(0o600)
    expect(statSync(store).mode & 0o777).toBe(0o700)
  })

  it('keeps slots independent', () => {
    const store = tempStore()
    expect(
      loadOrGenerateDevJwtPrivateKey('rpc', store) ===
        loadOrGenerateDevJwtPrivateKey('session', store)
    ).toBe(false)
  })

  it('fails loudly on corruption instead of regenerating', () => {
    const store = tempStore()
    const file = join(store, 'rpc.pem')
    loadOrGenerateDevJwtPrivateKey('rpc', store)
    writeFileSync(file, 'corrupted store entry')
    expect(() => loadOrGenerateDevJwtPrivateKey('rpc', store)).toThrow(
      expect.objectContaining({ code: 'ERR_JWT_KEY_INVALID' })
    )
    expect(readFileSync(file, 'utf8')).toBe('corrupted store entry')
  })

  it('rejects an existing file with loose permissions', () => {
    const store = tempStore()
    const file = join(store, 'session.pem')
    loadOrGenerateDevJwtPrivateKey('session', store)
    chmodSync(file, 0o644)
    expect(() => loadOrGenerateDevJwtPrivateKey('session', store)).toThrow(
      /group\/other permissions/
    )
  })

  it('rejects symlink substitution', () => {
    const realStore = tempStore()
    const linkStore = `${tempStore()}-link`
    tempDirs.push(linkStore)
    loadOrGenerateDevJwtPrivateKey('admin', realStore)
    mkdirSync(linkStore, { mode: 0o700 })
    symlinkSync(join(realStore, 'admin.pem'), join(linkStore, 'admin.pem'))
    expect(() => loadOrGenerateDevJwtPrivateKey('admin', linkStore)).toThrow(/symbolic link/)
  })

  it('reuses the same identity across real separate processes', async () => {
    const store = tempStore()
    const first = await runChild('admin', store)
    const second = await runChild('admin', store)
    expect(second).toBe(first)
  })

  it('converges when two processes create the same slot concurrently', async () => {
    const store = tempStore()
    const [a, b] = await Promise.all([runChild('rpc', store), runChild('rpc', store)])
    expect(b).toBe(a)
    expect(statSync(join(store, 'rpc.pem')).mode & 0o777).toBe(0o600)
  })

  it('uses a store rooted at the service checkout, independent of cwd', () => {
    expect(defaultDevSigningKeyStoreDir().endsWith(join('control-api', '.dev-keys'))).toBe(true)
  })

  it.each(['', ' \t\n '])('treats a blank store override as unset (%j)', override => {
    const result = runProviderScript(
      `const provider = require(process.env.DEVKEY_MODULE)
       console.log(JSON.stringify({ store: provider.defaultDevSigningKeyStoreDir() }))`,
      tempStore(),
      override
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).store).toBe(
      join(dirname(dirname(realpathSync(compiledModulePath))), '.dev-keys')
    )
  })

  it('rejects a relative override only when the store is used, before writing files', () => {
    const store = tempStore()
    const result = runProviderScript(
      `const provider = require(process.env.DEVKEY_MODULE)
       let error
       try { provider.loadOrGenerateDevJwtPrivateKey('rpc') } catch (err) { error = { code: err.code, reason: err.reason } }
       console.log(JSON.stringify({ error }))`,
      store,
      'relative-dev-keys'
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'ERR_JWT_DEV_STORE', reason: 'relative_store_path' },
    })
    expect(readdirSync(store)).toEqual([])
  })

  it('warns once without emitting key material when dev keys activate', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const provider = await import('../src/devSigningKeys.js')
    const { rootLogger } = await import('../src/observability/logger.js')
    const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})
    try {
      const store = tempStore()
      provider.loadOrGenerateDevJwtPrivateKey('rpc', store)
      provider.loadOrGenerateDevJwtPrivateKey('session', store)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        event: 'dev_jwt_signing_keys_active',
        storeDir: store,
      })
      expect(String(warn.mock.calls.flat())).not.toContain('BEGIN')
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects a store directory with loose permissions on reuse', () => {
    const store = tempStore()
    loadOrGenerateDevJwtPrivateKey('rpc', store)
    chmodSync(store, 0o755)
    expect(() => loadOrGenerateDevJwtPrivateKey('rpc', store)).toThrow(
      /Dev JWT key store directory has group\/other permissions/
    )
  })

  it('rejects a symlinked store directory even when reusing a key', () => {
    const realStore = tempStore()
    const linkStore = `${tempStore()}-dirlink`
    tempDirs.push(linkStore)
    loadOrGenerateDevJwtPrivateKey('session', realStore)
    symlinkSync(realStore, linkStore)
    expect(() => loadOrGenerateDevJwtPrivateKey('session', linkStore)).toThrow(
      expect.objectContaining({ code: 'ERR_JWT_DEV_STORE', reason: 'symbolic_link' })
    )
  })

  it('publishes the derived verifying half next to the signing material', () => {
    const store = tempStore()
    const signing = loadOrGenerateDevJwtPrivateKey('rpc', store)
    loadOrGenerateDevJwtPrivateKey('rpc', store) // reuse must not republish different material
    const expected = createPublicKey(signing).export({ type: 'spki', format: 'pem' }).toString()
    const fd = openSync(join(store, 'rpc.public.pem'), 'r')
    try {
      // publishMaterial requests 0644 for public material but leaves it subject
      // to the process umask; the store only forbids group/other write, so a
      // hardened umask such as 077 legitimately yields 0600 here.
      const mode = fstatSync(fd).mode & 0o777
      expect(mode & 0o600).toBe(0o600)
      expect(mode & 0o022).toBe(0)
      expect(mode & 0o111).toBe(0)
      expect(readFileSync(fd, 'utf8').trim()).toBe(expected.trim())
    } finally {
      closeSync(fd)
    }
  })

  it('backfills a missing verifying half on reuse', () => {
    const store = tempStore()
    const signing = loadOrGenerateDevJwtPrivateKey('session', store)
    rmSync(join(store, 'session.public.pem'))
    loadOrGenerateDevJwtPrivateKey('session', store)
    expect(readFileSync(join(store, 'session.public.pem'), 'utf8').trim()).toBe(
      createPublicKey(signing).export({ type: 'spki', format: 'pem' }).toString().trim()
    )
  })

  it('rejects a published verifying half that disagrees with the signing material', () => {
    const store = tempStore()
    loadOrGenerateDevJwtPrivateKey('admin', store)
    const other = loadOrGenerateDevJwtPrivateKey('rpc', store)
    rmSync(join(store, 'admin.public.pem'))
    writeFileSync(
      join(store, 'admin.public.pem'),
      createPublicKey(other).export({ type: 'spki', format: 'pem' }).toString(),
      { mode: 0o644 }
    )
    expect(() => loadOrGenerateDevJwtPrivateKey('admin', store)).toThrow(
      /public file does not match its signing material/
    )
  })

  it('rejects an orphan verifying half without publishing a new signing identity', () => {
    const store = tempStore()
    loadOrGenerateDevJwtPrivateKey('session', store)
    const privatePath = join(store, 'session.pem')
    const publicPath = join(store, 'session.public.pem')
    const publicBefore = readFileSync(publicPath, 'utf8')
    rmSync(privatePath)
    expect(() => loadOrGenerateDevJwtPrivateKey('session', store)).toThrow(
      /public file without its signing material/
    )
    expect(readdirSync(store)).toEqual(['session.public.pem'])
    expect(readFileSync(publicPath, 'utf8')).toBe(publicBefore)
    try {
      loadOrGenerateDevJwtPrivateKey('session', store)
    } catch (err) {
      expect(err).toMatchObject({
        code: 'ERR_JWT_DEV_STORE',
        reason: 'orphan_public',
        source: publicPath,
      })
    }
  })

  it('adopts a concurrent complete pair published after the initial missing-private read', () => {
    const source = tempStore()
    loadOrGenerateDevJwtPrivateKey('admin', source)
    const store = tempStore()
    const result = runProviderScript(
      `const fs = require('node:fs')
       const { join } = require('node:path')
       const { createHash, createPublicKey } = require('node:crypto')
       const source = ${JSON.stringify(source)}
       const privatePath = join(process.env.DEVKEY_STORE, 'admin.pem')
       const publicPath = join(process.env.DEVKEY_STORE, 'admin.public.pem')
       const originalOpen = fs.openSync
       let firstPrivateRead = true
       fs.openSync = function (path, ...args) {
         if (path === privatePath && firstPrivateRead) {
           firstPrivateRead = false
           try { return originalOpen(path, ...args) } catch (err) {
             if (err.code === 'ENOENT') {
               fs.linkSync(join(source, 'admin.pem'), privatePath)
               fs.linkSync(join(source, 'admin.public.pem'), publicPath)
             }
             throw err
           }
         }
         return originalOpen(path, ...args)
       }
       const provider = require(process.env.DEVKEY_MODULE)
       const resolved = provider.loadOrGenerateDevJwtPrivateKey('admin', process.env.DEVKEY_STORE)
       console.log(JSON.stringify({ fingerprint: createHash('sha256').update(createPublicKey(resolved).export({ type: 'spki', format: 'der' })).digest('hex') }))`,
      store
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).fingerprint).toBe(
      publicIdentityFingerprint(readFileSync(join(source, 'admin.pem'), 'utf8'))
    )
  })

  it('validates the opened winning public file immediately after a publication race', () => {
    const store = tempStore()
    loadOrGenerateDevJwtPrivateKey('rpc', store)
    const matchingPublic = join(store, 'matching-public.pem')
    writeFileSync(matchingPublic, readFileSync(join(store, 'rpc.public.pem')), { mode: 0o644 })
    rmSync(join(store, 'rpc.public.pem'))
    const otherStore = tempStore()
    loadOrGenerateDevJwtPrivateKey('rpc', otherStore)
    const result = runProviderScript(
      `const fs = require('node:fs')
       const { join } = require('node:path')
       const publicPath = join(process.env.DEVKEY_STORE, 'rpc.public.pem')
       const originalLink = fs.linkSync
       const originalOpen = fs.openSync
       let raced = false
       fs.linkSync = function (source, target) {
         if (target === publicPath && !raced) {
           raced = true
           originalLink(${JSON.stringify(join(otherStore, 'rpc.public.pem'))}, publicPath)
         }
         return originalLink(source, target)
       }
       fs.openSync = function (path, ...args) {
         const fd = originalOpen(path, ...args)
         if (path === publicPath && raced) {
           fs.unlinkSync(publicPath)
           originalLink(${JSON.stringify(matchingPublic)}, publicPath)
         }
         return fd
       }
       const provider = require(process.env.DEVKEY_MODULE)
       let error
       try { provider.loadOrGenerateDevJwtPrivateKey('rpc', process.env.DEVKEY_STORE) }
       catch (err) { error = err.message }
       console.log(JSON.stringify({ error }))`,
      store
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).error).toMatch(
      /public file does not match its signing material/
    )
  })
})
