import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../chatStore.js'

let tempDir: string
let store: ChatStore

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'chatstore-last-active-'))
  store = new ChatStore(tempDir)
  store.setAuthorityScope({ environmentKey: 'env-test', userId: 'user-test', teamId: 'team-test' })
  await store.createChat('agent-1', 'chat-a')
  await store.createChat('agent-1', 'chat-b')
  await store.setLastActiveChatId('agent-1', 'chat-a')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('ChatStore last-active index writes', () => {
  it('reads the committed index without writing or syncing an unchanged selection, but writes a changed one', async () => {
    const read = vi.spyOn(fs, 'readFile')
    const write = vi.spyOn(fs, 'writeFile')
    const open = vi.spyOn(fs, 'open')
    const rename = vi.spyOn(fs, 'rename')
    const indexPath = join(tempDir, 'agent-1', 'index.json')

    await store.setLastActiveChatId('agent-1', 'chat-a')

    expect(read).toHaveBeenCalledWith(indexPath, 'utf-8')
    expect(write).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()

    await store.setLastActiveChatId('agent-1', 'chat-b')

    expect(read).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(`${indexPath}.tmp`, expect.any(String), { mode: 0o600 })
    expect(open).toHaveBeenCalledWith(`${indexPath}.tmp`, 'r')
    expect(rename).toHaveBeenCalledWith(`${indexPath}.tmp`, indexPath)
    expect(await store.getLastActiveChatId('agent-1')).toBe('chat-b')
  })

  it('serializes A to B to A in click order and compares each selection to the latest committed value', async () => {
    const readIndex = vi.spyOn(store, 'getIndex')
    const write = vi.spyOn(fs, 'writeFile')

    await Promise.all([
      store.setLastActiveChatId('agent-1', 'chat-a'),
      store.setLastActiveChatId('agent-1', 'chat-b'),
      store.setLastActiveChatId('agent-1', 'chat-a'),
    ])

    expect(readIndex.mock.calls).toEqual([['agent-1'], ['agent-1'], ['agent-1']])
    expect(write.mock.calls.map(call => JSON.parse(String(call[1])).lastActiveChatId)).toEqual([
      'chat-b',
      'chat-a',
    ])
    expect(await store.getLastActiveChatId('agent-1')).toBe('chat-a')
  })

  it('skips a duplicate queued selection only after the preceding write has committed', async () => {
    const readIndex = vi.spyOn(store, 'getIndex')
    const write = vi.spyOn(fs, 'writeFile')

    await Promise.all([
      store.setLastActiveChatId('agent-1', 'chat-b'),
      store.setLastActiveChatId('agent-1', 'chat-b'),
    ])

    expect(readIndex.mock.calls).toEqual([['agent-1'], ['agent-1']])
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(write.mock.calls[0]![1])).lastActiveChatId).toBe('chat-b')
    expect(await store.getLastActiveChatId('agent-1')).toBe('chat-b')
  })
})
