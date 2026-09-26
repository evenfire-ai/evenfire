import { boundOAuthRefreshLockIdleTimeout, withTransaction } from '../db.js'
import type { DbTransactionClient } from '../db.js'
import { getOAuthGrant, lockOAuthGrantForRefresh } from './store.js'
import {
  type GetAccessTokenDeps,
  type GetAccessTokenInput,
  type GetAccessTokenResult,
  REACTIVE_REFRESH_BUFFER_MS,
  getAccessToken,
  isAccessTokenStale,
} from './tokenHelper.js'

// Lives OUTSIDE tokenHelper.ts on purpose. `config.ts` imports tokenHelper.ts
// (for REACTIVE_REFRESH_BUFFER_MS), so a value import of db.ts INTO tokenHelper
// would close a config → tokenHelper → db → …/llmProviderAttemptStore → config
// initialization cycle and leave `config` in the TDZ at boot. The reactive
// wrapper needs db.ts (withTransaction + the carrier idle timeout), so it sits in
// its own module that nothing on the config init path imports.

export interface GetAccessTokenReactiveDeps extends GetAccessTokenDeps {
  /**
   * Runs `work` inside a short transaction. Default: `withTransaction` from db.ts
   * (module pool). Injectable for tests. The provided client is transaction-scoped
   * so it can take the row lock and bound the carrier's idle timeout.
   */
  runInTransaction?: <T>(work: (txDb: DbTransactionClient) => Promise<T>) => Promise<T>
}

/**
 * Reactive entry point to the refresh engine — the one the four on-demand token
 * routes call. Serializes the `read → refresh → persist` critical section per grant
 * so a rotating refresh token is POSTed exactly once even under P↔R / R↔R
 * concurrency (mini-spec 16, R2-M1).
 *
 * Two paths:
 *  - FAST-PATH: a loose-pool read; a valid (non-stale) token, or a stale token
 *    with no refresh token, returns WITHOUT opening a transaction or taking a lock
 *    (~99% of calls pay nothing). A stale-but-no-refresh-token grant degrades to
 *    `no_grant` (re-consent) with nothing to serialize.
 *  - SLOW-PATH (stale + has refresh token): open a tx, take a BLOCKING `FOR UPDATE`
 *    on the grant row, bound the carrier's idle timeout, then run the engine on the
 *    SAME tx client. The engine re-reads under the lock (its first line is
 *    `getOAuthGrant`), so if a proactive or concurrent reactive refresh already
 *    rotated the token while we waited, we return the fresh token and issue NO POST.
 *
 * Return type is identical to {@link getAccessToken}, so callers' `switch` is
 * unchanged.
 */
export async function getAccessTokenReactive(
  input: GetAccessTokenInput,
  deps: GetAccessTokenReactiveDeps
): Promise<GetAccessTokenResult> {
  // FAST-PATH: loose read, no tx, no lock.
  const grant = await getOAuthGrant(deps.db, deps.encryptionKey, input)
  if (!grant) return { kind: 'no_grant' }
  const refreshBufferMs = deps.refreshBufferMs ?? REACTIVE_REFRESH_BUFFER_MS
  if (!isAccessTokenStale(grant, refreshBufferMs)) {
    return { kind: 'ok', accessToken: grant.accessToken, expiresAt: grant.accessTokenExpiresAt }
  }
  // Stale with no refresh token → re-consent; nothing to serialize.
  if (!grant.refreshToken) return { kind: 'no_grant' }

  // SLOW-PATH: serialize the refresh under a per-grant row lock.
  const runInTransaction = deps.runInTransaction ?? withTransaction
  return runInTransaction(async txDb => {
    await lockOAuthGrantForRefresh(txDb, input)
    await boundOAuthRefreshLockIdleTimeout(txDb)
    // The engine re-reads the grant under the lock (double-check): if it is no
    // longer stale, it returns `ok` without POSTing. `requireBackground` flows
    // through `input` untouched.
    return getAccessToken(input, { ...deps, db: txDb })
  })
}
