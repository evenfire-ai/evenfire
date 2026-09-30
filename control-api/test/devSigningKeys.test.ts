import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultDevSigningKeyStoreDir,
  loadOrGenerateDevJwtPrivateKey,
} from '../src/devSigningKeys.js'

const require = createRequire(import.meta.url)

let compiledModulePath = ''
const tempDirs: string[] = []

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
      'src/devSigningKeys.ts',
      'src/bannedDevSigningKeys.ts',
      '--outDir',
      compileDir,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--moduleResolution',
      'node',
      '--skipLibCheck',
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'provider compilation failed')
  }
  compiledModulePath = join(compileDir, 'devSigningKeys.js')
})

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  // Stores created inside tests are also in tempDirs; nothing persistent remains.
})

function runChild(slot: 'rpc' | 'session' | 'admin', storeDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const provider = require(process.env.DEVKEY_MODULE)
       const { createHash } = require('node:crypto')
       const resolved = provider.loadOrGenerateDevJwtPrivateKey(
         process.env.DEVKEY_SLOT,
         process.env.DEVKEY_STORE
       )
       console.log(JSON.stringify({ fingerprint: createHash('sha256').update(resolved).digest('hex') }))`,
      ],
      {
        env: {
          ...process.env,
          DEVKEY_MODULE: compiledModulePath,
          DEVKEY_SLOT: slot,
          DEVKEY_STORE: storeDir,
        },
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
  it('generates a 0600 file in a 0700 store and reuses it across calls', () => {
    const store = tempStore()
    const first = loadOrGenerateDevJwtPrivateKey('rpc', store)
    const second = loadOrGenerateDevJwtPrivateKey('rpc', store)
    expect(second).toBe(first)
    expect(statSync(join(store, 'rpc.pem')).mode & 0o777).toBe(0o600)
    expect(statSync(store).mode & 0o777).toBe(0o700)
  })

  it('keeps slots independent', () => {
    const store = tempStore()
    expect(loadOrGenerateDevJwtPrivateKey('rpc', store)).not.toBe(
      loadOrGenerateDevJwtPrivateKey('session', store)
    )
  })

  it('fails loudly on corruption instead of regenerating', () => {
    const store = tempStore()
    const file = join(store, 'rpc.pem')
    loadOrGenerateDevJwtPrivateKey('rpc', store)
    writeFileSync(file, 'corrupted store entry')
    expect(() => loadOrGenerateDevJwtPrivateKey('rpc', store)).toThrow(/corrupt or not an RSA/)
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

  it('warns once without emitting key material when dev keys activate', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const provider = await import('../src/devSigningKeys.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = tempStore()
      provider.loadOrGenerateDevJwtPrivateKey('rpc', store)
      provider.loadOrGenerateDevJwtPrivateKey('session', store)
      expect(warn).toHaveBeenCalledTimes(1)
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
      /Dev JWT key store path is not a directory/
    )
  })

  it('publishes the derived verifying half next to the signing material', () => {
    const store = tempStore()
    const signing = loadOrGenerateDevJwtPrivateKey('rpc', store)
    const publicPath = join(store, 'rpc.public.pem')
    const published = readFileSync(publicPath, 'utf8').trim()
    expect(published).toBe(
      createPublicKey(signing).export({ type: 'spki', format: 'pem' }).toString().trim()
    )
    expect(statSync(publicPath).mode & 0o777).toBe(0o644)
    loadOrGenerateDevJwtPrivateKey('rpc', store)
    expect(readFileSync(publicPath, 'utf8').trim()).toBe(published)
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
})
