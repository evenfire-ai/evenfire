/**
 * Platform image-pull credential injection.
 *
 * control-api provisions `evenfire-registry-pull` and labels it
 * `clerum.io/managed-by=control-api` only — which is *unlabeled* to the Issue #637
 * ownership model. That is deliberate: it means a recipe can neither project it nor mount
 * it as an envSecret. WRC therefore INJECTS the reference itself, after the ownership
 * filter, for any workload whose image is hosted on our own registry.
 *
 * These tests pin both halves: the injection happens for our images, and the credential
 * stays unreachable to recipe-authored references.
 *
 * Layering note — these are BUILDER tests, not reconciler tests. The builders are the
 * normalization layer (filter the declared names, then append ours exactly once). The
 * authoritative gate for a recipe that declares the reserved name lives one level up, in
 * the reconciler's ownership pass: a `denied` imagePullSecrets ref denies the whole
 * WORKLOAD, which is then torn down rather than rendered. Cases below that feed the
 * builders a `denied` access map are pinning the lower layer; see each one for how (or
 * whether) production reaches it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '@clerum/workflow-runtime-core'
import type { DeploymentDef, WorkflowRecipeCRD, WorkloadDef } from '../types'
import { buildMcpServerManifest } from './mcpDelegation'
import { type SecretAccess, buildDeployment } from './resourceBuilder'

const REGISTRY_HOST = 'registry.evenfire.ai'
const PLATFORM_IMAGE = `${REGISTRY_HOST}/acme/plugin:1.0`
const FOREIGN_IMAGE = 'ghcr.io/acme/plugin:1.0'

const recipe = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'demo', namespace: 'sandbox-recipes' },
  spec: { workloads: [] },
} as unknown as WorkflowRecipeCRD

function workload(over: Partial<WorkloadDef> = {}): WorkloadDef {
  return { id: 'w1', type: 'deployment', image: PLATFORM_IMAGE, ...over } as WorkloadDef
}

/** Pull-secret names on a built Deployment's pod spec. */
function podPullNames(
  w: Partial<WorkloadDef> = {},
  access?: ReadonlyMap<string, SecretAccess>
): string[] {
  const dep = buildDeployment(workload(w) as DeploymentDef, recipe, 'minimal', access)
  return (dep.spec?.template.spec?.imagePullSecrets ?? []).map(s => s.name as string)
}

/** Pull-secret names on a built McpServer manifest. */
function mcpPullNames(
  w: Partial<WorkloadDef> = {},
  access?: ReadonlyMap<string, SecretAccess>
): string[] {
  const m = buildMcpServerManifest(
    workload({ transport: { type: 'stdio' } as never, ...w }),
    recipe,
    'mcp-server',
    access
  ) as { spec?: { imagePullSecrets?: Array<{ name: string }> } } | null
  return (m?.spec?.imagePullSecrets ?? []).map(s => s.name)
}

let saved: string | undefined

beforeEach(() => {
  saved = process.env.CLERUM_REGISTRY_URL
  process.env.CLERUM_REGISTRY_URL = `https://${REGISTRY_HOST}`
})

afterEach(() => {
  if (saved === undefined) delete process.env.CLERUM_REGISTRY_URL
  else process.env.CLERUM_REGISTRY_URL = saved
})

describe('pod template — platform pull secret injection', () => {
  it('injects the credential for an image on our registry', () => {
    expect(podPullNames()).toEqual([EVENFIRE_REGISTRY_PULL_SECRET_NAME])
  })

  it('does not inject for a third-party image', () => {
    expect(podPullNames({ image: FOREIGN_IMAGE })).not.toContain(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  })

  it('does not inject when no registry is configured', () => {
    process.env.CLERUM_REGISTRY_URL = ''
    expect(podPullNames()).not.toContain(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  })

  it("preserves a recipe's own third-party pull secrets alongside the injected one", () => {
    expect(podPullNames({ imagePullSecrets: ['my-ghcr-creds'] })).toEqual([
      'my-ghcr-creds',
      EVENFIRE_REGISTRY_PULL_SECRET_NAME,
    ])
  })

  it('normalizes a denied recipe-declared reference: stripped, then injected exactly once', () => {
    // Defense-in-depth on the normalization layer — NOT the path a recipe author hits.
    // A recipe that declares the reserved name is denied and TORN DOWN by the reconciler
    // (collectSecretOwnership counts imagePullSecrets refs into deniedWorkloadIds, and the
    // workload is never rendered), so this input does not reach the builder that way.
    // It does reach it via the StatefulSet revocation re-render: teardownDeniedWorkload
    // re-renders the StatefulSet with the denied access map to strip the credential, and
    // that goes through this same shared buildPodTemplate. The property pinned here is
    // that re-entry with a denied map still yields the injected name once, not zero or
    // twice.
    const access = new Map<string, SecretAccess>([
      [EVENFIRE_REGISTRY_PULL_SECRET_NAME, { state: 'denied' }],
    ])
    expect(
      podPullNames({ imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME] }, access)
    ).toEqual([EVENFIRE_REGISTRY_PULL_SECRET_NAME])
  })

  it('drops a denied third-party secret while still injecting ours', () => {
    const access = new Map<string, SecretAccess>([['victim-pull', { state: 'denied' }]])
    expect(podPullNames({ imagePullSecrets: ['victim-pull'] }, access)).toEqual([
      EVENFIRE_REGISTRY_PULL_SECRET_NAME,
    ])
  })
})

describe('McpServer delegation — platform pull secret injection', () => {
  it('injects for a transport workload on our registry', () => {
    expect(mcpPullNames()).toEqual([EVENFIRE_REGISTRY_PULL_SECRET_NAME])
  })

  it('does not inject for a third-party transport image', () => {
    expect(mcpPullNames({ image: FOREIGN_IMAGE })).not.toContain(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  })

  it('normalizes a denied recipe-declared reference on the delegation path too', () => {
    // Also defense-in-depth, and more strictly so than the pod-template case: a transport
    // workload with a denied ref is filtered out in preDeployMcpServers before this builder
    // is called, and the reconciler tears the workload down anyway. Kept because
    // buildMcpServerManifest is the last checkpoint before HCC — which materializes
    // spec.imagePullSecrets verbatim — so the filter-then-inject order must hold here
    // independently of the caller that happens to guard it today.
    const access = new Map<string, SecretAccess>([
      [EVENFIRE_REGISTRY_PULL_SECRET_NAME, { state: 'denied' }],
    ])
    expect(
      mcpPullNames({ imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME] }, access)
    ).toEqual([EVENFIRE_REGISTRY_PULL_SECRET_NAME])
  })
})
