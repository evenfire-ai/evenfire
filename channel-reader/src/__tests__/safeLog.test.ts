import { afterEach, describe, expect, it, vi } from 'vitest'
import { LogLevel, WebClient } from '@slack/web-api'
import net from 'node:net'
import { logCaughtError } from '../safeLog'

const MARKER = 'xoxb-probe-marker-not-a-secret'

async function slackTransportError(): Promise<unknown> {
  const port = await new Promise<number>(resolve => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const chosen = address && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(chosen))
    })
  })
  const client = new WebClient(MARKER, {
    slackApiUrl: `http://127.0.0.1:${port}/api/`,
    logLevel: LogLevel.ERROR,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  })
  try {
    await client.chat.update({ channel: 'C1', ts: '1.1', text: 'x' })
  } catch (err) {
    return err
  }
  throw new Error('expected the closed port to fail the Slack call')
}

describe('logCaughtError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs a Slack transport failure without the request headers', async () => {
    const err = await slackTransportError()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logCaughtError('error', 'slack_connect_failed', err)
    const printed = errorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n')
    expect(printed).toContain('slack_webapi_request_error')
    expect(printed).not.toContain(MARKER)
    expect(printed).not.toMatch(/authorization:\s*bearer/i)
  })
})
