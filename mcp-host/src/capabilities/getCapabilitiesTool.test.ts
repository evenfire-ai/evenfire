import { describe, expect, it } from 'vitest'
import { CAPABILITY_MAP } from './capabilityMap'
import { buildGetCapabilitiesResponse, createGetCapabilitiesTool } from './getCapabilitiesTool'

function envFrom(map: Record<string, string>): (key: string) => string | undefined {
  return key => map[key]
}

describe('clerum__get_capabilities — tool definition', () => {
  it('uses the clerum__ prefix mandated by the spec', () => {
    const tool = createGetCapabilitiesTool(() => undefined)
    expect(tool.name).toBe('clerum__get_capabilities')
  })

  it('declares an empty parameters schema (no inputs)', () => {
    const tool = createGetCapabilitiesTool(() => undefined)
    expect(tool.parameters).toMatchObject({ type: 'object', properties: {} })
  })

  it('returns content (not artifact) on success', async () => {
    const tool = createGetCapabilitiesTool(envFrom({ GITHUB_TOKEN: 'ghp_x' }))
    const result = await tool.execute({}, '/tmp')
    expect(result.success).toBe(true)
    expect(typeof result.content).toBe('string')
    expect(result.artifact).toBeUndefined()
    const parsed = JSON.parse(result.content!)
    expect(parsed.version).toBe('v1')
  })
})

describe('clerum__get_capabilities — presence detection', () => {
  it('reports configured=true when every requires[] key is non-empty', () => {
    const env = envFrom({
      GITHUB_TOKEN: 'ghp_xxx',
      BRAVE_SEARCH_API_KEY: '',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'user@example.com',
      SMTP_PASS: 'p',
    })
    const out = buildGetCapabilitiesResponse(env)
    expect(out.configured.github).toBe(true)
    expect(out.configured.brave_search).toBe(false) // empty value
    expect(out.configured.smtp).toBe(true)
  })

  it('reports configured=false when any single requires[] key is missing', () => {
    const env = envFrom({ SMTP_HOST: 'h', SMTP_USER: 'u' /* SMTP_PASS missing */ })
    const out = buildGetCapabilitiesResponse(env)
    expect(out.configured.smtp).toBe(false)
  })

  it('returns hints for every entry regardless of configured state', () => {
    const out = buildGetCapabilitiesResponse(() => undefined)
    for (const cap of CAPABILITY_MAP) {
      expect(out.hints[cap.name]).toBe(cap.hint)
    }
  })
})

describe('clerum__get_capabilities — secret-never-leaks invariant', () => {
  /**
   * Crucial security invariant: no path in the tool may return a secret
   * value. Even if the env-getter resolves a value, the response should
   * carry a boolean and a static hint, never the value substring.
   */
  it('never echoes a secret value into the response, even when configured', async () => {
    // Pack a deliberately-distinctive value for each provider key so a
    // string-search will catch any leak.
    const secrets: Record<string, string> = {
      GITHUB_TOKEN: 'ghp_distinctive_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      BRAVE_SEARCH_API_KEY: 'BSA-distinctive-BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      SMTP_HOST: 'smtp.distinctive-host.example',
      SMTP_USER: 'distinctive-smtp-user@example',
      SMTP_PASS: 'distinctive-smtp-pass-CCCCCCCCC',
      SLACK_BOT_TOKEN: 'xoxb-distinctive-DDDDDDDDDD',
      SENDGRID_API_KEY: 'SG.distinctive-EEEEEEEEEE',
      // Provider keys (NEVER part of CAPABILITY_MAP) — leak check
      OPENAI_API_KEY: 'sk-distinctive-FFFFFFFFFFFFF',
      CLAUDE_API_KEY: 'sk-ant-distinctive-GGGGGGGG',
      ZAI_API_KEY: 'zai-distinctive-HHHHHHH',
      BAILIAN_API_KEY: 'bailian-distinctive-IIIIII',
    }
    const tool = createGetCapabilitiesTool(envFrom(secrets))
    const result = await tool.execute({}, '/tmp')
    const body = result.content ?? ''
    for (const [key, value] of Object.entries(secrets)) {
      expect(body, `${key} must not appear in tool response`).not.toContain(value)
    }
  })

  it('LLM provider keys are never advertised as capabilities', () => {
    // Every CAPABILITY_MAP entry must NOT require any LLM provider key
    // — those are required for the host itself, not an LLM-visible
    // capability.
    const providerKeys = ['OPENAI_API_KEY', 'CLAUDE_API_KEY', 'ZAI_API_KEY', 'BAILIAN_API_KEY']
    for (const cap of CAPABILITY_MAP) {
      for (const k of cap.requires) {
        expect(providerKeys).not.toContain(k)
      }
    }
  })

  it('hints are static — identical for configured and unconfigured state', () => {
    const out1 = buildGetCapabilitiesResponse(() => undefined)
    const out2 = buildGetCapabilitiesResponse(envFrom({ GITHUB_TOKEN: 'leak-attempt-XYZ' }))
    expect(out1.hints).toEqual(out2.hints)
    expect(JSON.stringify(out2.hints)).not.toContain('leak-attempt-XYZ')
  })
})
