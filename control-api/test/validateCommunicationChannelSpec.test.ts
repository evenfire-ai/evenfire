/**
 * B7 defense-in-depth: validateCommunicationChannelSpec chatType validation.
 *
 * The validator rejects CommunicationChannel specs with Telegram items that
 * have a missing or invalid chatType, preventing a raw CRD 422 from surfacing
 * to the caller. Valid specs and non-Telegram specs pass through unchanged.
 */
import { describe, expect, it } from 'vitest'
import { validateCommunicationChannelSpec } from '../src/http/validateCommunicationChannelSpec.js'

describe('validateCommunicationChannelSpec — chatType', () => {
  it('returns no errors for a valid telegram item with chatType private', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [{ channelId: '-1001', chatType: 'private', userIds: ['123'] }],
    })
    expect(errors).toEqual([])
  })

  it('returns no errors for a valid telegram item with chatType group', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [{ channelId: '-1001', chatType: 'group' }],
    })
    expect(errors).toEqual([])
  })

  it('returns no errors for a valid telegram item with chatType supergroup', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [{ channelId: '-1001', chatType: 'supergroup', userIds: ['456'] }],
    })
    expect(errors).toEqual([])
  })

  it('rejects a telegram item with a missing chatType', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [{ channelId: '-1001' }],
    })
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.telegram[0].chatType',
        message: expect.stringContaining('chatType is required'),
      })
    )
  })

  it('rejects a telegram item with an empty chatType string', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [{ channelId: '-1001', chatType: '' }],
    })
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.telegram[0].chatType',
        message: expect.stringContaining('chatType is required'),
      })
    )
  })

  it('rejects a telegram item with an unsupported chatType (e.g. "channel")', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [{ channelId: '-1001', chatType: 'channel' }],
    })
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.telegram[0].chatType',
        message: expect.stringContaining('private, group, or supergroup'),
      })
    )
  })

  it('rejects a telegram item with an unsupported chatType (e.g. "broadcast")', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [{ channelId: '-1001', chatType: 'broadcast' }],
    })
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.telegram[0].chatType',
        message: expect.stringContaining('private, group, or supergroup'),
      })
    )
  })

  it('names the correct index in the error field for multi-item arrays', () => {
    const errors = validateCommunicationChannelSpec({
      telegram: [
        { channelId: '-1001', chatType: 'private' },
        { channelId: '-1002', chatType: 'invalid-type' },
      ],
    })
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.telegram[1].chatType',
      })
    )
    // The first item is valid — no error for index 0 chatType
    expect(errors.every(e => e.field !== 'spec.telegram[0].chatType')).toBe(true)
  })

  it('returns no errors when spec.telegram is absent', () => {
    const errors = validateCommunicationChannelSpec({ hostRef: 'agent-a' })
    expect(errors).toEqual([])
  })

  it('returns no errors when spec.telegram is an empty array', () => {
    const errors = validateCommunicationChannelSpec({ telegram: [] })
    expect(errors).toEqual([])
  })

  it('does not validate chatType for non-telegram arrays (email, slack)', () => {
    const errors = validateCommunicationChannelSpec({
      email: [{ channelId: 'inbox' }],
      slack: [{ channelId: 'C123', workspaceId: 'T456' }],
    })
    // email and slack items are not in scope for chatType; no chatType errors
    expect(errors.filter(e => e.field.includes('chatType'))).toHaveLength(0)
  })
})
