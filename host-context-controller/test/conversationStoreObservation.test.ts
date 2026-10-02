import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  CANONICAL_STORE_REASON_EXITS,
  computeConversationStoreTemplateRevision,
  conversationStoreAttemptKey,
  conversationStoreInitBindingMatches,
  isCanonicalSuccessOutcome,
  resolveConversationStoreOwnerChain,
  validateConversationStoreOperationSemantics,
  verifyConversationStoreInitOutcome,
} from '../src/conversationStoreObservation'

function deployment(): k8s.V1Deployment {
  return {
    metadata: {
      name: 'alpha-host',
      uid: 'deploy-uid-1',
      annotations: { 'clerum.io/host-uid': 'host-uid-1' },
    },
  } as k8s.V1Deployment
}

function replicaSet(deploymentUid: string): k8s.V1ReplicaSet {
  return {
    metadata: {
      name: 'alpha-host-rs',
      uid: 'rs-uid-1',
      ownerReferences: [{ uid: deploymentUid, controller: true }],
    },
  } as k8s.V1ReplicaSet
}

function pod(rsUid: string, podUid: string): k8s.V1Pod {
  return {
    metadata: {
      name: 'alpha-host-pod',
      uid: podUid,
      ownerReferences: [{ uid: rsUid, controller: true }],
    },
  } as k8s.V1Pod
}

describe('canonical conversation-store observation (#825)', () => {
  it('accepts a coherent ok termination outcome', () => {
    const verified = verifyConversationStoreInitOutcome(
      '{"outcome":"ok","reason":"Created","layoutVersion":1,"storeId":"11111111-1111-4111-8111-111111111111"}',
      0
    )
    expect(verified.valid).toBe(true)
    expect(verified.parsed?.storeId).toBe('11111111-1111-4111-8111-111111111111')
    expect(isCanonicalSuccessOutcome(verified.parsed!)).toBe(true)
  })

  it('accepts a coherent blocked outcome with its closed exit code', () => {
    const verified = verifyConversationStoreInitOutcome(
      '{"outcome":"blocked","reason":"WriterFenceBusy"}',
      CANONICAL_STORE_REASON_EXITS.WriterFenceBusy
    )
    expect(verified.valid).toBe(true)
    expect(verified.parsed?.outcome).toBe('blocked')
    expect(isCanonicalSuccessOutcome(verified.parsed!)).toBe(false)
  })

  it('classifies exit/reason incoherence as InitOutcomeMismatch', () => {
    const verified = verifyConversationStoreInitOutcome(
      '{"outcome":"ok","reason":"Created","layoutVersion":1,"storeId":"11111111-1111-4111-8111-111111111111"}',
      3
    )
    expect(verified).toMatchObject({ valid: false, reason: 'InitOutcomeMismatch' })
  })

  it('classifies unknown termination data as InitFailedUnclassified', () => {
    expect(verifyConversationStoreInitOutcome('not json at all', 1)).toMatchObject({
      valid: false,
      reason: 'InitFailedUnclassified',
    })
    expect(
      verifyConversationStoreInitOutcome('{"outcome":"ok","reason":"MadeUp"}', 0)
    ).toMatchObject({
      valid: false,
      reason: 'InitFailedUnclassified',
    })
    expect(verifyConversationStoreInitOutcome(undefined, 1)).toMatchObject({
      valid: false,
      reason: 'InitFailedUnclassified',
    })
  })

  it('rejects prototype reason names, absent exit proof, invalid store identity and oversized messages', () => {
    expect(
      verifyConversationStoreInitOutcome('{"outcome":"blocked","reason":"constructor"}', 3).valid
    ).toBe(false)
    expect(
      verifyConversationStoreInitOutcome('{"outcome":"ok","reason":"AlreadyCanonical"}', undefined)
        .valid
    ).toBe(false)
    expect(
      verifyConversationStoreInitOutcome(
        '{"outcome":"ok","reason":"AlreadyCanonical","layoutVersion":1,"storeId":"wrong"}',
        0
      ).valid
    ).toBe(false)
    expect(
      verifyConversationStoreInitOutcome(
        JSON.stringify({ outcome: 'ok', reason: 'NoCollision', extra: 'x'.repeat(4096) }),
        0
      ).valid
    ).toBe(false)
  })

  it('deduplicates attempts by podUID, container, restartCount and finishedAt', () => {
    const a = conversationStoreAttemptKey(
      'pod-1',
      'canonical-store-init',
      2,
      '2026-01-01T00:00:00Z'
    )
    const same = conversationStoreAttemptKey(
      'pod-1',
      'canonical-store-init',
      2,
      '2026-01-01T00:00:00Z'
    )
    const retry = conversationStoreAttemptKey(
      'pod-1',
      'canonical-store-init',
      3,
      '2026-01-01T00:01:00Z'
    )
    const otherPod = conversationStoreAttemptKey(
      'pod-2',
      'canonical-store-init',
      2,
      '2026-01-01T00:00:00Z'
    )
    expect(new Set([a, same]).size).toBe(1)
    expect(new Set([a, retry, otherPod]).size).toBe(3)
  })

  it('resolves the exact HostUID->DeploymentUID->RSUID->PodUID owner chain', () => {
    const rs = replicaSet('deploy-uid-1')
    const p = pod('rs-uid-1', 'pod-uid-1')
    const chain = resolveConversationStoreOwnerChain({
      hostUid: 'host-uid-1',
      deployment: deployment(),
      replicaSets: [rs],
      pods: [p, pod('foreign-rs', 'pod-uid-2')],
    })
    expect(chain.ok).toBe(true)
    if (chain.ok) expect(chain.pods.map(entry => entry.pod.metadata?.uid)).toEqual(['pod-uid-1'])
  })

  it('rejects a foreign ReplicaSet or a stale HostUID annotation', () => {
    expect(
      resolveConversationStoreOwnerChain({
        hostUid: 'host-uid-1',
        deployment: deployment(),
        replicaSets: [replicaSet('other-deployment')],
        pods: [pod('rs-uid-1', 'pod-uid-1')],
      })
    ).toMatchObject({ ok: false })
    const stale = deployment()
    stale.metadata!.annotations!['clerum.io/host-uid'] = 'host-uid-other'
    expect(
      resolveConversationStoreOwnerChain({
        hostUid: 'host-uid-1',
        deployment: stale,
        replicaSets: [replicaSet('deploy-uid-1')],
        pods: [pod('rs-uid-1', 'pod-uid-1')],
      })
    ).toMatchObject({ ok: false })
  })

  it('requires exact HostUID/PVCUID binding pins on the observed init container', () => {
    const init = {
      name: 'canonical-store-init',
      env: [
        { name: 'CLERUM_HOST_UID', value: 'host-uid-1' },
        { name: 'CLERUM_PVC_UID', value: 'pvc-uid-9' },
      ],
    } as k8s.V1Container
    expect(conversationStoreInitBindingMatches(init, 'host-uid-1', 'pvc-uid-9')).toBe(true)
    expect(conversationStoreInitBindingMatches(init, 'host-uid-1', 'pvc-other')).toBe(false)
  })

  it('computes a templateRevision stable across credential churn but not storage changes', () => {
    const base = {
      image: 'img@sha256:aaa',
      layoutVersion: 1 as const,
      workspaceSubPath: 'workspace',
      stateSubPath: 'state',
      stateMountPath: '/var/lib/clerum/state',
      sessionStore: 'sqlite',
      sessionDbDir: '/var/lib/clerum/state',
      canonicalRequired: 'true',
      hostUid: 'host-uid-1',
      pvcUid: 'pvc-uid-9',
      initImage: 'img@sha256:aaa',
      initCommand: ['node'],
      initArgs: ['cli.js', 'migrate'],
    }
    expect(computeConversationStoreTemplateRevision(base)).toBe(
      computeConversationStoreTemplateRevision(base)
    )
    expect(computeConversationStoreTemplateRevision(base)).toBe(
      computeConversationStoreTemplateRevision({ ...base })
    )
    expect(computeConversationStoreTemplateRevision(base)).not.toBe(
      computeConversationStoreTemplateRevision({
        ...base,
        image: 'img@sha256:bbb',
        initImage: 'img@sha256:bbb',
      })
    )
    expect(computeConversationStoreTemplateRevision(base)).not.toBe(
      computeConversationStoreTemplateRevision({ ...base, pvcUid: 'pvc-uid-10' })
    )
  })

  it('rejects adoption without fenced/migrating/failed maintenance and enforces pin pairing', () => {
    expect(
      validateConversationStoreOperationSemantics({
        operation: 'adopt',
        maintenancePhase: 'quiescing',
        layoutStoreId: undefined,
        hasMigrationId: true,
        hasManifestHash: true,
        hasCandidateHash: true,
        hasExpectedStoreId: false,
        hasExpectedCurrentCatalogHash: false,
      })
    ).toMatchObject({ valid: false })
    expect(
      validateConversationStoreOperationSemantics({
        operation: 'adopt',
        maintenancePhase: 'fenced',
        layoutStoreId: undefined,
        hasMigrationId: true,
        hasManifestHash: true,
        hasCandidateHash: true,
        hasExpectedStoreId: true,
        hasExpectedCurrentCatalogHash: false,
      })
    ).toMatchObject({ valid: false })
    expect(
      validateConversationStoreOperationSemantics({
        operation: 'adopt',
        maintenancePhase: 'fenced',
        layoutStoreId: '11111111-1111-4111-8111-111111111111',
        hasMigrationId: true,
        hasManifestHash: true,
        hasCandidateHash: true,
        hasExpectedStoreId: false,
        hasExpectedCurrentCatalogHash: false,
      })
    ).toMatchObject({ valid: false })
    expect(
      validateConversationStoreOperationSemantics({
        operation: 'adopt',
        maintenancePhase: 'failed',
        layoutStoreId: undefined,
        hasMigrationId: true,
        hasManifestHash: true,
        hasCandidateHash: true,
        hasExpectedStoreId: false,
        hasExpectedCurrentCatalogHash: false,
      })
    ).toMatchObject({ valid: true })
  })

  it('rejects release without completed maintenance and the current identity pair', () => {
    expect(
      validateConversationStoreOperationSemantics({
        operation: 'release',
        maintenancePhase: 'migrating',
        layoutStoreId: '11111111-1111-4111-8111-111111111111',
        hasMigrationId: true,
        hasManifestHash: true,
        hasCandidateHash: true,
        hasExpectedStoreId: true,
        hasExpectedCurrentCatalogHash: true,
      })
    ).toMatchObject({ valid: false })
    expect(
      validateConversationStoreOperationSemantics({
        operation: 'release',
        maintenancePhase: 'completed',
        layoutStoreId: '11111111-1111-4111-8111-111111111111',
        hasMigrationId: false,
        hasManifestHash: true,
        hasCandidateHash: true,
        hasExpectedStoreId: true,
        hasExpectedCurrentCatalogHash: false,
      })
    ).toMatchObject({ valid: false })
  })
})
