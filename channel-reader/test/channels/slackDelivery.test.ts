import { describe, expect, it, vi } from 'vitest'
import { deliverSlackAnswer } from '../../src/channels/slackDelivery'
import { channelRunErrorText } from '../../src/channels/slackText'

function slackError(code: string): Error {
  const error = new Error(code)
  return Object.assign(error, { data: { error: code } })
}

describe('deliverSlackAnswer', () => {
  it('edits the acknowledgement to an error when post and update both fail, and reports that failure', async () => {
    const edits: string[] = []
    const posts: string[] = []
    const errors: string[] = []
    const result = await deliverSlackAnswer(
      {
        taskId: 'task-1',
        edit: async text => {
          edits.push(text)
          if (!text.startsWith('⚠️')) throw slackError('msg_too_long')
        },
        post: async text => {
          posts.push(text)
          throw slackError('invalid_blocks')
        },
        uploadSnippet: async () => {
          throw slackError('invalid_blocks')
        },
        onApiError: (_err, op) => {
          errors.push(op)
        },
      },
      'A short answer that Slack still rejects.'
    )

    expect(result).toBe('error')
    expect(edits.at(-1)).toBe(channelRunErrorText('Slack msg_too_long'))
    expect(posts).toEqual(['A short answer that Slack still rejects.'])
    expect(errors).toContain('chat.update')
    expect(errors).toContain('chat.postMessage')
  })

  it('posts an error after a follow-up fails so the acknowledgement is not left as the only state', async () => {
    const edits: string[] = []
    const posts: string[] = []
    const text = `${'review '.repeat(700)}end`
    const result = await deliverSlackAnswer(
      {
        taskId: 'task-2',
        edit: async value => {
          edits.push(value)
        },
        post: async value => {
          posts.push(value)
          if (!value.startsWith('⚠️')) throw slackError('ratelimited')
        },
        uploadSnippet: vi.fn(),
        onApiError: () => undefined,
      },
      text
    )

    expect(result).toBe('error')
    expect(edits).toEqual([edits[0]])
    expect(edits[0]?.startsWith('⚠️')).toBe(false)
    expect(edits[0]?.length).toBeLessThanOrEqual(4000)
    expect(posts.at(-1)).toBe(channelRunErrorText('Slack ratelimited'))
    expect([edits[0], ...posts.filter(value => !value.startsWith('⚠️'))].join('')).toBe(text)
  })

  it('returns error when a later post throws slack_post_failed and keeps the first chunk', async () => {
    const edits: string[] = []
    const posts: string[] = []
    const text = `${'review '.repeat(1_300)}end`
    const result = await deliverSlackAnswer(
      {
        taskId: 'task-missing-ts',
        edit: async value => {
          edits.push(value)
        },
        post: async value => {
          posts.push(value)
          if (value.startsWith('⚠️')) return
          throw new Error('slack_post_failed')
        },
        uploadSnippet: vi.fn(),
        onApiError: () => undefined,
      },
      text
    )

    const delivered = [edits[0], ...posts.filter(value => !value.startsWith('⚠️'))].join('')
    expect(result).toBe('error')
    expect(edits).toEqual([edits[0]])
    expect(edits[0]).not.toContain("couldn't finish")
    expect(posts.at(-1)).toBe(channelRunErrorText('Slack slack_post_failed'))
    expect(text.startsWith(delivered)).toBe(true)
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered.length).toBeLessThan(text.length)
  })

  it('uploads an over-limit fence and does not post the fence', async () => {
    const fence = '```\n' + 'x'.repeat(5_000) + '\n```'
    const posts: string[] = []
    const uploadSnippet = vi.fn(async () => undefined)
    const result = await deliverSlackAnswer(
      {
        taskId: 'task-fence',
        edit: async () => undefined,
        post: async value => {
          posts.push(value)
        },
        uploadSnippet,
        onApiError: () => undefined,
      },
      `Intro\n\n${fence}`
    )

    expect(result).toBe('delivered')
    expect(uploadSnippet).toHaveBeenCalledTimes(1)
    expect(uploadSnippet.mock.calls[0]?.[1]).toBe(fence)
    expect(posts.join('\n')).not.toContain(fence)
    expect(posts.join('\n')).not.toContain('x'.repeat(100))
  })
})
