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

describe('00a2/00a3 LLM provider-attempt ledger', () => {
  const dbSource = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
  const storeSource = readFileSync(
    new URL('../src/services/llmProviderAttemptStore.ts', import.meta.url),
    'utf8'
  )
  const ticketSource = readFileSync(
    new URL('../src/services/llmProviderAttemptTicket.ts', import.meta.url),
    'utf8'
  )
  const receiptSource = readFileSync(
    new URL('../src/services/llmProviderAttemptReceipt.ts', import.meta.url),
    'utf8'
  )

  it('registers additive migrations after the Codex OAuth state version', () => {
    expect(dbSource).toContain("version: '00a1_codex_subscription_oauth_states'")
    expect(dbSource).toContain("version: '00a2_llm_provider_attempts'")
    expect(dbSource).toContain("version: '00a3_llm_provider_attempt_tickets'")
    expect(dbSource).toContain('apply: applyLlmProviderAttemptSchema')
    expect(dbSource).toContain('apply: applyLlmProviderAttemptTicketSchema')
    expect(dbSource.indexOf("version: '00a1_codex_subscription_oauth_states'")).toBeLessThan(
      dbSource.indexOf("version: '00a2_llm_provider_attempts'")
    )
    expect(dbSource.indexOf("version: '00a2_llm_provider_attempts'")).toBeLessThan(
      dbSource.indexOf("version: '00a3_llm_provider_attempt_tickets'")
    )
  })

  it('registers the unique SDK-attempt link after the latest Codex OAuth owner migration', () => {
    expect(dbSource).toContain("version: '0106_oauth_grants_owner_generalization'")
    expect(dbSource).toContain("version: '0107_llm_provider_attempts_sdk_link'")
    expect(dbSource).toContain("version: '0108_llm_provider_attempts_sdk_link_on_delete_set_null'")
    expect(dbSource).toContain('apply: applyLlmProviderAttemptSdkLinkSchema')
    expect(dbSource).toContain('apply: applyLlmProviderAttemptSdkLinkOnDeleteSetNullSchema')
    expect(dbSource.indexOf("version: '0106_oauth_grants_owner_generalization'")).toBeLessThan(
      dbSource.indexOf("version: '0107_llm_provider_attempts_sdk_link'")
    )
    expect(dbSource.indexOf("version: '0107_llm_provider_attempts_sdk_link'")).toBeLessThan(
      dbSource.indexOf("version: '0108_llm_provider_attempts_sdk_link_on_delete_set_null'")
    )
    expect(storeSource).toContain('plugin_workload_sdk_provider_attempt_id UUID')
    expect(storeSource).toContain('REFERENCES plugin_workload_sdk_provider_attempts(id)')
    expect(storeSource).toContain('ON DELETE SET NULL')
    expect(storeSource).not.toMatch(/ON DELETE CASCADE/i)
    expect(storeSource).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS llm_provider_attempts_sdk_attempt_uidx'
    )
    expect(storeSource).toContain('WHERE plugin_workload_sdk_provider_attempt_id IS NOT NULL')
    expect(storeSource).toContain('loadLlmProviderAttemptBySdkAttemptId')
  })

  it('persists immutable attempt bindings, lifecycle, safe usage, and redacted correlation', () => {
    expect(storeSource).toContain('CREATE TABLE IF NOT EXISTS llm_provider_attempts')
    expect(storeSource).toContain(
      "caller_kind TEXT NOT NULL CHECK (caller_kind IN ('host', 'recipe'))"
    )
    expect(storeSource).toContain('host_ref TEXT NOT NULL')
    expect(storeSource).toContain('recipe_namespace TEXT')
    expect(storeSource).toContain('recipe_name TEXT')
    expect(storeSource).toContain("provider TEXT NOT NULL CHECK (provider = 'codex-subscription')")
    expect(storeSource).toContain('model TEXT NOT NULL')
    expect(storeSource).toContain('request_hash TEXT NOT NULL')
    expect(storeSource).toContain('policy_revision BIGINT NOT NULL')
    expect(storeSource).toContain('policy_hash TEXT NOT NULL')
    expect(storeSource).toContain('budget_reservation_id TEXT NOT NULL')
    expect(storeSource).toContain('connection_revision BIGINT NOT NULL')
    expect(storeSource).toContain(
      "status TEXT NOT NULL CHECK (status IN ('authorized', 'redeemed', 'finalized'))"
    )
    expect(storeSource).toContain(
      "outcome TEXT CHECK (outcome IN ('success', 'canceled', 'error', 'unknown'))"
    )
    expect(storeSource).toContain('usage_input_tokens INTEGER')
    expect(storeSource).toContain('usage_output_tokens INTEGER')
    expect(storeSource).toContain('correlation_id TEXT')
    expect(storeSource).toContain(
      'UNIQUE (invocation_id, attempt_generation, provider_attempt_index)'
    )
    expect(storeSource).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
    expect(storeSource).not.toMatch(/\bprompt\b/i)
    expect(storeSource).not.toMatch(/\bcompletion\b/i)
    expect(storeSource).not.toMatch(/\baccess_token\b/i)
    expect(storeSource).not.toMatch(/\brefresh_token\b/i)
    expect(storeSource).not.toMatch(/\bauthorization\b/i)
    expect(storeSource).not.toMatch(/cookie/i)
    expect(storeSource).not.toMatch(/\bexecution_ticket\b/i)
    expect(storeSource).not.toMatch(/\bheader\b/i)
  })

  it('persists unique jti tickets with issued/redeemed/finalized states and receipt hash', () => {
    expect(storeSource).toContain('CREATE TABLE IF NOT EXISTS llm_provider_attempt_tickets')
    expect(storeSource).toContain('jti UUID PRIMARY KEY')
    expect(storeSource).toContain(
      "status TEXT NOT NULL CHECK (status IN ('issued', 'redeemed', 'finalized'))"
    )
    expect(storeSource).toContain('expires_at TIMESTAMPTZ NOT NULL')
    expect(storeSource).toContain('receipt_hash TEXT')
    expect(storeSource).toContain('status, expires_at')
    expect(ticketSource).toContain("'codex-execution-ticket'")
    expect(ticketSource).toContain('audience: CODEX_EXECUTION_TICKET_AUDIENCE')
    expect(ticketSource).toContain('registerLlmProviderAttemptTicket')
    expect(ticketSource.indexOf('registerLlmProviderAttemptTicket')).toBeLessThan(
      ticketSource.indexOf('jwt.sign')
    )
    expect(receiptSource).toContain("'codex-attempt-receipt.v1'")
    expect(storeSource).not.toMatch(/\bexecution_ticket\b/i)
    expect(storeSource).not.toMatch(/\baccess_token\b/i)
    expect(storeSource).not.toMatch(/\bprompt\b/i)
  })

  it('grants Control API runtime SELECT/INSERT/UPDATE only and never creates a proxy role', () => {
    expect(storeSource).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE llm_provider_attempts TO control_api_runtime'
    )
    expect(storeSource).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE llm_provider_attempt_tickets TO control_api_runtime'
    )
    expect(storeSource).toContain(
      'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE llm_provider_attempts FROM control_api_runtime'
    )
    expect(storeSource).toContain(
      'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE llm_provider_attempt_tickets FROM control_api_runtime'
    )
    expect(storeSource).not.toMatch(/CREATE ROLE/i)
    expect(storeSource).not.toMatch(/codex.llm.proxy/i)
    expect(storeSource).not.toMatch(/GRANT .* TO .*proxy/i)
  })

  it('classifies the new relations as upsert in the runtime access contract', () => {
    const profile = runtimeAccessProfile()
    expect(profile.get('llm_provider_attempts')).toBe('upsert')
    expect(profile.get('llm_provider_attempt_tickets')).toBe('upsert')
  })
})
