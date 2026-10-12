/**
 * #666 D-6 — the ack rpc-proxy hands to Desktop when the Host's 2xx body is
 * not a JSON object. The ack stays empty (the message may already be admitted,
 * so an error would invite a resend) and the unreadable body is logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forwardHostMessageToHost } from '../mcpHostRestService.js'

const host = { name: 'agent-x', url: 'http://host.test', headers: {} }
const message = { content: 'hi', messageId: 'message-1' } as Parameters<
  typeof forwardHostMessageToHost
>[1]

function upstream(body: string, init: { status?: number; contentType?: string } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, {
          status: init.status ?? 200,
          headers: { 'content-type': init.contentType ?? 'application/json' },
        })
    )
  )
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('forwardHostMessageToHost — Host ack body (#666 D-6)', () => {
  it('returns a JSON object ack verbatim and logs nothing', async () => {
    upstream(JSON.stringify({ success: true, taskId: 'task-1', acceptedFileReferenceIds: ['a'] }))

    const ack = await forwardHostMessageToHost(host, message, { async: true })

    // Witness: the body was read and returned, not replaced.
    expect(ack).toEqual({ success: true, taskId: 'task-1', acceptedFileReferenceIds: ['a'] })
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns an empty ack for an empty body without logging', async () => {
    upstream('')

    expect(await forwardHostMessageToHost(host, message)).toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-JSON body', '<html>gateway</html>', 'text/html', 'SyntaxError'],
    ['a JSON array', '[1,2]', 'application/json', 'not_an_object'],
    ['a JSON string', '"ok"', 'application/json', 'not_an_object'],
  ])(
    'answers {} and logs the unreadable body for %s',
    async (_label, body, contentType, reason) => {
      upstream(body, { contentType })

      const ack = await forwardHostMessageToHost(host, message, { async: true })

      expect(ack).toEqual({})
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        event: 'host_message_ack_unreadable',
        hostRef: 'agent-x',
        messageId: 'message-1',
        status: 200,
        contentType,
        reason,
        bodyLength: body.length,
        bodySnippet: body,
      })
    }
  )

  it('bounds the logged snippet to 300 characters', async () => {
    upstream('x'.repeat(1000), { contentType: 'text/plain' })

    await forwardHostMessageToHost(host, message)

    const logged = JSON.parse(String(warn.mock.calls[0]?.[0]))
    expect(logged.bodyLength).toBe(1000)
    expect(logged.bodySnippet).toHaveLength(300)
  })

  it('still throws UpstreamHostError for a non-2xx answer', async () => {
    upstream('boom', { status: 502, contentType: 'text/plain' })

    await expect(forwardHostMessageToHost(host, message)).rejects.toMatchObject({
      name: 'UpstreamHostError',
    })
    expect(warn).not.toHaveBeenCalled()
  })
})
