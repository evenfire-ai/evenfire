// The admission keep the Host wires into every incoming message: which
// messages keep their attachments for a later save, where, and what a
// message that cannot be kept carries instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { Attachment } from '../core/types'
import { GfsDownloadStore } from '../internalTools/gfsDownloadStore'
import { admissionKeepAttachments } from '../main'
import type { IncomingMessage } from '../server'
import { CALLER_OUTPUTS_DIR, KEPT_UPLOADS_DIR } from '../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../workspace/scopedWorkspace'

// statfs reports the volume sized to its free space, so the disk's occupancy
// never meets the store's free-space floor.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const { freeSpaceSizedStatfs } = await import('./fixtures/gfsStoreTestKit')
  return { ...actual, statfs: freeSpaceSizedStatfs(actual.statfs) }
})

const BYTES = Buffer.from('minutes of the board meeting\n')

let hostRoot: string
let provider: ScopedWorkspaceProvider
let store: GfsDownloadStore

beforeEach(async () => {
  hostRoot = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'admission-keep-')))
  provider = new ScopedWorkspaceProvider(hostRoot)
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
})

afterEach(async () => {
  await store.close()
  fs.rmSync(hostRoot, { recursive: true, force: true })
})

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const attachment: Attachment = {
    id: 'att-minutes',
    kind: 'file',
    mimeType: 'text/plain',
    encoding: 'base64',
    dataBase64: BYTES.toString('base64'),
    filename: 'minutes.txt',
  }
  return {
    content: 'keep this',
    channelType: 'rpc',
    channelId: 'admission-keep',
    sender: 'keep-caller',
    messageId: 'admission-keep-message',
    hostRef: 'admission-keep-host',
    timestamp: new Date().toISOString(),
    attachments: [attachment],
    ...overrides,
  }
}

function uploadsOf(sender: string): string {
  const root = resolveCallerRootBinding(provider, { sender, channelType: 'rpc' }).root
  if (!root) throw new Error('no caller root')
  return path.join(root, CALLER_OUTPUTS_DIR, KEPT_UPLOADS_DIR)
}

function keep(options: {
  write?: boolean
  provider?: ScopedWorkspaceProvider | null
  store?: GfsDownloadStore | null
}) {
  return admissionKeepAttachments({
    gfsWriteScope: () => options.write ?? true,
    workspaceProvider: () => (options.provider === undefined ? provider : options.provider),
    store: () => (options.store === undefined ? store : options.store),
  })
}

describe('the admission keep', () => {
  it("keeps an attachment's bytes in the caller's kept uploads with gfs.write", async () => {
    expect(await keep({})(message())).toBeUndefined()
    const bins = fs.readdirSync(uploadsOf('keep-caller')).filter(name => name.endsWith('.bin'))
    expect(bins).toHaveLength(1)
    expect(fs.readFileSync(path.join(uploadsOf('keep-caller'), bins[0]!))).toEqual(BYTES)
  })

  it('keeps nothing and says nothing without gfs.write', async () => {
    expect(await keep({ write: false })(message())).toBeUndefined()
    expect(fs.existsSync(uploadsOf('keep-caller'))).toBe(false)
  })

  it('refuses a message with no sender', async () => {
    expect(await keep({})(message({ sender: '' }))).toEqual({ code: 'no_sender' })
  })

  it('refuses when the Host has no download store', async () => {
    expect(await keep({ store: null })(message())).toEqual({ code: 'store_unavailable' })
    expect(fs.existsSync(uploadsOf('keep-caller'))).toBe(false)
  })

  it('refuses when the caller root cannot be resolved', async () => {
    expect(await keep({ provider: null })(message())).toEqual({
      code: 'caller_root_unavailable',
    })
  })

  it('keeps nothing for a message with no attachment bytes', async () => {
    expect(await keep({})(message({ attachments: [] }))).toBeUndefined()
    expect(fs.existsSync(uploadsOf('keep-caller'))).toBe(false)
  })
})
