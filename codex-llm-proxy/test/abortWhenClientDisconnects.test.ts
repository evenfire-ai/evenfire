import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { abortWhenClientDisconnects } from '../src/server.js'

function fakeReqRes(): {
  req: EventEmitter & { on: EventEmitter['on'] }
  res: EventEmitter & { writableEnded: boolean }
} {
  const req = new EventEmitter()
  const res = Object.assign(new EventEmitter(), { writableEnded: false })
  return { req, res }
}

describe('abortWhenClientDisconnects', () => {
  it('does not abort when the request body stream closes after JSON parse', () => {
    const { req, res } = fakeReqRes()
    const abort = new AbortController()
    abortWhenClientDisconnects(req as never, res as never, abort)
    req.emit('close')
    expect(abort.signal.aborted).toBe(false)
  })

  it('aborts when the client drops the response before it ends', () => {
    const { req, res } = fakeReqRes()
    const abort = new AbortController()
    abortWhenClientDisconnects(req as never, res as never, abort)
    res.emit('close')
    expect(abort.signal.aborted).toBe(true)
  })

  it('does not abort after the proxy finished writing the SSE response', () => {
    const { req, res } = fakeReqRes()
    const abort = new AbortController()
    abortWhenClientDisconnects(req as never, res as never, abort)
    res.writableEnded = true
    res.emit('close')
    expect(abort.signal.aborted).toBe(false)
  })
})
