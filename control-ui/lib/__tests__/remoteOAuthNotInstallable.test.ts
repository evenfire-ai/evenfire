import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { remoteOAuthNotInstallableHint } from '../oauthInstall'

/**
 * control-api is not importable from this package, and its reason list is a type, so the
 * list is read from the producer's source: a reason added there without copy here fails.
 */
function producerReasons(): string[] {
  const source = readFileSync(
    resolve(__dirname, '../../../control-api/src/routes/admin/catalogRemoteOAuth.ts'),
    'utf8'
  )
  const union = /export type RemoteOAuthInvalidReason =([\s\S]*?)\n\n/.exec(source)
  if (!union) throw new Error('RemoteOAuthInvalidReason not found in control-api')
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map(match => match[1])
}

const GENERIC = remoteOAuthNotInstallableHint('a_reason_nobody_emits')

describe('remoteOAuthNotInstallableHint', () => {
  it('has dedicated copy for every reason control-api can emit', () => {
    const reasons = producerReasons()
    expect(reasons).toContain('setup_guide_required')
    const missing = reasons.filter(reason => remoteOAuthNotInstallableHint(reason) === GENERIC)
    expect(missing).toEqual([])
  })

  it('has dedicated copy for the console-side reasons, which are not the curator to fix', () => {
    for (const reason of ['unresolved', 'malformed_response']) {
      expect(remoteOAuthNotInstallableHint(reason)).not.toBe(GENERIC)
      expect(remoteOAuthNotInstallableHint(reason)).not.toMatch(/curator/)
    }
  })

  it('falls back to a generic message for an unknown, missing or prototype-key reason', () => {
    expect(remoteOAuthNotInstallableHint(undefined)).toBe(GENERIC)
    expect(remoteOAuthNotInstallableHint('constructor')).toBe(GENERIC)
    expect(GENERIC).toMatch(/Marketplace curator/)
  })
})
