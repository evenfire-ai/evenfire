import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { DbTransactionClient } from '../src/db.js'
import {
  DESKTOP_SIGN_IN_CODE_RE,
  DESKTOP_SIGN_IN_CODE_TTL_SECONDS,
  hashDesktopSignInCode,
  mintDesktopSignInCode,
  s256Challenge,
} from '../src/services/auth/oidcDesktopSignInCode.js'

const MINT_INPUT = Object.freeze({
  userId: '3b2a1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  teamId: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
  codeChallenge: 'fixture-challenge-'.padEnd(43, 'x'),
  registrationId: 'fixture-registration',
  configurationGeneration: 'fixture-generation',
})

/** A transaction client that records every statement and its parameters. */
function recordingClient() {
  const query = vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
  return { client: { query } as unknown as DbTransactionClient, query }
}

describe('Desktop sign-in code', () => {
  it('mints a 43-character base64url code and returns 90 seconds', async () => {
    const { client, query } = recordingClient()

    const minted = await mintDesktopSignInCode(client, MINT_INPUT)

    expect(minted.code).toMatch(DESKTOP_SIGN_IN_CODE_RE)
    expect(minted.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(minted.expiresInSeconds).toBe(90)
    expect(DESKTOP_SIGN_IN_CODE_TTL_SECONDS).toBe(90)

    // The purge runs first, then the insert of the hash.
    expect(query).toHaveBeenCalledTimes(2)
    const [purge, insert] = query.mock.calls
    expect(purge![0]).toMatch(/^\s*DELETE FROM oidc_desktop_sign_in_codes\b/)
    expect(purge![0]).toMatch(/expires_at < now\(\) - interval '1 day'/)
    expect(purge![1]).toEqual([100])
    expect(insert![0]).toMatch(/^\s*INSERT INTO oidc_desktop_sign_in_codes\b/)
    const expectedHash = createHash('sha256').update(minted.code).digest('hex')
    expect(hashDesktopSignInCode(minted.code)).toBe(expectedHash)
    expect(insert![1]).toEqual([
      expectedHash,
      MINT_INPUT.userId,
      MINT_INPUT.teamId,
      MINT_INPUT.codeChallenge,
      MINT_INPUT.registrationId,
      MINT_INPUT.configurationGeneration,
      90,
    ])
    // Only the hash is written, and no statement locks or updates a code row.
    expect(JSON.stringify(query.mock.calls)).not.toContain(minted.code)
    for (const [text] of query.mock.calls) expect(text).not.toMatch(/\bUPDATE\b/i)

    // Each mint draws a new code.
    const again = await mintDesktopSignInCode(client, MINT_INPUT)
    expect(again.code).toMatch(DESKTOP_SIGN_IN_CODE_RE)
    expect(again.code).not.toBe(minted.code)
  })

  it('computes the RFC 7636 S256 challenge', () => {
    // RFC 7636 Appendix B.
    expect(s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })
})
