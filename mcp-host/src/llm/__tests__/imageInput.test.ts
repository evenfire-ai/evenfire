/**
 * Issue #654 — host image-input helper: transport/role matrix, the pure
 * intersection, and the operator-facing denial text.
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../core/types'
import {
  type ImageTransportOperation,
  chatTransportSupportsImageInput,
  decideImageInput,
  imageInputDenialMessage,
  imageInputRolesFor,
  imageWireFamilyFor,
  roleSupportsImageInput,
  transportSupportsImageInput,
} from '../imageInput'
import { ALL_PROVIDERS, descriptorFor, isLlmProvider } from '../registryCore'

const METHODS: ImageTransportOperation[] = [
  'complete',
  'completeWithTools',
  'completeAndCache',
  'completeWithToolsAndCache',
]

/** The transport baseline from plan §4.1, restated so a silent edit fails here. */
const EXPECTED_MATRIX: Record<string, Record<ImageTransportOperation, boolean>> = {
  openai: {
    complete: false,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  zai: {
    complete: false,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  azure: {
    complete: false,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  claude: {
    complete: false,
    completeWithTools: true,
    completeAndCache: true,
    completeWithToolsAndCache: true,
  },
  vertex: {
    complete: true,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  bedrock: {
    complete: true,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  'codex-subscription': {
    complete: false,
    completeWithTools: false,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
}

function userImageMessage(): ChatMessage {
  return {
    role: 'user',
    content: 'what is in this image?',
    contentParts: [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ],
  }
}

describe('#654 transport matrix', () => {
  it('matches the documented baseline for every provider family', () => {
    for (const [provider, expected] of Object.entries(EXPECTED_MATRIX)) {
      for (const method of METHODS) {
        expect(`${provider}/${method}=${transportSupportsImageInput(provider, method)}`).toBe(
          `${provider}/${method}=${expected[method]}`
        )
      }
    }
  })

  it('folds the role into the selector', () => {
    expect(transportSupportsImageInput('openai', 'completeWithTools')).toBe(true)
    expect(transportSupportsImageInput('openai', 'completeWithTools', 'tool')).toBe(false)
    expect(transportSupportsImageInput('claude', 'completeWithToolsAndCache', 'tool')).toBe(true)
    expect(transportSupportsImageInput('bedrock', 'complete', 'user')).toBe(true)
    expect(transportSupportsImageInput('bedrock', 'complete', 'assistant')).toBe(false)
  })

  it('pins explicit factory arms and derives the data-driven arm from the descriptor', () => {
    expect(imageWireFamilyFor('openai')).toBe('openai-compatible')
    expect(imageWireFamilyFor('azure')).toBe('openai-compatible')
    expect(imageWireFamilyFor('zai')).toBe('openai-compatible')
    expect(imageWireFamilyFor('claude')).toBe('claude')
    expect(imageWireFamilyFor('codex-subscription')).toBe('codex')
  })

  it('authorizes NO transport for an unregistered or invented provider id', () => {
    expect(isLlmProvider('some-future-provider')).toBe(false)
    expect(imageWireFamilyFor('some-future-provider')).toBe('unregistered')
    for (const operation of METHODS) {
      expect(transportSupportsImageInput('some-future-provider', operation)).toBe(false)
      expect(transportSupportsImageInput('', operation)).toBe(false)
    }
    expect(chatTransportSupportsImageInput('some-future-provider')).toBe(false)
    expect(roleSupportsImageInput('some-future-provider', 'user')).toBe(false)
  })

  it('never authorizes a registered provider that has no real factory coverage', () => {
    // The data-driven arm requires a baseURL; without one `makeProvider` throws,
    // so the projection must not promise images for it either.
    for (const provider of ALL_PROVIDERS) {
      const authorized = chatTransportSupportsImageInput(provider)
      if (!authorized) continue
      const hasDescriptorBaseURL = Boolean(descriptorFor(provider).baseURL)
      const isExplicitArm = ['openai', 'azure', 'claude', 'vertex', 'bedrock'].includes(provider)
      // `provider` is interpolated into the assertion message by the expect
      // failure, so a future divergent provider that inherits coverage fails
      // here with its own id.
      expect(hasDescriptorBaseURL || isExplicitArm).toBe(true)
    }
    expect(chatTransportSupportsImageInput('codex-subscription')).toBe(false)
  })

  it('projects the CHAT operation as tool-bearing, never as the tool-less plain path', () => {
    // The loop always dispatches completeWithTools (empty array included).
    expect(chatTransportSupportsImageInput('openai')).toBe(true)
    expect(chatTransportSupportsImageInput('claude')).toBe(true)
    expect(chatTransportSupportsImageInput('vertex')).toBe(true)
    expect(chatTransportSupportsImageInput('bedrock')).toBe(true)
    // #650 not landed: Codex cannot carry images anywhere yet.
    expect(chatTransportSupportsImageInput('codex-subscription')).toBe(false)
  })

  it('rejects assistant/system images and honors per-family role support', () => {
    expect(roleSupportsImageInput('openai', 'user')).toBe(true)
    expect(roleSupportsImageInput('openai', 'tool')).toBe(false)
    expect(roleSupportsImageInput('claude', 'tool')).toBe(true)
    expect(roleSupportsImageInput('claude', 'assistant')).toBe(false)
    expect(roleSupportsImageInput('vertex', 'assistant')).toBe(false)
    expect(roleSupportsImageInput('codex-subscription', 'user')).toBe(false)
  })
})

describe('#654 imageInputRolesFor', () => {
  it('returns [] for text-only requests and the unique image-bearing roles otherwise', () => {
    expect(imageInputRolesFor([{ role: 'user', content: 'hi' }])).toEqual([])
    expect(imageInputRolesFor([userImageMessage()])).toEqual(['user'])
    expect(
      imageInputRolesFor([
        userImageMessage(),
        {
          role: 'user',
          content: 'again',
          contentParts: [{ type: 'image', mimeType: 'image/jpeg', data: 'BB' }],
        },
        {
          role: 'tool',
          content: 'x',
          contentParts: [{ type: 'image', mimeType: 'image/png', data: 'CC' }],
        },
      ])
    ).toEqual(['user', 'tool'])
    // A text-only content part on a message is not an image.
    expect(
      imageInputRolesFor([
        { role: 'user', content: 'hi', contentParts: [{ type: 'text', text: 'hi' }] },
      ])
    ).toEqual([])
  })
})

describe('#654 decideImageInput intersection', () => {
  const supported = {
    state: 'supported' as const,
    evidence: {
      source: 'curated' as const,
      reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
      checkedAt: '2026-09-16T00:00:00Z',
    },
  }

  it('is supported only when evidence, policy, transport and role are all affirmative', () => {
    expect(
      decideImageInput({
        providerType: 'openai',
        method: 'completeWithTools',
        roles: ['user'],
        capability: supported,
        policyAllowed: true,
      })
    ).toEqual({ state: 'supported', reason: 'supported', evidence: supported.evidence })
  })

  it('keeps `plain` unsupported even when the model evidence says supported', () => {
    // This is the fail-closed cell: the serializer would drop the image.
    expect(
      decideImageInput({
        providerType: 'openai',
        method: 'complete',
        roles: ['user'],
        capability: supported,
        policyAllowed: true,
      })
    ).toEqual({
      state: 'unsupported',
      reason: 'transport_unsupported',
      evidence: supported.evidence,
    })
  })

  it('rejects an image on a role the wire family cannot carry', () => {
    expect(
      decideImageInput({
        providerType: 'openai',
        method: 'completeWithTools',
        roles: ['tool'],
        capability: supported,
        policyAllowed: true,
      })
    ).toEqual({
      state: 'unsupported',
      reason: 'transport_unsupported',
      evidence: supported.evidence,
    })
    expect(
      decideImageInput({
        providerType: 'claude',
        method: 'completeWithToolsAndCache',
        roles: ['tool'],
        capability: supported,
        policyAllowed: true,
      })
    ).toEqual({ state: 'supported', reason: 'supported', evidence: supported.evidence })
  })

  it('treats absent or malformed evidence as unknown, never as support', () => {
    for (const capability of [undefined, null, {}, { state: 'maybe' }, { state: 'supported' }]) {
      expect(
        decideImageInput({
          providerType: 'openai',
          method: 'completeWithTools',
          roles: ['user'],
          capability,
          policyAllowed: true,
        })
      ).toEqual({ state: 'unknown', reason: 'model_unknown' })
    }
  })

  it('reports policy denial ahead of evidence and transport', () => {
    expect(
      decideImageInput({
        providerType: 'codex-subscription',
        method: 'completeWithTools',
        roles: ['user'],
        capability: undefined,
        policyAllowed: false,
      })
    ).toEqual({ state: 'unsupported', reason: 'policy_denied' })
  })

  it('evaluates freshness against an injected clock', () => {
    const expiring = {
      state: 'supported' as const,
      evidence: {
        source: 'discovery' as const,
        reference: 'evidence:models-dev/glm-5.3-flash',
        checkedAt: '2026-09-01T00:00:00Z',
        validUntil: '2026-10-01T00:00:00Z',
      },
    }
    const before = Date.parse('2026-09-16T00:00:00Z')
    expect(
      decideImageInput({
        providerType: 'zai',
        method: 'completeWithTools',
        roles: ['user'],
        capability: expiring,
        policyAllowed: true,
        now: before,
      }).state
    ).toBe('supported')
    expect(
      decideImageInput({
        providerType: 'zai',
        method: 'completeWithTools',
        roles: ['user'],
        capability: expiring,
        policyAllowed: true,
        now: Date.parse('2026-10-02T00:00:00Z'),
      })
    ).toEqual({
      state: 'unknown',
      reason: 'evidence_expired',
      validUntil: '2026-10-01T00:00:00Z',
      evidence: expiring.evidence,
    })
  })
})

describe('#654 denial messages', () => {
  it('names the real pair and states that the rest of the message was not sent', () => {
    for (const reason of [
      'policy_denied',
      'transport_unsupported',
      'model_unsupported',
      'model_unknown',
      'evidence_expired',
      'evidence_not_yet_valid',
    ] as const) {
      const message = imageInputDenialMessage(
        { state: reason === 'model_unsupported' ? 'unsupported' : 'unknown', reason },
        { provider: 'zai', model: 'glm-5.3' }
      )
      expect(message).toContain('zai/glm-5.3')
      expect(message).toContain('not sent to the provider')
      expect(message).not.toContain('base64')
    }
  })
})
