/**
 * #666 — `clerum__attachment_read` is presented only for a message that
 * carries `kind:'file'` attachments, and registering it requires its limit.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import type { NativeToolConfig } from '../../interfaces'
import type { Attachment } from '../../types'
import { NativeToolRegistry } from '../nativeToolRegistry'

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
  attachmentTextReadMaxBytes: 262_144,
}

function attachments(kind: 'file' | 'image'): Attachment[] {
  const bytes =
    kind === 'file'
      ? Buffer.from('notes')
      : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const raw =
    kind === 'file'
      ? {
          id: 'file-1',
          kind: 'file',
          mimeType: 'text/plain',
          detectedMediaType: 'text/plain',
          encoding: 'base64',
          dataBase64: bytes.toString('base64'),
          filename: 'notes.txt',
          sizeBytes: bytes.length,
          digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
        }
      : {
          id: 'image-1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: bytes.toString('base64'),
        }
  const result = validateIncomingAttachments([raw], {
    maxCount: 20,
    maxBytes: 1_000_000,
    maxFileBytes: 3_145_728,
    messageId: 'message-1',
  })
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments!
}

function message(attached?: Attachment[]): IncomingMessage {
  return {
    content: 'Analyze the attached file',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-09-24T10:00:00Z',
    messageId: 'message-1',
    hostRef: 'host-1',
    ...(attached ? { attachments: attached } : {}),
  }
}

function toolNames(registry: NativeToolRegistry): string[] {
  return registry.listDefinitions().map(definition => definition.name)
}

describe('NativeToolRegistry — clerum__attachment_read (#666)', () => {
  it('registers the tool for a message with a kind:file attachment', () => {
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      message(attachments('file'))
    )
    expect(toolNames(registry)).toContain('clerum__attachment_read')
    expect(registry.get('clerum__attachment_read')!.parametersSchema()).toMatchObject({
      properties: { maxBytes: { maximum: 262_144 } },
    })
  })

  it.each([
    ['no source message', undefined],
    ['no attachments', message()],
    ['only image attachments', message(attachments('image'))],
  ])('does not register the tool with %s', (_label, source) => {
    const registry = new NativeToolRegistry(config, 'conv-1', undefined, source)
    // Witness: the registry was built and presents its always-on native tools.
    expect(toolNames(registry)).toContain('file_read')
    expect(toolNames(registry)).not.toContain('clerum__attachment_read')
  })

  it('refuses to build without the per-call limit when a file is attached', () => {
    const { attachmentTextReadMaxBytes: _omitted, ...withoutLimit } = config
    // Control: the same config builds when no file is attached.
    expect(() => new NativeToolRegistry(withoutLimit, 'conv-1', undefined, message())).not.toThrow()
    expect(
      () => new NativeToolRegistry(withoutLimit, 'conv-1', undefined, message(attachments('file')))
    ).toThrow('NativeToolConfig.attachmentTextReadMaxBytes is required for file attachments')
  })
})
