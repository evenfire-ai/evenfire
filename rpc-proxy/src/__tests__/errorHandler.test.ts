import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../app.js'
import { apiErrorHandler } from '../errorHandler.js'

function appThrowing(error: unknown) {
  const app = express()
  app.get('/boom', (_req, _res, next) => next(error))
  app.use(apiErrorHandler)
  return app
}

function named(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

describe('apiErrorHandler', () => {
  it.each(['AbortError', 'TimeoutError'])('maps %s to 504 Gateway Timeout', async name => {
    const res = await request(appThrowing(named(name))).get('/boom')
    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'Gateway Timeout' })
  })

  it('maps a DOMException abort (what fetch rejects with) to 504', async () => {
    const res = await request(appThrowing(new DOMException('aborted', 'AbortError'))).get('/boom')
    expect(res.status).toBe(504)
  })

  it('maps body-parser entity.too.large to 413', async () => {
    const res = await request(
      appThrowing(Object.assign(new Error('big'), { type: 'entity.too.large' }))
    ).get('/boom')
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: 'Payload Too Large' })
  })

  it('maps anything else to 500 without the message and logs the error by name', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await request(appThrowing(new Error('kaput-detail'))).get('/boom')
      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'Internal Server Error' })
      expect(res.text).not.toContain('kaput-detail')
      // Witness: the generic branch ran and logged the cause once, without its message.
      const lines = logged.mock.calls.map(args => String(args[0]))
      expect(lines).toEqual([
        '[RPC_PROXY] unhandled route error method=GET route=/boom error=Error',
      ])
    } finally {
      logged.mockRestore()
    }
  })

  it('is the terminal handler of the real app (tests and production share it)', () => {
    // Express 4 keeps its layer stack on `_router`; the public `router` getter
    // throws a deprecation error.
    const stack = (createApp() as unknown as { _router?: { stack: Array<{ handle: unknown }> } })
      ._router?.stack
    if (!stack) throw new Error('express app exposes no _router stack; update this guard')
    expect(stack.at(-1)!.handle).toBe(apiErrorHandler)
  })
})
