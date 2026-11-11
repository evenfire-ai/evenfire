import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { register } from 'prom-client'
import {
  hashGrokCompletionRequest,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import {
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import { logger } from '../../logger'
import { installLoopbackOnlyNetwork } from './loopbackOnlyNetwork'
import { ARMS, cleanupTransports } from './providerTransportFixtures'

// Issue #1433, owner requirement: every provider arm makeProvider builds sends
// only well-formed text on its real transport. Each arm runs its real SDK or
// proxy client; only the last hop is local (see providerTransportFixtures).

const HIGH = '\uD83D'
const LONE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i
const FFFD = '�'

function allWellFormed(value: unknown): boolean {
  if (typeof value === 'string') return value.isWellFormed()
  if (Array.isArray(value)) return value.every(allWellFormed)
  if (value && typeof value === 'object') {
    return Object.entries(value).every(([k, v]) => k.isWellFormed() && allWellFormed(v))
  }
  return true
}

async function counterValue(provider: string, role: string): Promise<number> {
  const metric = register.getSingleMetric('clerum_llm_request_text_repaired_total')
  if (!metric) return 0
  const { values } = await metric.get()
  return values.find(v => v.labels.provider === provider && v.labels.role === role)?.value ?? 0
}

/** The server re-derivation of a subscription request hash, as T3 does. */
const SERVER_HASH: Record<string, (request: unknown) => string> = {
  'codex-subscription': request => {
    const parsed = parseCodexCompletionRequestV1(request)
    if (!parsed.ok) throw new Error(parsed.message)
    return hashCodexCompletionRequestV1(parsed.value)
  },
  'grok-subscription': request => {
    const parsed = parseGrokCompletionRequestV1(request)
    if (!parsed.ok) throw new Error(parsed.message)
    return hashGrokCompletionRequest(parsed.value)
  },
}

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'read the page' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', name: 'page_read', arguments: { id: 'p1' } }],
  },
  { role: 'tool', name: 'page_read', tool_call_id: 'c1', content: `a${HIGH}b` },
]

const TOOLS: ToolDefinition[] = [
  {
    name: 'page_read',
    description: `Read${HIGH}`,
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

beforeEach(() => {
  installLoopbackOnlyNetwork()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupTransports()
})

it('the loopback-only guard refuses a non-loopback connection (witness)', () => {
  expect(() => net.connect({ host: '203.0.113.1', port: 9 })).toThrow(/loopback-only test network/)
})

describe('every makeProvider arm sends the repaired request on its transport (#1433)', () => {
  it.each(ARMS)('$id', async arm => {
    const fixture = await arm.make(arm.success)
    const warn = vi.spyOn(logger, 'warn')
    const toolBefore = await counterValue(arm.id, 'tool')
    const definitionBefore = await counterValue(arm.id, 'tool_definition')

    const result = await fixture.provider.completeSingleTurnWithTools(MESSAGES, TOOLS)

    expect(result.content).toBe('ok')
    expect(fixture.bodies).toHaveLength(1)
    const body = fixture.bodies[0]
    expect(body).not.toMatch(LONE_ESCAPE)
    expect(allWellFormed(JSON.parse(body))).toBe(true)
    expect(body).toContain(`a${FFFD}b`)
    expect(body).toContain(`Read${FFFD}`)

    const repairs = warn.mock.calls
      .filter(([, msg]) => /lone UTF-16 surrogates/.test(String(msg)))
      .map(([fields]) => fields)
    expect(repairs).toHaveLength(2)
    expect(repairs).toContainEqual({
      component: 'LLM',
      provider: arm.id,
      role: 'tool',
      toolName: 'page_read',
      toolCallId: 'c1',
      repairedUnits: 1,
    })
    expect(repairs).toContainEqual({
      component: 'LLM',
      provider: arm.id,
      role: 'tool_definition',
      toolName: 'page_read',
      repairedUnits: 1,
    })
    expect(await counterValue(arm.id, 'tool')).toBe(toolBefore + 1)
    expect(await counterValue(arm.id, 'tool_definition')).toBe(definitionBefore + 1)

    if (fixture.authorized) {
      // The authorizer saw the repaired request, and its hash is the one the
      // server re-derives and the proxy carries.
      expect(fixture.authorized).toHaveLength(1)
      const [{ request, requestHash }] = fixture.authorized
      expect(SERVER_HASH[arm.id](JSON.parse(JSON.stringify(request)))).toBe(requestHash)
      const wire = JSON.parse(body) as { requestHash: string; request: unknown }
      expect(wire.requestHash).toBe(requestHash)
      expect(wire.request).toEqual(JSON.parse(JSON.stringify(request)))
    }
    if (fixture.authHops) expect(fixture.authHops()).toBe(1)
  })
})
