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
}

describe('runChatGetIndex', () => {
  it('awaits cleanup before reading the index, preserving the IPC baseline order', async () => {
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
    expect(order).toEqual(['authority', 'cleanup:start'])
    expect(deps.store.retryPendingDeleteCleanups).toHaveBeenCalledWith(authorityScope, 'agent-1')
    expect(deps.store.getIndex).toHaveBeenCalledTimes(0)
    release()
    expect(await result).toBe(index)
    expect(order).toEqual(['authority', 'cleanup:start', 'cleanup:end', 'read'])
    expect(deps.store.getIndex).toHaveBeenCalledWith('agent-1')
    expect(deps.warnCleanupFailure).toHaveBeenCalledTimes(0)
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
      expect(deps.warnCleanupFailure).toHaveBeenCalledWith(failure)
    }
  )

  it('propagates index read failures after cleanup has completed', async () => {
    const failure = new Error('Read failed')
    const cleanup = vi.fn(async () => {})
    const read = vi.fn(async () => {
      throw failure
    })
    await expect(
      runChatGetIndex(
        {
          store: { retryPendingDeleteCleanups: cleanup, getIndex: read },
          getChatDeletionFenceAuthority: () => ({ authorityScope }),
          warnCleanupFailure: vi.fn(),
        },
        'agent-1'
      )
    ).rejects.toBe(failure)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
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
        const { runChatGetIndex } = require(process.argv[1]);
        const order = [];
        runChatGetIndex({
          getChatDeletionFenceAuthority: () => ({ authorityScope: {} }),
          store: {
            retryPendingDeleteCleanups: async () => { order.push('cleanup'); },
            getIndex: async () => { order.push('read'); return { chats: [1] }; }
          },
          warnCleanupFailure: error => { throw error; }
        }, 'agent-1').then(index => process.stdout.write(JSON.stringify({ order, count: index.chats.length })));
      `,
          modulePath,
        ],
        { cwd: dir, encoding: 'utf8' }
      )
      expect(JSON.parse(output)).toEqual({ order: ['cleanup', 'read'], count: 1 })
      expect(compiled).not.toContain('electron')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
