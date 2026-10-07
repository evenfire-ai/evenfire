import { describe, expect, it } from 'vitest'
import type { MessageContentPart } from '../../core/types'
import { IMAGE_SOURCE_INVALID, projectImageSource } from '../imageSource'
import { CodexAuthorizeError } from '../providerAttemptAuthorizer'

// #784: the image provenance projection shared by the Codex and Grok providers.

type ImagePart = Extract<MessageContentPart, { type: 'image' }>

const imagePart = (source: unknown): ImagePart =>
  ({ type: 'image', mimeType: 'image/png', data: 'AAAA', source }) as ImagePart

const gfs = (ids: { attachmentId?: string; toolCallId?: string }) => ({
  kind: 'gfs',
  ...ids,
  drive: 'drive-1',
  resourceId: 'resource-1',
  gfsUri: 'gfs://drive-1/resource-1',
  version: 3,
  name: 'chart.png',
})

const refusal = (detail: string) =>
  `image part has no usable provenance source (${detail}); host producers must attach the attachment or tool call it came from`

describe('projectImageSource (#784)', () => {
  it('projects an attachment source to its attachment and message ids', () => {
    expect(
      projectImageSource(
        imagePart({ kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1', extra: 'x' })
      )
    ).toEqual({ kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1' })
  })

  it('projects a tool source to its attachment and tool call ids', () => {
    expect(
      projectImageSource(imagePart({ kind: 'tool', attachmentId: 'att-2', toolCallId: 'call-2' }))
    ).toEqual({ kind: 'tool', attachmentId: 'att-2', toolCallId: 'call-2' })
  })

  it('projects a GFS read to its tool-call source and drops the GFS fields', () => {
    expect(
      projectImageSource(imagePart(gfs({ attachmentId: 'att-3', toolCallId: 'call-3' })))
    ).toEqual({ kind: 'tool', attachmentId: 'att-3', toolCallId: 'call-3' })
  })

  it.each([
    ['a missing source', undefined, 'missing source'],
    [
      'an attachment with an empty attachmentId',
      { kind: 'attachment', attachmentId: ' ', messageId: 'msg-1' },
      'empty attachmentId',
    ],
    [
      'an attachment with an empty messageId',
      { kind: 'attachment', attachmentId: 'att-1', messageId: '' },
      'empty messageId',
    ],
    [
      'a tool source with an empty attachmentId',
      { kind: 'tool', attachmentId: '', toolCallId: 'call-1' },
      'empty attachmentId',
    ],
    [
      'a tool source with an empty toolCallId',
      { kind: 'tool', attachmentId: 'att-1', toolCallId: ' ' },
      'empty toolCallId',
    ],
    ['a GFS read with no attachmentId', gfs({ toolCallId: 'call-1' }), 'empty attachmentId'],
    ['a GFS read with no toolCallId', gfs({ attachmentId: 'att-1' }), 'empty toolCallId'],
    ['an unknown kind', { kind: 'upload', attachmentId: 'att-1' }, 'unknown source kind'],
  ])('refuses %s with image_source_invalid', (_label, source, detail) => {
    let thrown: unknown
    try {
      projectImageSource(imagePart(source))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(CodexAuthorizeError)
    expect((thrown as CodexAuthorizeError).code).toBe(IMAGE_SOURCE_INVALID)
    expect((thrown as CodexAuthorizeError).message).toBe(refusal(detail))
  })

  it('names the code both providers classify as a non-retryable pre-authorize refusal', () => {
    expect(IMAGE_SOURCE_INVALID).toBe('image_source_invalid')
  })
})
