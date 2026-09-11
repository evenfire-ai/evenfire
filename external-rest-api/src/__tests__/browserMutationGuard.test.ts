import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireTrustedBrowserMutation } from '../middleware/browserMutationGuard.js'

function app() {
  const value = express()
  value.use(requireTrustedBrowserMutation)
  value.post('/mutation', (_req, res) => res.status(200).json({ ok: true }))
  return value
}

describe('browser mutation origin protection', () => {
  it('accepts a configured same-site browser origin', async () => {
    await request(app())
      .post('/mutation')
      .set('cookie', 'profile_session=session')
      .set('origin', 'http://localhost:3001')
      .set('sec-fetch-site', 'same-site')
      .expect(200, { ok: true })
  })

  it('rejects a cross-site cookie mutation without reflecting request data', async () => {
    const response = await request(app())
      .post('/mutation')
      .set('cookie', 'profile_session=session')
      .set('origin', 'https://attacker.example')
      .set('sec-fetch-site', 'cross-site')

    expect(response.status).toBe(403)
    expect(response.body.error).toEqual({
      code: 'forbidden',
      message: 'The browser request origin is not allowed.',
      correlationId: expect.any(String),
      retryable: false,
    })
    expect(JSON.stringify(response.body)).not.toContain('attacker.example')
  })

  it('uses only bounded correlation IDs in browser-mutation denials', async () => {
    const valid = await request(app())
      .post('/mutation')
      .set('cookie', 'profile_session=session')
      .set('origin', 'https://attacker.example')
      .set('x-correlation-id', 'browser_ID-42')
    expect(valid.body.error.correlationId).toBe('browser_ID-42')

    for (const rejected of ['browser/request', 'x'.repeat(129)]) {
      const response = await request(app())
        .post('/mutation')
        .set('cookie', 'profile_session=session')
        .set('origin', 'https://attacker.example')
        .set('x-correlation-id', rejected)
      expect(response.body.error.correlationId).not.toBe(rejected)
      expect(response.body.error.correlationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    }
  })

  it('allows native bearer mutations without browser headers', async () => {
    await request(app())
      .post('/mutation')
      .set('authorization', 'Bearer desktop-session')
      .expect(200, { ok: true })
  })
})
