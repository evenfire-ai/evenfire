import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage } from '../../../server'
import type { MemoryWriteEntry, MemoryWriteLog } from '../../../workspace/memoryWriteLog'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import { SYSTEM_USER_KEY, deriveUserKeyFromSource } from '../../../workspace/userKey'
import { NativeToolRegistry } from '../nativeToolRegistry'

class CapturingLog implements MemoryWriteLog {
  readonly entries: MemoryWriteEntry[] = []
  async record(entry: MemoryWriteEntry): Promise<void> {
    this.entries.push(entry)
  }
}

let baseRoot: string
let provider: ScopedWorkspaceProvider

beforeEach(async () => {
  baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-memory-log-'))
  provider = new ScopedWorkspaceProvider(baseRoot)
})

afterEach(async () => {
  await fs.rm(baseRoot, { recursive: true, force: true })
})

function config() {
  return {
    workspacePath: baseRoot,
    shellTimeout: 1000,
    toolTimeout: 1000,
    toolProgressInterval: 1000,
    httpAllowlist: [],
    envAllowlist: [],
    memoryMaxSize: 10000,
  }
}

function registry(sourceMessage: IncomingMessage | undefined, log: MemoryWriteLog | undefined) {
  const workspace = provider.forSource(sourceMessage)
  return new NativeToolRegistry(
    config(),
    'conversation-1',
    undefined,
    sourceMessage,
    workspace,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    log
  )
}

const source = { sender: 'user-42', channelType: 'slack' } as IncomingMessage

describe('NativeToolRegistry — memory write record', () => {
  it('passes the log with the user key derived from the source message', async () => {
    const log = new CapturingLog()
    const out = await registry(source, log)
      .get('memory_write')!
      .execute({ content: 'zzregistry', target: 'notes.md' })
    expect(out.is_error).toBe(false)
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0].userKey).toBe(deriveUserKeyFromSource(source))
    expect(log.entries[0].relativePath).toBe('memory/notes.md')
  })

  it('records the system user key for a task without a source message', async () => {
    const log = new CapturingLog()
    await registry(undefined, log)
      .get('memory_write')!
      .execute({ content: 'zzsystem', target: 'notes.md' })
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0].userKey).toBe(SYSTEM_USER_KEY)
    expect(SYSTEM_USER_KEY).toBe('_system')
  })

  it('without a log the write succeeds and records nothing', async () => {
    const out = await registry(source, undefined)
      .get('memory_write')!
      .execute({ content: 'zznolog', target: 'notes.md' })
    expect(out.is_error).toBe(false)
    const file = path.join(baseRoot, 'users', deriveUserKeyFromSource(source), 'memory', 'notes.md')
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe('zznolog')
  })
})
