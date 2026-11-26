import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import pino from 'pino'
import { REQUIRED_REDACT_PATHS, TOKEN_LEAK_REDACT_PATHS } from '../src/utils/log/redact.js'

describe('token-leak redaction', () => {
  it('every required path is registered in the active redact list', () => {
    for (const required of REQUIRED_REDACT_PATHS) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(required)
    }
  })

  it('redact list covers Authorization headers in both request and response shapes', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('req.headers.authorization')
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('headers.authorization')
  })

  it('redact list covers cross-service token header used by requireInternalToken', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain("req.headers['x-service-token']")
  })

  it('redacts the workflow action delegation at request and outbound header sinks', () => {
    for (const path of [
      "req.headers['x-evenfire-action-delegation']",
      "headers['x-evenfire-action-delegation']",
    ]) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(path)
      expect(REQUIRED_REDACT_PATHS).toContain(path)
    }
  })

  it('redact list covers JWT pair fields used by approval issuance', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('accessToken')
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('refreshToken')
  })

  it('redacts ChatGPT account identifiers', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('chatgptAccountId')
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('accountId')
    expect(REQUIRED_REDACT_PATHS).toContain('chatgptAccountId')
    expect(REQUIRED_REDACT_PATHS).toContain('accountId')
  })

  it('redacts the registry voucher field (defense-in-depth)', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('voucher')
  })

  it('redacts registry connect claim tokens and client secrets', () => {
    for (const p of ['claim_token', 'claimToken', 'client_secret', 'clientSecret']) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(p)
      expect(REQUIRED_REDACT_PATHS).toContain(p)
    }
  })

  it('redacts the RFC 7592 DCR registration_access_token in both snake and camel case', () => {
    for (const p of ['registration_access_token', 'registrationAccessToken']) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(p)
      expect(REQUIRED_REDACT_PATHS).toContain(p)
    }
  })

  it('redacts the PKCE code_verifier (U2) in both snake and camel case', () => {
    for (const p of ['code_verifier', 'codeVerifier']) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(p)
      expect(REQUIRED_REDACT_PATHS).toContain(p)
    }
  })

  it('redacts Grok device-code and nested token fields', () => {
    for (const p of [
      'deviceCode',
      'device_code',
      'userCode',
      'user_code',
      'accountSubject',
      'account_subject',
      'access_token',
      '*.access_token',
      '*.refresh_token',
      '*.id_token',
    ]) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(p)
      expect(REQUIRED_REDACT_PATHS).toContain(p)
    }
  })

  it('removes the Host edge assertion from logged connections, checkpoint results and headers', () => {
    const lines: string[] = []
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk))
        done()
      },
    })
    const logger = pino({ redact: { paths: [...TOKEN_LEAK_REDACT_PATHS], remove: true } }, sink)
    const assertion = 'eyJhbGciOiJSUzI1NiJ9.fixture-edge-assertion.signature'

    logger.info({ edgeAssertion: assertion, hostRef: 'chatllm' }, 'connection')
    logger.info({ connection: { url: 'host-url', edgeAssertion: assertion } }, 'nested connection')
    logger.info({ result: { status: 'allowed', hostEdgeAssertion: assertion } }, 'checkpoint')
    logger.info({ req: { headers: { 'x-clerum-edge-assertion': assertion } } }, 'request')
    logger.info({ headers: { 'x-clerum-edge-assertion': assertion } }, 'outbound')

    // Witness: every record was written, with its non-secret fields intact.
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('"hostRef":"chatllm"')
    expect(lines[2]).toContain('"status":"allowed"')
    for (const line of lines) expect(line).not.toContain(assertion)
  })
})
