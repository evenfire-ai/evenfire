import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { NativeToolConfig } from '../../core/interfaces'
import { NativeToolRegistry } from '../../core/tools/nativeToolRegistry'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import type { IncomingMessage } from '../../server/types'
import { type CallerRootBinding, resolveCallerRootBinding } from '../callerRootBinding'
import { ScopedWorkspaceProvider } from '../scopedWorkspace'
import { deriveUserKeyFromSource } from '../userKey'

const config: NativeToolConfig = {
  workspacePath: '',
  shellTimeout: 5_000,
  toolTimeout: 60_000,
  toolProgressInterval: 0,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1_048_576,
}

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

describe('NativeRegistry GFS caller file-tool binding', () => {
  let root: string
  let store: GfsDownloadStore
  const stores: GfsDownloadStore[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-caller-binding-'))
  })

  afterEach(async () => {
    for (const item of stores.splice(0)) await item.close().catch(() => undefined)
    fs.rmSync(root, { recursive: true, force: true })
  })

  function source(): IncomingMessage {
    return {
      content: 'process file',
      channelType: 'rpc',
      channelId: 'agent',
      sender: 'alice',
      timestamp: new Date().toISOString(),
      messageId: 'message-1',
      hostRef: 'host-1',
    }
  }

  function registry(callerRoot: string | undefined, deliveryAvailable = true) {
    return new NativeToolRegistry(
      { ...config, workspacePath: root },
      'conversation-1',
      undefined,
      source(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { mcpDiscovery: false, nativeDiscovery: false },
      undefined,
      {
        store,
        deliveryAvailable,
        callerIdentity: 'alice',
        callerWorkspacePath: callerRoot,
        processingLeaseProvider: store.processingLeaseProvider('alice'),
        retentionOwnerId: '11111111-1111-4111-8111-111111111111',
      }
    )
  }

  it('binds memory-off file tools to the verified caller root and reserves store accounting', async () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize()
    const callerRoot = new ScopedWorkspaceProvider(root).forSource(source()).userRootPath
    const registryForCaller = registry(callerRoot)

    await registryForCaller.get('file_write')!.execute({ path: 'own.txt', content: 'own' })
    expect(fs.existsSync(path.join(callerRoot, 'own.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'own.txt'))).toBe(false)

    const ledger = path.join(root, '.gfs-download-store', 'ledger-v1.json')
    const before = fs.readFileSync(ledger, 'utf-8')
    const directRead = await registryForCaller.get('file_read')!.execute({
      path: '.gfs-download-store/ledger-v1.json',
    })
    const directWrite = await registryForCaller.get('file_write')!.execute({
      path: '.gfs-download-store/ledger-v1.json',
      content: 'stolen',
    })
    expect(directRead.is_error).toBe(true)
    expect(directWrite.is_error).toBe(true)
    expect(fs.readFileSync(ledger, 'utf-8')).toBe(before)
  })

  it('blocks another caller cache and symlink aliases through the caller root', async () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize()
    const provider = new ScopedWorkspaceProvider(root)
    const aliceRoot = provider.forSource(source()).userRootPath
    const bobRoot = provider.forUser('bob').userRootPath
    const bobLedger = path.join(bobRoot, '.gfs-download-store', 'ledger-v2.json')
    fs.mkdirSync(path.dirname(bobLedger), { recursive: true })
    fs.writeFileSync(bobLedger, 'bob accounting', 'utf-8')
    fs.symlinkSync(bobLedger, path.join(aliceRoot, 'other-caller-ledger.md'))
    const registryForCaller = registry(aliceRoot)

    const sibling = await registryForCaller.get('file_read')!.execute({
      path: 'other-caller-ledger.md',
    })
    const traversal = await registryForCaller.get('file_read')!.execute({
      path: '../bob/.gfs-download-store/ledger-v2.json',
    })
    expect(sibling.is_error).toBe(true)
    expect(traversal.is_error).toBe(true)
  })

  it('keeps the verified caller root when delivery is recovery-required', async () => {
    fs.mkdirSync(path.join(root, '.gfs-download-store'), { recursive: true })
    fs.writeFileSync(path.join(root, '.gfs-download-store', 'ledger-v1.json'), '{invalid')
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize().catch(() => undefined)
    const callerRoot = new ScopedWorkspaceProvider(root).forSource(source()).userRootPath
    const degraded = registry(callerRoot, false)

    await degraded.get('file_write')!.execute({ path: 'degraded.txt', content: 'still scoped' })
    expect(fs.existsSync(path.join(callerRoot, 'degraded.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'degraded.txt'))).toBe(false)
  })

  it('rejects a caller root redirected directly to Host accounting', async () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize()
    const provider = new ScopedWorkspaceProvider(root)
    const lexicalCallerRoot = provider.forSource(source()).userRootPath
    fs.rmSync(lexicalCallerRoot, { recursive: true, force: true })
    fs.symlinkSync(path.join(root, '.gfs-download-store'), lexicalCallerRoot)

    const binding = resolveCallerRootBinding(provider, source())
    expect(binding.root).toBeUndefined()

    const redirected = registry(binding.root, false)
    expect(redirected.get('file_read')).toBeNull()
    expect(redirected.get('file_write')).toBeNull()
    const shell = await redirected.get('shell_exec')!.execute({ command: 'pwd' })
    expect(shell.is_error).toBe(true)
    expect(shell.content).toContain('Managed shell unavailable')
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('rejects a redirected users parent without falling back to another namespace', async () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize()
    const redirectedUsers = path.join(root, 'redirected-users')
    fs.mkdirSync(path.join(redirectedUsers), { recursive: true })
    fs.symlinkSync(redirectedUsers, path.join(root, 'users'))
    const provider = new ScopedWorkspaceProvider(root)

    const binding = resolveCallerRootBinding(provider, source())

    expect(binding.root).toBeUndefined()
    expect(fs.readdirSync(redirectedUsers)).toEqual([])
    const omitted = registry(binding.root, false)
    expect(omitted.get('file_read')).toBeNull()
    expect(omitted.get('file_write')).toBeNull()
  })

  it('does not create a caller child through a redirected users parent', async () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize()
    const accountingRoot = path.join(root, '.gfs-download-store')
    const ledger = path.join(accountingRoot, 'ledger-v1.json')
    const before = fs.readFileSync(ledger, 'utf-8')
    fs.symlinkSync(accountingRoot, path.join(root, 'users'))
    const provider = new ScopedWorkspaceProvider(root)
    const callerKey = deriveUserKeyFromSource(source())

    const binding = resolveCallerRootBinding(provider, source())

    expect(binding).toEqual({ failureCode: 'EEXIST' })
    expect(fs.existsSync(path.join(accountingRoot, callerKey))).toBe(false)
    expect(fs.readdirSync(accountingRoot)).not.toContain(callerKey)
    expect(fs.readFileSync(ledger, 'utf-8')).toBe(before)
  })

  it('creates and verifies the first healthy caller beneath a Host-owned users parent', () => {
    const provider = new ScopedWorkspaceProvider(root)
    expect(fs.existsSync(path.join(root, 'users'))).toBe(false)

    const binding = resolveCallerRootBinding(provider, source())
    const callerKey = deriveUserKeyFromSource(source())
    const expectedRoot = path.join(fs.realpathSync(root), 'users', callerKey)

    expect(binding).toEqual({ root: expectedRoot })
    expect(fs.statSync(path.join(root, 'users')).isDirectory()).toBe(true)
    expect(fs.statSync(expectedRoot).isDirectory()).toBe(true)
  })

  it('rejects a bound caller root replaced by accounting after Registry construction', async () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize()
    const provider = new ScopedWorkspaceProvider(root)
    const binding = resolveCallerRootBinding(provider, source())
    expect(binding.root).toBeDefined()
    const bound = registry(binding.root)
    const ledger = path.join(root, '.gfs-download-store', 'ledger-v1.json')
    const before = fs.readFileSync(ledger, 'utf-8')

    fs.rmSync(binding.root!, { recursive: true, force: true })
    fs.symlinkSync(path.join(root, '.gfs-download-store'), binding.root!)
    const read = await bound.get('file_read')!.execute({ path: 'ledger-v1.json' })
    const write = await bound.get('file_write')!.execute({
      path: 'ledger-v1.json',
      content: 'replacement',
    })
    const shell = await bound.get('shell_exec')!.execute({ command: 'pwd' })

    expect(read.is_error).toBe(true)
    expect(write.is_error).toBe(true)
    expect(shell.is_error).toBe(true)
    expect(fs.readFileSync(ledger, 'utf-8')).toBe(before)
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('uses the canonical healthy caller root for managed shell execution', async () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    await store.initialize()
    const provider = new ScopedWorkspaceProvider(root)
    const binding = resolveCallerRootBinding(provider, source())
    const healthy = registry(binding.root)

    const shell = await healthy.get('shell_exec')!.execute({ command: 'pwd' })

    expect(shell.is_error).toBe(false)
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ cwd: binding.root })
  })

  it('omits managed file tools when no verified caller root exists', () => {
    store = new GfsDownloadStore(root)
    stores.push(store)
    const missingRoot = registry(undefined, false)
    expect(missingRoot.get('file_read')).toBeNull()
    expect(missingRoot.get('file_write')).toBeNull()
  })

  it('contains concrete filesystem binding failures and propagates programming errors', () => {
    const eaccES = () => {
      const error = new Error('unit') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    }
    const unexpected = () => {
      throw new TypeError('unit programming error')
    }
    const provider = (thrower: () => never) =>
      ({ baseRootPath: root, forSource: thrower }) as unknown as ScopedWorkspaceProvider
    const expected: CallerRootBinding = resolveCallerRootBindingForTest(provider(eaccES))
    expect(expected).toEqual({ failureCode: 'EACCES' })
    expect(() => resolveCallerRootBindingForTest(provider(unexpected))).toThrow(TypeError)
  })
})

function resolveCallerRootBindingForTest(provider: ScopedWorkspaceProvider): CallerRootBinding {
  return resolveCallerRootBinding(provider, undefined)
}
