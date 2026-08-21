import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function runtimeAccessProfile(): Map<string, string> {
  const source = readFileSync(
    new URL('../../deploy/scripts/control-api-runtime-access-profiles.tsv', import.meta.url),
    'utf8'
  )
  return new Map(
    source
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('\t') as [string, string])
  )
}

describe('00a0/00a1 Codex subscription persistence', () => {
  const dbSource = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
  const connectionSource = readFileSync(
    new URL('../src/services/codexSubscriptionConnection.ts', import.meta.url),
    'utf8'
  )
  const oauthStateSource = readFileSync(
    new URL('../src/services/codexSubscriptionOAuthState.ts', import.meta.url),
    'utf8'
  )

  it('registers additive migrations after the last published GFS recovery version', () => {
    expect(dbSource).toContain("version: '0099_gfs_upload_finalizing_recovery'")
    expect(dbSource).toContain("version: '00a0_codex_subscription_connections'")
    expect(dbSource).toContain("version: '00a1_codex_subscription_oauth_states'")
    expect(dbSource).toContain("version: '00a4_codex_chatgpt_account_id'")
    expect(dbSource).toContain('apply: applyCodexSubscriptionConnectionSchema')
    expect(dbSource).toContain('apply: applyCodexSubscriptionOAuthStateSchema')
    expect(dbSource).toContain('apply: applyCodexChatgptAccountIdSchema')
    expect(dbSource.indexOf("version: '0099_gfs_upload_finalizing_recovery'")).toBeLessThan(
      dbSource.indexOf("version: '00a0_codex_subscription_connections'")
    )
    expect(dbSource.indexOf("version: '00a0_codex_subscription_connections'")).toBeLessThan(
      dbSource.indexOf("version: '00a1_codex_subscription_oauth_states'")
    )
    expect(dbSource.indexOf("version: '00a3_llm_provider_attempt_tickets'")).toBeLessThan(
      dbSource.indexOf("version: '00a4_codex_chatgpt_account_id'")
    )
    expect(dbSource.indexOf("version: '00a4_codex_chatgpt_account_id'")).toBeLessThan(
      dbSource.indexOf("version: '0100_seed_minimax_allowed_model'")
    )
  })

  it('creates a single active deployment-default connection with ciphertext and revisions', () => {
    expect(connectionSource).toContain('CREATE TABLE IF NOT EXISTS codex_subscription_connections')
    expect(connectionSource).toContain('connection_key TEXT NOT NULL')
    expect(connectionSource).toContain("CHECK (connection_key = 'deployment-default')")
    expect(connectionSource).toContain('refresh_token_encrypted TEXT')
    expect(connectionSource).toContain('access_token_encrypted TEXT')
    expect(connectionSource).toContain('credential_revision BIGINT NOT NULL')
    expect(connectionSource).toContain('catalog_revision BIGINT NOT NULL')
    expect(connectionSource).toContain('account_fingerprint TEXT')
    expect(connectionSource).toContain('chatgpt_account_id_encrypted TEXT')
    expect(connectionSource).toContain('ADD COLUMN IF NOT EXISTS chatgpt_account_id_encrypted')
    expect(connectionSource).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS codex_subscription_connections_active_key'
    )
    expect(connectionSource).toContain('WHERE revoked_at IS NULL')
    expect(connectionSource).toMatch(/AND credential_revision = \$/)
    expect(connectionSource).not.toMatch(/\brefresh_token\b(?!_encrypted)/)
    expect(connectionSource).not.toMatch(/\baccess_token\b(?!_encrypted|_expires_at)/)
    expect(connectionSource).not.toMatch(/cookie/i)
    expect(connectionSource).not.toMatch(/set-cookie/i)
    expect(connectionSource).not.toMatch(/authorization/i)
    expect(connectionSource).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
  })

  it('creates one-time OAuth state/PKCE rows with expiry, consume, cancel, and replacement intent', () => {
    expect(oauthStateSource).toContain('CREATE TABLE IF NOT EXISTS codex_subscription_oauth_states')
    expect(oauthStateSource).toContain("flow TEXT NOT NULL CHECK (flow IN ('browser', 'device'))")
    expect(oauthStateSource).toContain(
      "intent TEXT NOT NULL CHECK (intent IN ('connect', 'reconnect', 'replace'))"
    )
    expect(oauthStateSource).toContain('pkce_verifier_encrypted TEXT')
    expect(oauthStateSource).toContain('device_code_encrypted TEXT')
    expect(oauthStateSource).toContain(
      "status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired', 'cancelled'))"
    )
    expect(oauthStateSource).toContain('expires_at TIMESTAMPTZ NOT NULL')
    expect(oauthStateSource).toContain('consumed_at TIMESTAMPTZ')
    expect(oauthStateSource).toContain('cancelled_at TIMESTAMPTZ')
    expect(oauthStateSource).toContain("status = 'consumed'")
    expect(oauthStateSource).toContain("status = 'pending'")
    expect(oauthStateSource).toContain('expires_at > now()')
    expect(oauthStateSource).not.toMatch(/cookie/i)
    expect(oauthStateSource).not.toMatch(/\bpkce_verifier\b(?!_encrypted)/)
    expect(oauthStateSource).not.toMatch(/\bdevice_code\b(?!_encrypted)/)
    expect(oauthStateSource).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
  })

  it('grants Control API runtime SELECT/INSERT/UPDATE only and never creates a proxy role', () => {
    const schema = `${connectionSource}\n${oauthStateSource}`
    expect(schema).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE codex_subscription_connections FROM PUBLIC'
    )
    expect(schema).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE codex_subscription_oauth_states FROM PUBLIC'
    )
    expect(schema).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE codex_subscription_connections TO control_api_runtime'
    )
    expect(schema).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE codex_subscription_oauth_states TO control_api_runtime'
    )
    expect(schema).toContain(
      'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE codex_subscription_connections FROM control_api_runtime'
    )
    expect(schema).toContain(
      'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE codex_subscription_oauth_states FROM control_api_runtime'
    )
    expect(schema).not.toMatch(/CREATE ROLE/i)
    expect(schema).not.toMatch(/codex.llm.proxy/i)
    expect(schema).not.toMatch(/GRANT .* TO .*proxy/i)
  })

  it('classifies the new relations as upsert in the runtime access contract', () => {
    const profile = runtimeAccessProfile()
    expect(profile.get('codex_subscription_connections')).toBe('upsert')
    expect(profile.get('codex_subscription_oauth_states')).toBe('upsert')
  })
})
