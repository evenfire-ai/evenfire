import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LIMITS as GROK_LIMITS } from '@clerum/grok-provider-attempt-contract'
import { LIMITS as CODEX_LIMITS } from '@clerum/llm-provider-attempt-contract'
import { AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES } from '../src/services/llmProviderAttemptAuthorizer.js'

const AUTHORIZE_LOCATION = 'location = /api/v1/mcp-host/llm/provider-attempts/authorize {'

/** The body of one nginx `location` block, from its opening line to its closing brace. */
function locationBlock(config: string, opening: string): string {
  const start = config.indexOf(opening)
  expect(start, `configmaps.yaml must declare ${opening}`).toBeGreaterThanOrEqual(0)
  const end = config.indexOf('\n        }', start)
  expect(end).toBeGreaterThan(start)
  return config.slice(start, end)
}

describe('LLM authorize route body limit (#731 R3-3)', () => {
  it('T-R3-3d sets the gateway body limit to the request cap plus the envelope allowance', () => {
    const config = readFileSync(
      new URL('../../deploy/base/control-plane/configmaps.yaml', import.meta.url),
      'utf-8'
    )
    const block = locationBlock(config, AUTHORIZE_LOCATION)
    // Witness: this is the block that proxies to control-api.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    const directive = /client_max_body_size\s+(\d+);/.exec(block)
    expect(
      directive,
      'the authorize location must set client_max_body_size in bytes'
    ).not.toBeNull()
    // Without the directive nginx applies its 1m default and refuses a
    // contract-valid request before control-api sees it.
    const cap = Math.max(CODEX_LIMITS.maxRequestBodyBytes, GROK_LIMITS.maxRequestBodyBytes)
    expect(Number(directive![1])).toBe(cap + AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES)
  })
})
