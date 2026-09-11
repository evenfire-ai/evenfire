/**
 * Cross-service pin: the broker Service host mcp-host dials for a
 * (hostName, slot) pair must equal the name HCC provisions. Both sides read the
 * SAME contract vectors (tests/contracts/oai-egress-broker-name-vectors.json),
 * so a slotId- or hash-scheme change in @clerum/egress-policy turns this red
 * together with the HCC and package tests instead of drifting silently.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fallbackSlotId } from '@clerum/egress-policy'
import { config } from '../../config'
import { createLLMProvider } from '../index'

/** Read the OpenAI SDK client baseURL the way the registry invariant tests do. */
function effectiveBaseURL(provider: unknown): string {
  return (provider as { client: { baseURL: string } }).client.baseURL
}

type BrokerNameVector = {
  label: string
  hostName: string
  slot: { kind: 'primary' } | { kind: 'fallback'; index: number }
  slotId: string
  brokerName: string
}

const { vectors } = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../../tests/contracts/oai-egress-broker-name-vectors.json'),
    'utf8'
  )
) as { vectors: BrokerNameVector[] }

const LAN_URL = 'http://192.168.1.50:8000/v1'

describe('openai-compatible provider — broker host matches the cross-service vectors', () => {
  it.each(vectors)('dials the broker named per the contract: $label', vector => {
    const saved = config.hostName
    try {
      ;(config as { hostName: string }).hostName = vector.hostName
      const provider = createLLMProvider(
        { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
        { provider: 'openai-compatible', name: 'm', baseURL: LAN_URL },
        vector.slot.kind === 'fallback'
          ? { openaiCompatibleSlotId: fallbackSlotId(vector.slot.index) }
          : undefined
      )
      expect(provider).not.toBeNull()

      const dialedHost = new URL(effectiveBaseURL(provider)).hostname
      expect(dialedHost).toBe(`${vector.brokerName}.${config.llmEgressNamespace}.svc.cluster.local`)
    } finally {
      ;(config as { hostName: string }).hostName = saved
    }
  })
})
