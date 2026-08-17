import { describe, expect, it, vi } from 'vitest'
import { SlackAdapter } from '../src/channels/slack'

// Importing SlackAdapter pulls in ../src/config, which throws at module-load
// time when CLERUM_HOST_REF is unset. vi.hoisted runs before that import, matching
// the pattern used by src/__tests__/rpcClient.test.ts and friends.
vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

describe('SlackAdapter.sendEphemeral', () => {
  it('posts via chat.postEphemeral with both channel and user', async () => {
    const postEphemeral = vi.fn(async () => ({ ok: true }))
    const adapter = new SlackAdapter()
    // @ts-expect-error test seam: inject a minimal WebClient
    adapter.client = { chat: { postEphemeral } }

    await adapter.sendEphemeral('C0BQ94Y3MS4', 'U04PJ3R9Y5N', 'hello')

    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C0BQ94Y3MS4', user: 'U04PJ3R9Y5N', text: 'hello' })
    )
  })

  it('resolves without throwing when Slack rejects the post', async () => {
    const postEphemeral = vi.fn(async () => {
      throw new Error('user_not_in_channel')
    })
    const adapter = new SlackAdapter()
    // @ts-expect-error test seam
    adapter.client = { chat: { postEphemeral } }

    await expect(adapter.sendEphemeral('C1', 'U1', 'hello')).resolves.toBeUndefined()
  })

  it('is a no-op when the adapter is not connected', async () => {
    const adapter = new SlackAdapter()
    await expect(adapter.sendEphemeral('C1', 'U1', 'hello')).resolves.toBeUndefined()
  })
})
