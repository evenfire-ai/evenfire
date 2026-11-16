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
    expect(edits[0]?.length).toBeLessThanOrEqual(4000)
    expect(posts.at(-1)).toBe(channelRunErrorText('Slack ratelimited'))
    expect(
      [edits[0], ...posts.filter(value => !value.startsWith('⚠️'))].join('').length
    ).toBeGreaterThan(0)
  })
})
