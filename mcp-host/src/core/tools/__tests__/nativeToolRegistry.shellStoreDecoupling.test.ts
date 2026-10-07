import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GfsDownloadStore } from '../../../internalTools/gfsDownloadStore'
import type { NativeToolConfig } from '../../interfaces'
import { executeWithTimeout } from '../../orchestration/toolExecutionTimeout'
import { NativeToolRegistry } from '../nativeToolRegistry'

// #1019: the managed shell is bound to the verified caller root, never to the
// GFS download store. These tests run shell_exec through the real registry with
// a real initialized store, and through the same timeout boundary the tool loop
// uses (toolUseLoopSingleTool -> executeWithTimeout).
//
// They are unit coverage of the decoupled registry contract only. The registry
// is given no processing-lease provider here, so they stay green when #1019 is
// reverted: before #1019 TaskExecutor built that provider. The vacuity
// falsifiers that do go red under that revert are the TaskExecutor-level
// X1-shell, X1-delivery, U5-TE and X3-TE in
// src/agent/__tests__/taskExecutor.gfsExecutionSafety.test.ts.

const hosts: string[] = []
const stores: GfsDownloadStore[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const host of hosts.splice(0)) await rm(host, { recursive: true, force: true })
})

function nativeConfig(shellTimeout: number): NativeToolConfig {
  return {
    workspacePath: '/nonexistent-shared-root',
    shellTimeout,
    toolTimeout: shellTimeout,
    toolProgressInterval: 30_000,
    httpAllowlist: [],
    envAllowlist: ['PATH'],
    memoryMaxSize: 1_048_576,
  }
}

async function managedHost(): Promise<{ store: GfsDownloadStore; callerRoot: string }> {
  const host = await mkdtemp(join(tmpdir(), 'gfs-shell-decoupling-'))
  hosts.push(host)
  const callerRoot = join(host, 'users', 'caller-a')
  await mkdir(callerRoot, { recursive: true, mode: 0o700 })
  const store = new GfsDownloadStore(host)
  stores.push(store)
  await store.initialize()
  return { store, callerRoot }
}

function managedRegistry(
  shellTimeout: number,
  store: GfsDownloadStore,
  callerRoot: string
): NativeToolRegistry {
  return new NativeToolRegistry(
    nativeConfig(shellTimeout),
    'shell-store-decoupling',
    undefined, // cronScheduler
    undefined, // sourceMessage
    undefined, // workspace
    undefined, // dynamicEnvProvider
    undefined, // workflowCallerContextOverride
    undefined, // attachmentOptions
    undefined, // spilloverStorage
    undefined, // sessionSearchService
    undefined, // mcpManager
    undefined, // dynamicToolsEnabled
    undefined, // activeLlmProvider
    {
      store,
      deliveryAvailable: true,
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      retentionOwnerId: '99999999-9999-4999-8999-999999999999',
    }
  )
}

function storeMethodNames(): string[] {
  return Object.getOwnPropertyNames(GfsDownloadStore.prototype).filter(
    name =>
      name !== 'constructor' &&
      typeof Object.getOwnPropertyDescriptor(GfsDownloadStore.prototype, name)?.value === 'function'
  )
}

describe('managed shell_exec without the GFS download store (#1019), registry-level unit coverage', () => {
  it.each([
    ['just under one hour', 3_594_000, 3_594_000],
    ['exactly one hour', 3_600_000, 3_600_000],
    ['one millisecond over one hour', 3_600_001, 3_600_001],
    ['the default shell timeout', 1_500_000, 1_500_000],
    ['a context timeout shorter than the shell timeout', 3_600_001, 60_000],
  ])('U5: runs with an effective timeout of %s', async (_label, shellTimeout, effectiveTimeout) => {
    const { store, callerRoot } = await managedHost()
    const shell = managedRegistry(shellTimeout, store, callerRoot).get('shell_exec')
    expect(shell).not.toBeNull()
    const output = await executeWithTimeout(
      shell!,
      { command: 'printf u5-ok; pwd' },
      { onOutput: () => undefined },
      effectiveTimeout
    )
    expect(output.is_error).toBe(false)
    expect(output.content).toContain('u5-ok')
    expect(output.content).toContain(callerRoot)
  })

  it('X3: a shell run makes zero calls on the GFS download store', async () => {
    const { store, callerRoot } = await managedHost()
    const methods = storeMethodNames()
    // Witness that the spy net is not empty: the store's public surface is covered.
    expect(methods).toEqual(
      expect.arrayContaining([
        'isAvailable',
        'createTransfer',
        'publish',
        'reusableReceipt',
        'fail',
        'inspect',
        'releaseReceiptOwner',
        'cleanupExpired',
        'close',
      ])
    )
    const spies = methods.map(name =>
      vi.spyOn(store as unknown as Record<string, (...args: unknown[]) => unknown>, name)
    )
    const shell = managedRegistry(60_000, store, callerRoot).get('shell_exec')
    expect(shell).not.toBeNull()
    const output = await executeWithTimeout(
      shell!,
      { command: 'printf x3-ok' },
      { onOutput: () => undefined },
      60_000
    )
    expect(output.is_error).toBe(false)
    expect(output.content).toContain('x3-ok')
    const called = spies
      .map((spy, index) => [methods[index], spy.mock.calls.length] as const)
      .filter(([, calls]) => calls > 0)
    expect(called).toEqual([])
    // The spies are live: a direct call is recorded.
    store.isAvailable()
    expect(spies[methods.indexOf('isAvailable')]!.mock.calls).toHaveLength(1)
  })
})
