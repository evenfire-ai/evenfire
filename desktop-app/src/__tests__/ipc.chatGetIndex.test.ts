/**
 * `chat:getIndex` must keep returning the index WITH its tombstones when the
 * deleted-chat cleanup retry that precedes it fails (scope changed mid-flight,
 * no session, unreadable chats directory). The renderer filters deleted chats
 * with those tombstones; a rejected read leaves them visible.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppService } from '../appService.js'
import type { ChatIndex } from '../types.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(() => '/nonexistent'), getVersion: vi.fn(), isPackaged: true },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))
// ipc.ts only uses AppService as a type at registration.
vi.mock('../appService.js', () => ({ AppService: class {} }))

const TEAM_A = { environmentKey: 'env-a', userId: 'user-a', teamId: 'team-a' }
const TEAM_B = { ...TEAM_A, teamId: 'team-b' }
const OTHER_USER = { ...TEAM_A, userId: 'user-b' }

let authority: { authorityScope: typeof TEAM_A; sessionGeneration: number } | Error = {
  authorityScope: TEAM_A,
  sessionGeneration: 1,
}
const service = {
  getChatDeletionFenceAuthority: vi.fn(() => {
    if (authority instanceof Error) throw authority
    return authority
  }),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }
const call = (channel: string, payload: unknown) => {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`no IPC handler registered for ${channel}`)
  return handler(trusted, payload)
}
let base: string

beforeAll(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'ipc-chat-getindex-'))
  const binding = await import('../chatStoreBinding.js')
  binding.__setChatStoreBaseDirForTests(base)
  await binding.bindChatStoreForUser('user-a', 'env-a', { teamId: 'team-a' })
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService)
  await call('chat:create', { agentRef: 'agent-1', chatId: 'deleted-chat' })
  const fence = await call('chat:captureDeleteFence', { expectedAuthorityScope: TEAM_A })
  await call('chat:delete', { version: 3, fence, agentRef: 'agent-1', chatId: 'deleted-chat' })
})

afterEach(() => {
  authority = { authorityScope: TEAM_A, sessionGeneration: 1 }
  vi.restoreAllMocks()
})

afterAll(async () => {
  const binding = await import('../chatStoreBinding.js')
  binding.__setChatStoreBaseDirForTests(null)
  binding.unbindChatStore()
  await fs.rm(base, { recursive: true, force: true })
})

const tombstones = (index: unknown) =>
  (index as ChatIndex).deletedChatTombstones?.map(item => item.chatId)

describe('chat:getIndex', () => {
  it('returns the tombstones when the cleanup retry runs normally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const index = await call('chat:getIndex', { agentRef: 'agent-1' })

    expect(tombstones(index)).toEqual(['deleted-chat'])
    expect(service.getChatDeletionFenceAuthority).toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('still returns the tombstones when the session scope changed during the retry', async () => {
    // A transient identity change: the main service reports another user while
    // the store is still bound to user-a, so the retry rejects with a
    // scope-changed error. (A team hop alone no longer rejects: the retry is
    // bound to environment + user.)
    authority = { authorityScope: OTHER_USER, sessionGeneration: 2 }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const index = await call('chat:getIndex', { agentRef: 'agent-1' })

    // Liveness witness: the retry ran and failed, and the failure was reported.
    const report = warn.mock.calls.find(entry => String(entry[0]).includes('[chat:getIndex]'))
    expect(String(report?.[0])).toContain('agent "agent-1"')
    expect(String((report?.[1] as Error).message)).toContain('scope changed')
    expect(tombstones(index)).toEqual(['deleted-chat'])
  })

  it('runs the cleanup retry without a failure report after a team switch of the same user', async () => {
    authority = { authorityScope: TEAM_B, sessionGeneration: 2 }
    service.getChatDeletionFenceAuthority.mockClear()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const index = await call('chat:getIndex', { agentRef: 'agent-1' })

    // Liveness witness: the retry consulted the authority (it did run) and returned the index.
    expect(service.getChatDeletionFenceAuthority).toHaveBeenCalledTimes(1)
    expect(tombstones(index)).toEqual(['deleted-chat'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('still returns the tombstones when there is no authenticated session', async () => {
    authority = new Error('Not authenticated')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const index = await call('chat:getIndex', { agentRef: 'agent-1' })

    const report = warn.mock.calls.find(entry => String(entry[0]).includes('[chat:getIndex]'))
    expect(String((report?.[1] as Error).message)).toBe('Not authenticated')
    expect(tombstones(index)).toEqual(['deleted-chat'])
  })

  it('retries only the cleanups of the agent being read once the bind sweep ran', async () => {
    const binding = await import('../chatStoreBinding.js')
    // Earlier reads in this file already consumed the sweep of the bind.
    const retry = vi.spyOn(binding.requireChatStore(), 'retryPendingDeleteCleanups')
    const readdir = vi.spyOn(fs, 'readdir')

    const index = await call('chat:getIndex', { agentRef: 'agent-1' })

    expect(retry).toHaveBeenCalledWith(TEAM_A, 'agent-1')
    expect(readdir.mock.calls.map(entry => String(entry[0]))).not.toContain(
      join(base, 'env-a', 'user-a')
    )
    expect(tombstones(index)).toEqual(['deleted-chat'])
  })

  it('still returns the tombstones and reports the code when the chats directory is unreadable', async () => {
    const binding = await import('../chatStoreBinding.js')
    // Re-binding the same user (a team switch or a catalog refresh) arms the
    // sweep over every agent directory for the next read.
    await binding.bindChatStoreForUser('user-a', 'env-a', { teamId: 'team-a' })
    const readdir = vi
      .spyOn(fs, 'readdir')
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const index = await call('chat:getIndex', { agentRef: 'agent-1' })

    const report = warn.mock.calls.find(entry => String(entry[0]).includes('[chat:getIndex]'))
    expect(String(report?.[0])).toContain('(EACCES)')
    expect(tombstones(index)).toEqual(['deleted-chat'])
    // The sweep that failed stays armed: the next read walks the directory again.
    await call('chat:getIndex', { agentRef: 'agent-1' })
    const userDir = join(base, 'env-a', 'user-a')
    expect(readdir.mock.calls.map(entry => String(entry[0]))).toEqual([userDir, userDir])
  })
})
