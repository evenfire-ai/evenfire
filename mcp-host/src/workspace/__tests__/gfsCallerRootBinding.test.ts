import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { NativeToolConfig } from '../../core/interfaces'
import { NativeToolRegistry } from '../../core/tools/nativeToolRegistry'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import type { IncomingMessage } from '../../server/types'
import { type CallerRootBinding, resolveCallerRootBinding } from '../callerRootBinding'
import { ScopedWorkspaceProvider } from '../scopedWorkspace'

const config: NativeToolConfig = {
  workspacePath: '',
  shellTimeout: 5_000,
  toolTimeout: 60_000,
  toolProgressInterval: 0,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1_048_576,
}

describe('NativeRegistry GFS caller file-tool binding', () => {
  let root: string
  let store: GfsDownloadStore
  const stores: GfsDownloadStore[] = []

  beforeEach(() => {
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
      false,
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
      ({ forSource: thrower }) as unknown as ScopedWorkspaceProvider
    const expected: CallerRootBinding = resolveCallerRootBindingForTest(provider(eaccES))
    expect(expected).toEqual({ failureCode: 'EACCES' })
    expect(() => resolveCallerRootBindingForTest(provider(unexpected))).toThrow(TypeError)
  })
})

function resolveCallerRootBindingForTest(provider: ScopedWorkspaceProvider): CallerRootBinding {
  return resolveCallerRootBinding(provider, undefined)
}
