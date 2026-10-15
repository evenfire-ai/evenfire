import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { runChatGetIndex } from '../chatGetIndexHandler.js'
import type { ChatIndex } from '../types.js'

const authorityScope = { environmentKey: 'env-test', userId: 'user-test', teamId: null }
const index: ChatIndex = {
  version: 2,
  chats: [
    {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-10-13T00:00:00Z',
      updatedAt: '2026-10-13T00:00:00Z',
      messageCount: 1,
    },
  ],
  lastActiveChatId: 'chat-1',
  onboardingDismissed: false,
}

describe('runChatGetIndex', () => {
  it('returns the index while the cleanup started with its authority and agent is still pending', async () => {
    const order: string[] = []
    let release!: () => void
    const cleanup = new Promise<void>(resolve => {
      release = resolve
    })
    const deps = {
      getChatDeletionFenceAuthority: vi.fn(() => {
        order.push('authority')
        return { authorityScope }
      }),
      store: {
        retryPendingDeleteCleanups: vi.fn(async () => {
          order.push('cleanup:start')
          await cleanup
          order.push('cleanup:end')
        }),
        getIndex: vi.fn(async () => {
          order.push('read')
          return index
        }),
      },
      warnCleanupFailure: vi.fn(),
    }
    const result = runChatGetIndex(deps, 'agent-1')
    try {
      expect(order).toEqual(['authority', 'cleanup:start', 'read'])
      expect(deps.store.retryPendingDeleteCleanups).toHaveBeenCalledWith(authorityScope, 'agent-1')
      expect(await result).toBe(index)
      expect(order).toEqual(['authority', 'cleanup:start', 'read'])
      expect(deps.store.getIndex).toHaveBeenCalledWith('agent-1')
      expect(deps.warnCleanupFailure).toHaveBeenCalledTimes(0)
    } finally {
      release()
      await deps.store.retryPendingDeleteCleanups.mock.results[0]?.value
      await result
    }
    expect(order).toEqual(['authority', 'cleanup:start', 'read', 'cleanup:end'])
  })

  it.each(['authority', 'cleanup'])(
    'reports a %s failure and still reads the same index',
    async stage => {
      const failure = new Error('Cleanup failed')
      const deps = {
        getChatDeletionFenceAuthority: vi.fn(() => {
          if (stage === 'authority') throw failure
          return { authorityScope }
        }),
        store: {
          retryPendingDeleteCleanups: vi.fn(async () => {
            throw failure
          }),
          getIndex: vi.fn(async () => index),
        },
        warnCleanupFailure: vi.fn(),
      }
      expect(await runChatGetIndex(deps, 'agent-1')).toBe(index)
      expect(deps.getChatDeletionFenceAuthority).toHaveBeenCalledTimes(1)
      expect(deps.store.getIndex).toHaveBeenCalledTimes(1)
      expect(deps.warnCleanupFailure).toHaveBeenCalledTimes(1)
      expect(deps.warnCleanupFailure).toHaveBeenCalledWith(failure)
    }
  )

  it('propagates index read failures while cleanup is still pending', async () => {
    const failure = new Error('Read failed')
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const cleanup = vi.fn(() => pending)
    const read = vi.fn(async () => {
      throw failure
    })
    const result = runChatGetIndex(
      {
        store: { retryPendingDeleteCleanups: cleanup, getIndex: read },
        getChatDeletionFenceAuthority: () => ({ authorityScope }),
        warnCleanupFailure: vi.fn(),
      },
      'agent-1'
    )
    const assertion = expect(result).rejects.toBe(failure)
    try {
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(1)
      await assertion
    } finally {
      release()
      await assertion
    }
  })

  it('reports a later background rejection exactly once without an unhandled rejection', async () => {
    const failure = new Error('Background cleanup failed')
    let release!: () => void
    let reject!: (error: Error) => void
    const cleanup = new Promise<void>((resolve, fail) => {
      release = resolve
      reject = fail
    })
    const retry = vi.fn(() => cleanup)
    const read = vi.fn(async () => index)
    const warnCleanupFailure = vi.fn()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    const result = runChatGetIndex(
      {
        store: { retryPendingDeleteCleanups: retry, getIndex: read },
        getChatDeletionFenceAuthority: () => ({ authorityScope }),
        warnCleanupFailure,
      },
      'agent-1'
    )
    try {
      expect(retry).toHaveBeenCalledWith(authorityScope, 'agent-1')
      expect(read).toHaveBeenCalledWith('agent-1')
      expect(await result).toBe(index)
      reject(failure)
      // Give Node a turn to emit an unhandled rejection if the catch is missing.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(warnCleanupFailure).toHaveBeenCalledTimes(1)
      expect(warnCleanupFailure).toHaveBeenCalledWith(failure)
      expect(unhandled).toEqual([])
    } finally {
      release()
      await result
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('can be compiled and imported by a plain Node benchmark without Electron', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'chat-get-index-node-'))
    try {
      const source = fs.readFileSync(join(__dirname, '../chatGetIndexHandler.ts'), 'utf8')
      const compiled = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText
      const modulePath = join(dir, 'chatGetIndexHandler.cjs')
      fs.writeFileSync(modulePath, compiled)
      const output = execFileSync(
        process.execPath,
        [
          '-e',
          `
        const assert = require('node:assert/strict');
        const { runChatGetIndex } = require(process.argv[1]);
        const order = [];
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        let cleanup;
        async function main() {
          const result = runChatGetIndex({
            getChatDeletionFenceAuthority: () => ({ authorityScope: {} }),
            store: {
              retryPendingDeleteCleanups: () => {
                order.push('cleanup:start');
                cleanup = pending.then(() => { order.push('cleanup:end'); });
                return cleanup;
              },
              getIndex: async () => { order.push('read'); return { chats: [1] }; }
            },
            warnCleanupFailure: error => { throw error; }
          }, 'agent-1');
          let index;
          let beforeRelease;
          try {
            assert.deepEqual(order, ['cleanup:start', 'read']);
            index = await result;
            beforeRelease = [...order];
          } finally {
            release();
            await cleanup;
            await result;
          }
          process.stdout.write(JSON.stringify({ beforeRelease, afterRelease: order, count: index.chats.length }));
        }
        main().catch(error => { console.error(error); process.exitCode = 1; });
      `,
          modulePath,
        ],
        { cwd: dir, encoding: 'utf8' }
      )
      expect(JSON.parse(output)).toEqual({
        beforeRelease: ['cleanup:start', 'read'],
        afterRelease: ['cleanup:start', 'read', 'cleanup:end'],
        count: 1,
      })
      expect(compiled).not.toContain('electron')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
