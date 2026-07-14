import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleHandshakePostVerify,
  handleHandshakePreVerify,
} from '../src/handshake'
import type { SetupHandshakeConfig } from '../src/types'

let secretsDir: string
beforeEach(() => {
  secretsDir = mkdtempSync(join(tmpdir(), 'webhook-gateway-handshake-'))
})
afterEach(() => {
  rmSync(secretsDir, { recursive: true, force: true })
})

function fakeReq(opts: {
  method?: string
  url?: string
  headers?: Record<string, string>
}): IncomingMessage {
  return {
    method: opts.method || 'POST',
    url: opts.url || '/',
    headers: opts.headers || {},
  } as unknown as IncomingMessage
}

function writeSecret(value: string): string {
  const path = join(secretsDir, 'verify-token')
  writeFileSync(path, value, 'utf8')
  return path
}

describe('handleHandshakePreVerify (W2.1 setupHandshake)', () => {
  describe('meta-hub-challenge', () => {
    it('matches and echoes the challenge when the verify token matches', () => {
      const cfg: SetupHandshakeConfig = {
        strategy: 'meta-hub-challenge',
        secretPath: writeSecret('correct-verify-token'),
      }
      const req = fakeReq({
        method: 'GET',
        url: '/?hub.mode=subscribe&hub.verify_token=correct-verify-token&hub.challenge=42abc',
      })
      const out = handleHandshakePreVerify(cfg, req)
      expect(out).toMatchObject({
        kind: 'matched',
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: '42abc',
      })
    })

    it('falls through (no_match) on wrong verify token — verifier handles the 401', () => {
      const cfg: SetupHandshakeConfig = {
        strategy: 'meta-hub-challenge',
        secretPath: writeSecret('correct-verify-token'),
      }
      const req = fakeReq({
        method: 'GET',
        url: '/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42abc',
      })
      expect(handleHandshakePreVerify(cfg, req)).toEqual({ kind: 'no_match' })
    })

    it('falls through on missing query params (mode/verify_token/challenge)', () => {
      const cfg: SetupHandshakeConfig = {
        strategy: 'meta-hub-challenge',
        secretPath: writeSecret('t'),
      }
      // No params at all
      expect(handleHandshakePreVerify(cfg, fakeReq({ method: 'GET', url: '/' }))).toEqual({
        kind: 'no_match',
      })
      // Wrong mode value
      expect(
        handleHandshakePreVerify(
          cfg,
          fakeReq({ method: 'GET', url: '/?hub.mode=unsubscribe&hub.verify_token=t&hub.challenge=c' }),
        ),
      ).toEqual({ kind: 'no_match' })
      // Missing challenge
      expect(
        handleHandshakePreVerify(
          cfg,
          fakeReq({ method: 'GET', url: '/?hub.mode=subscribe&hub.verify_token=t' }),
        ),
      ).toEqual({ kind: 'no_match' })
    })

    it('falls through on POST (only GET is the handshake shape)', () => {
      const cfg: SetupHandshakeConfig = {
        strategy: 'meta-hub-challenge',
        secretPath: writeSecret('t'),
      }
      const req = fakeReq({
        method: 'POST',
        url: '/?hub.mode=subscribe&hub.verify_token=t&hub.challenge=c',
      })
      expect(handleHandshakePreVerify(cfg, req)).toEqual({ kind: 'no_match' })
    })

    it('reports misconfigured when secretPath is missing', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'meta-hub-challenge' }
      const req = fakeReq({
        method: 'GET',
        url: '/?hub.mode=subscribe&hub.verify_token=t&hub.challenge=c',
      })
      const out = handleHandshakePreVerify(cfg, req)
      expect(out.kind).toBe('misconfigured')
    })

    it('reports misconfigured when secretPath does not exist', () => {
      const cfg: SetupHandshakeConfig = {
        strategy: 'meta-hub-challenge',
        secretPath: join(secretsDir, 'nonexistent'),
      }
      const req = fakeReq({
        method: 'GET',
        url: '/?hub.mode=subscribe&hub.verify_token=t&hub.challenge=c',
      })
      const out = handleHandshakePreVerify(cfg, req)
      expect(out.kind).toBe('misconfigured')
    })

    it('strips a trailing newline from the secret file (kubectl create secret artefact)', () => {
      const cfg: SetupHandshakeConfig = {
        strategy: 'meta-hub-challenge',
        secretPath: writeSecret('my-token\n'),
      }
      const req = fakeReq({
        method: 'GET',
        url: '/?hub.mode=subscribe&hub.verify_token=my-token&hub.challenge=ok',
      })
      const out = handleHandshakePreVerify(cfg, req)
      expect(out).toMatchObject({ kind: 'matched', body: 'ok' })
    })
  })

  describe('slack-url-verification', () => {
    it('returns no_match (handled post-verify, not pre-verify)', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'slack-url-verification' }
      const req = fakeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      expect(handleHandshakePreVerify(cfg, req)).toEqual({ kind: 'no_match' })
    })
  })

  describe('stripe-verify', () => {
    it('returns misconfigured (placeholder strategy not implemented)', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'stripe-verify' }
      const req = fakeReq({ method: 'POST' })
      const out = handleHandshakePreVerify(cfg, req)
      expect(out.kind).toBe('misconfigured')
    })
  })
})

describe('handleHandshakePostVerify (W2.1 setupHandshake)', () => {
  describe('slack-url-verification', () => {
    it('matches and echoes the challenge for url_verification body', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'slack-url-verification' }
      const body = Buffer.from(
        JSON.stringify({ token: 'irrelevant', type: 'url_verification', challenge: 'xyz' }),
      )
      const req = fakeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
      const out = handleHandshakePostVerify(cfg, req, body)
      expect(out).toEqual({
        kind: 'matched',
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ challenge: 'xyz' }),
      })
    })

    it('falls through on non-JSON content-type', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'slack-url-verification' }
      const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'xyz' }))
      const req = fakeReq({
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
      })
      expect(handleHandshakePostVerify(cfg, req, body)).toEqual({ kind: 'no_match' })
    })

    it('falls through on body whose type is not url_verification', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'slack-url-verification' }
      const body = Buffer.from(
        JSON.stringify({ type: 'event_callback', event: { type: 'message' } }),
      )
      const req = fakeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      expect(handleHandshakePostVerify(cfg, req, body)).toEqual({ kind: 'no_match' })
    })

    it('falls through on malformed JSON', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'slack-url-verification' }
      const body = Buffer.from('not json{')
      const req = fakeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      expect(handleHandshakePostVerify(cfg, req, body)).toEqual({ kind: 'no_match' })
    })

    it('falls through on GET (only POST is the handshake shape)', () => {
      const cfg: SetupHandshakeConfig = { strategy: 'slack-url-verification' }
      const body = Buffer.from('')
      const req = fakeReq({ method: 'GET' })
      expect(handleHandshakePostVerify(cfg, req, body)).toEqual({ kind: 'no_match' })
    })
  })

  describe('meta-hub-challenge', () => {
    it('returns no_match (handled pre-verify, not post-verify)', () => {
      const cfg: SetupHandshakeConfig = {
        strategy: 'meta-hub-challenge',
        secretPath: writeSecret('t'),
      }
      const req = fakeReq({ method: 'GET', url: '/?hub.mode=subscribe&hub.verify_token=t&hub.challenge=c' })
      expect(handleHandshakePostVerify(cfg, req, Buffer.alloc(0))).toEqual({ kind: 'no_match' })
    })
  })
})
