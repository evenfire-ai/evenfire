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

  it('injects even though the #637 filter would DENY a recipe-declared reference', () => {
    // The credential is unlabeled to the ownership model, so a recipe naming it is denied.
    // Injection happens after that filter, so the workload still gets a working pull —
    // and exactly once.
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

  it('injects past a denied recipe-declared reference', () => {
    const access = new Map<string, SecretAccess>([
      [EVENFIRE_REGISTRY_PULL_SECRET_NAME, { state: 'denied' }],
    ])
    expect(
      mcpPullNames({ imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME] }, access)
    ).toEqual([EVENFIRE_REGISTRY_PULL_SECRET_NAME])
  })
})
