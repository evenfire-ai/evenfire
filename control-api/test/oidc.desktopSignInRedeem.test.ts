import { describe, expect, it, vi } from 'vitest'
import type { DbTransactionClient } from '../src/db.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { hashDesktopSignInCode, s256Challenge } from '../src/services/auth/oidcDesktopSignInCode.js'
import { redeemDesktopSignInCode } from '../src/services/auth/oidcDesktopSignInRedeem.js'
import { createOidcMemberSignInFakeProvider } from './helpers/oidcMemberSignInFakeProvider.js'

/**
 * The redeem decisions taken before the account is read, through the
 * `deps.transaction` seam with a stand-in transaction that answers only the
 * code's DELETE … RETURNING. The whole transaction, its rollback and its
 * grants need real PostgreSQL as the runtime role, not this stand-in.
 */
const provider = createOidcMemberSignInFakeProvider().provider
const DESKTOP_CODE = 'fixture-desktop-code-'.padEnd(43, 'd')
const CODE_VERIFIER = 'fixture-desktop-verifier-'.padEnd(43, 'v')
const USER_ID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const sessionPolicy: EffectiveUserAccessPolicy = Object.freeze({
  policyVersion: '1',
  policyRevision: 'desktop-redeem-service-fixture',
  acceptV1: true,
  issueV1: true,
  acceptV2: true,
  issueV2: true,
  renewV2: true,
  switchCompatibility: false,
  actionContextV2: false,
  rpcDelegationV2: false,
  minimumClientVersion: null,
  enforceMinimumClient: false,
})

/** A code row as the DELETE … RETURNING reads it, minted against `provider`. */
function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    team_id: null,
    code_challenge: s256Challenge(CODE_VERIFIER),
    registration_id: provider.registrationId,
    configuration_generation: provider.configurationGeneration,
    ...overrides,
  }
}

/** A transaction whose only statement is the code's delete; any other statement fails the test. */
function transactionReturning(row: ReturnType<typeof codeRow> | undefined) {
  const query = vi.fn(async (text: string, _values?: unknown[]) => {
    if (!text.includes('DELETE FROM oidc_desktop_sign_in_codes')) {
      throw new Error('the stand-in transaction answers only the code delete')
    }
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
  })
  const transaction = <T>(work: (db: DbTransactionClient) => Promise<T>) =>
    work({ query } as unknown as DbTransactionClient)
  return { query, transaction }
}

function redeemWith(
  transaction: ReturnType<typeof transactionReturning>['transaction'],
  overrides: Partial<Parameters<typeof redeemDesktopSignInCode>[0]> = {}
) {
  return redeemDesktopSignInCode(
    {
      code: DESKTOP_CODE,
      codeVerifier: CODE_VERIFIER,
      provider,
      contract: 'v1',
      sessionPolicy,
      ...overrides,
    },
    { transaction }
  )
}

describe('redeemDesktopSignInCode before the account is read', () => {
  it('answers an unknown code as invalid_code without a verifier mismatch', async () => {
    const { query, transaction } = transactionReturning(undefined)

    await expect(redeemWith(transaction)).resolves.toEqual({
      status: 'invalid_code',
      verifierMismatch: false,
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![1]).toEqual([hashDesktopSignInCode(DESKTOP_CODE)])
  })

  it('flags a wrong verifier on invalid_code', async () => {
    const { query, transaction } = transactionReturning(codeRow())

    await expect(
      redeemWith(transaction, { codeVerifier: 'fixture-wrong-verifier-'.padEnd(43, 'w') })
    ).resolves.toEqual({ status: 'invalid_code', verifierMismatch: true })
    // The code was found: the mismatch is the verifier's, not an unknown code.
    expect(query).toHaveBeenCalledTimes(1)
  })
})
