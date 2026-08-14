/**
 * Hook resolution tests (spec §8.2). Drives `resolveGuardrailHookDescriptors`
 * with an injected `getLlmHook` so it runs without a cluster. The image-target
 * pod-key derivation is asserted against host-context-controller's real output
 * for the redis@…:6379 hook (`b09ff9ee0137b344`) to guard the byte-match.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GuardrailsConfig } from '../core/guardrails/config'
import {
  resolveGuardrailHookDescriptors,
  withResolvedHookDescriptors,
} from '../guardrailHookResolver'
import type { LlmHookCR } from '../k8sClient'

const NS = 'llm-hooks'

function guardrails(
  hooks: Record<string, Array<{ id: string; digest?: string }>>
): GuardrailsConfig {
  return { hooks }
}

function deps(crs: Record<string, LlmHookCR | null>) {
  return {
    llmHooksNamespace: NS,
    getLlmHook: vi.fn(async (name: string) => crs[name] ?? null),
  }
}

describe('resolveGuardrailHookDescriptors', () => {
  it('resolves a service-target hook, mapping phases and preserving caps/failMode', async () => {
    const cr: LlmHookCR = {
      metadata: { name: 'h1' },
      spec: {
        target: { service: { name: 'reference-guardrail-hook', namespace: NS, port: 8080 } },
        path: '/moderate-redact',
        lifecyclePoints: ['moderate', 'postCallSuccess'],
        capabilities: ['may_deny', 'may_substitute_result'],
        failMode: 'closed',
        order: 100,
      },
    }
    const out = await resolveGuardrailHookDescriptors(
      guardrails({ moderate: [{ id: 'h1' }], postCallSuccess: [{ id: 'h1' }] }),
      deps({ h1: cr })
    )
    expect(out).toHaveLength(1) // deduped across phases
    expect(out[0]).toMatchObject({
      id: 'h1',
      endpoint: `http://reference-guardrail-hook.${NS}.svc.cluster.local:8080`,
      path: '/moderate-redact',
      lifecyclePoints: ['moderate', 'post_call'],
      capabilities: ['may_deny', 'may_substitute_result'],
      failMode: 'closed',
      order: 100,
    })
  })

  it('derives the image-target Service DNS with the controller pod-key (byte-match)', async () => {
    const cr: LlmHookCR = {
      metadata: { name: 'img' },
      spec: {
        target: {
          image: {
            ref: 'docker.io/library/redis@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2',
            port: 6379,
          },
        },
        lifecyclePoints: ['preCall'],
        capabilities: ['may_deny'],
      },
    }
    const out = await resolveGuardrailHookDescriptors(
      guardrails({ preCall: [{ id: 'img' }] }),
      deps({ img: cr })
    )
    expect(out[0].endpoint).toBe(`http://llmhook-b09ff9ee0137b344.${NS}.svc.cluster.local:6379`)
    expect(out[0].lifecyclePoints).toEqual(['pre_call'])
  })

  it('does NOT resolve a remote-target hook (disabled pending SSRF-guarded transport, §8.3)', async () => {
    const cr: LlmHookCR = {
      metadata: { name: 'r' },
      spec: {
        target: { remote: { baseUrl: 'https://hooks.example.com' } },
        lifecyclePoints: ['preCall'],
        capabilities: ['may_deny'],
      },
    }
    const out = await resolveGuardrailHookDescriptors(
      guardrails({ preCall: [{ id: 'r' }] }),
      deps({ r: cr })
    )
    // Fail-closed: the external dial is not enabled until the SSRF guard lands.
    expect(out).toEqual([])
  })

  it('skips a dangling reference (CR not found)', async () => {
    const out = await resolveGuardrailHookDescriptors(
      guardrails({ preCall: [{ id: 'missing' }] }),
      deps({ missing: null })
    )
    expect(out).toEqual([])
  })

  it('skips an image hook whose reconciled digest no longer matches the ref (fail-closed)', async () => {
    const cr: LlmHookCR = {
      metadata: { name: 'img' },
      spec: {
        target: { image: { ref: 'repo/img@sha256:new', port: 8080 } },
        lifecyclePoints: ['preCall'],
      },
      status: { observedDigest: 'sha256:new' },
    }
    const out = await resolveGuardrailHookDescriptors(
      guardrails({ preCall: [{ id: 'img', digest: 'sha256:OLD' }] }),
      deps({ img: cr })
    )
    expect(out).toEqual([])
  })

  it('drops unknown capabilities and hooks with no known lifecycle points', async () => {
    const good: LlmHookCR = {
      spec: {
        target: { service: { name: 's', namespace: NS, port: 80 } },
        lifecyclePoints: ['moderate'],
        capabilities: ['may_deny', 'not_a_capability' as never],
      },
    }
    const noPoints: LlmHookCR = {
      spec: { target: { service: { name: 's', namespace: NS, port: 80 } }, lifecyclePoints: [] },
    }
    const out = await resolveGuardrailHookDescriptors(
      guardrails({ moderate: [{ id: 'good' }, { id: 'noPoints' }] }),
      deps({ good, noPoints })
    )
    expect(out).toHaveLength(1)
    expect(out[0].capabilities).toEqual(['may_deny'])
  })
})

describe('withResolvedHookDescriptors', () => {
  it('merges resolved descriptors while preserving inline descriptors and other blocks', () => {
    const inline = {
      id: 'inline',
      endpoint: 'http://x',
      path: '/',
      lifecyclePoints: ['pre_call' as const],
      capabilities: [],
      failMode: 'open' as const,
      order: 0,
    }
    const base: GuardrailsConfig = {
      builtins: [{ type: 'prompt-shaping' }],
      hookDescriptors: [inline],
    }
    const merged = withResolvedHookDescriptors(base, [{ ...inline, id: 'resolved' }])
    expect(merged?.builtins).toEqual([{ type: 'prompt-shaping' }])
    expect(merged?.hookDescriptors?.map(d => d.id)).toEqual(['inline', 'resolved'])
  })

  it('returns undefined when there is nothing to apply', () => {
    expect(withResolvedHookDescriptors(undefined, [])).toBeUndefined()
  })
})
