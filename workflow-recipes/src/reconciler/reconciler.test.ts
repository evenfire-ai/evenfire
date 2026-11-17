import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { ObjectSerializer } from '@kubernetes/client-node/dist/gen/models/ObjectSerializer'
import { loadAll } from 'js-yaml'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '@clerum/workflow-runtime-core'
import { loadConfig } from '../config'
import {
  WorkflowRecipeWatcher,
  shouldPatchRecipeStatus,
  workflowNeedsOwnershipBackstop,
} from '../k8sClient'
import {
  CronJobDef,
  StatusCondition,
  WorkflowRecipeCRD,
  WorkflowRecipeGfsIntentSpec,
  WorkloadDef,
} from '../types'
import { INHERITED_PARENT_RESOURCES_ANNOTATION } from '../workflow/childRecipeFactory'
import type { CodexExecutionProjection } from '../workflow/codexExecutionProjection'
import { buildCoordinatorGfsNetworkPolicy } from '../workflow/networkPolicyFactory'
import type { NetworkPolicyPassSummary } from '../workflow/pluginWorkloadSdkProvisioner'
import { deriveWorkflowRuntimePlan } from '../workflow/runtimePlan'
import {
  LegacyNetworkPolicyDeletePendingError,
  WorkflowReconciler,
  buildNetworkPolicyConvergedCondition,
  networkPolicyMarkerConditions,
} from '../workflow/workflowReconciler'
import { captureLogger, captureLoggerLevels } from './__tests__/captureLogger'
import { defaultFqdnLookup } from './fqdnResolver'
import { ResourceVanishedAfterConflictError, isRetryableInfraError } from './k8sErrors'
import type { NetworkPolicyFamily } from './networkPolicyConvergence'
import * as brokerIssuer from './oauthBrokerTokenIssuerClient'
import {
  PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
  PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
} from './pluginWorkloadSdkValidator'
import { RecipeEventQueue } from './recipeEventQueue'
import {
  buildStatefulSet,
  buildUiIngressNetworkPolicy,
  buildWorkloadIngressNetworkPolicy,
  resolveResourceName,
  resolveScopedStatefulSetResourceName,
  resolveScopedWorkloadResourceName,
  resolveWorkloadRuntimeResourceName,
} from './resourceBuilder'
import { deniedSecretRevocationDigest } from './secretOwnership'
import {
  TRANSIENT_REQUEUE_BASE_MS,
  WORKFLOW_PROGRESS_REQUEUE_BASE_MS,
  WorkflowRecipeReconciler,
  noSecretBearingWorkloadsRemain,
} from './workflowRecipeReconciler'

// ─── Mock K8s client ────────────────────────────────────────────────

const mockAppsApi = {
  createNamespacedDeployment: vi.fn().mockResolvedValue({}),
  readNamespacedDeployment: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
  deleteNamespacedDeployment: vi.fn().mockResolvedValue({}),
  createNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  readNamespacedStatefulSet: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  patchNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  replaceNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  deleteNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  createNamespacedDaemonSet: vi.fn().mockResolvedValue({}),
  readNamespacedDaemonSet: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedDaemonSet: vi.fn().mockResolvedValue({}),
  deleteNamespacedDaemonSet: vi.fn().mockResolvedValue({}),
}

const mockBatchApi = {
  createNamespacedCronJob: vi.fn().mockResolvedValue({}),
  readNamespacedCronJob: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedCronJob: vi.fn().mockResolvedValue({}),
  deleteNamespacedCronJob: vi.fn().mockResolvedValue({}),
  createNamespacedJob: vi.fn().mockResolvedValue({}),
  readNamespacedJob: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedJob: vi.fn().mockResolvedValue({}),
  deleteNamespacedJob: vi.fn().mockResolvedValue({}),
}

const mockCoreApi = {
  createNamespacedService: vi.fn().mockResolvedValue({}),
  readNamespacedService: vi
    .fn()
    .mockResolvedValue({ metadata: { resourceVersion: '1' }, spec: { clusterIP: '10.0.0.1' } }),
  replaceNamespacedService: vi.fn().mockResolvedValue({}),
  deleteNamespacedService: vi.fn().mockResolvedValue({}),
  deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
  createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
  readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue({ code: 404 }),
  deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
  deleteCollectionNamespacedPod: vi.fn().mockResolvedValue({}),
  deleteNamespacedPod: vi.fn().mockResolvedValue({}),
  createNamespacedSecret: vi.fn().mockResolvedValue({}),
  readNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
  deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
  createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
  readNamespacedConfigMap: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
  deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
}

async function echoPatchedStatus({
  body,
}: {
  body?: { status?: Record<string, unknown> }
}): Promise<{ status: Record<string, unknown> }> {
  return { status: { ...(body?.status ?? {}) } }
}

/**
 * Status merge of the CR-store fakes: top-level keys replace, as before; the
 * issue #1349 run records merge by key as a JSON merge patch does, and a null
 * (top-level or per key) deletes.
 */
function mergeStatusPatch(
  previous: WorkflowRecipeCRD['status'],
  patch: Record<string, unknown> | undefined
): WorkflowRecipeCRD['status'] {
  const previousStatus = (previous ?? {}) as Record<string, unknown>
  const nextStatus: Record<string, unknown> = { ...previousStatus, ...patch }
  for (const recordKey of ['terminalRunTeardown', 'secretOwnershipRevocations']) {
    const patched = patch?.[recordKey]
    if (patched === undefined || patched === null) continue
    const merged: Record<string, unknown> = {
      ...((previousStatus[recordKey] as Record<string, unknown> | undefined) ?? {}),
    }
    for (const [key, value] of Object.entries(patched as Record<string, unknown>)) {
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    nextStatus[recordKey] = merged
  }
  for (const [key, value] of Object.entries(nextStatus)) {
    if (value === null) delete nextStatus[key]
  }
  return nextStatus as unknown as WorkflowRecipeCRD['status']
}

/**
 * Issue #1349 — a one-recipe CR store: the status patch merges into it and
 * GET answers from it, so pass 2 of a test reads what pass 1 stored. A JSON
 * Patch status body (an array) is applied atomically with `applyJsonPatch`; an
 * operation that does not apply throws `{ code: 422 }` and stores nothing. `prune`
 * drops status keys as an API server with an older CRD does; a dotted key
 * (`terminalRunTeardown.noSecretBearingWorkloads`) drops one field of a record.
 * `onGet` is called with a copy of the stored recipe on every GET of it: it
 * returns the object to answer with, returns undefined to answer with the
 * stored one, or throws to fail the read (an object with `code`, as the client
 * throws).
 */
function installRecipeStore(
  recipe: WorkflowRecipeCRD,
  options: {
    prune?: string[]
    onGet?: (stored: WorkflowRecipeCRD) => WorkflowRecipeCRD | undefined
  } = {}
) {
  const live = structuredClone(recipe)
  live.metadata.resourceVersion ??= '1'
  const previousGet = mockCustomApi.getNamespacedCustomObject.getMockImplementation()!
  mockCustomApi.getNamespacedCustomObject.mockImplementation(async args => {
    if (args.plural !== 'workflowrecipes' || args.name !== live.metadata.name) {
      return previousGet(args)
    }
    return options.onGet?.(structuredClone(live)) ?? structuredClone(live)
  })
  mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }) => {
    if (Array.isArray(body)) {
      // A JSON Patch on the status subresource: applied atomically to the stored
      // object; an operation that does not apply (a failed `test`, a missing
      // parent) is a 422, as from the API server, and stores nothing.
      let patched: { status?: Record<string, unknown> }
      try {
        patched = applyJsonPatch({ status: structuredClone(live.status ?? {}) }, body)
      } catch (error) {
        throw { code: 422, message: (error as Error).message }
      }
      const status = patched.status ?? {}
      for (const key of options.prune ?? []) {
        const [field, member] = key.split('.')
        if (member === undefined) delete status[field]
        else delete (status[field] as Record<string, unknown> | undefined)?.[member]
      }
      live.status = status as unknown as WorkflowRecipeCRD['status']
      live.metadata.resourceVersion = String(Number(live.metadata.resourceVersion) + 1)
      return structuredClone(live)
    }
    if (body.metadata?.uid && body.metadata.uid !== live.metadata.uid) throw { code: 409 }
    const patch: Record<string, unknown> = { ...(body.status ?? {}) }
    for (const key of options.prune ?? []) {
      const [field, member] = key.split('.')
      if (member === undefined) {
        delete patch[field]
      } else if (patch[field] && typeof patch[field] === 'object') {
        const record = { ...(patch[field] as Record<string, unknown>) }
        delete record[member]
        patch[field] = record
      }
    }
    live.status = mergeStatusPatch(live.status, patch)
    live.metadata.resourceVersion = String(Number(live.metadata.resourceVersion) + 1)
    return structuredClone(live)
  })
  return { current: () => structuredClone(live) }
}

const mockCustomApi = {
  createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  getNamespacedCustomObject: vi.fn().mockResolvedValue({
    metadata: {
      resourceVersion: '1',
      annotations: { 'clerum.io/network-ready': 'true' },
      labels: { 'clerum.io/recipe': 'test-recipe' },
    },
    status: {
      conditions: [{ type: 'ExternalEgressReady', status: 'True' }],
    },
    spec: { mcpServers: [] },
  }),
  listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  // Issue #1349 — the apiserver returns the stored object; echo the patched status
  // so the reconciler's stored-record check sees what a CRD with the fields stores.
  patchNamespacedCustomObjectStatus: vi.fn().mockImplementation(echoPatchedStatus),
  deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  deleteCollectionNamespacedCustomObject: vi.fn().mockResolvedValue({}),
}

const mockNetworkingApi = {
  createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  deleteCollectionNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
}

const mockVerifyWorkflowRunProvenance = vi.fn().mockResolvedValue('verified')

// Lets the #513 tests below drive the REAL `defaultFqdnLookup` instead of
// fabricating the Error it produces (#567 review, R1-M3). The default
// implementation rejects loudly rather than returning something plausible: every
// other test in this file injects its own `fqdnLookup`, so a call arriving here
// means a test reached for real DNS by accident, and that should fail the test
// rather than resolve against the network or hang.
const { resolve4Mock, resolve6Mock } = vi.hoisted(() => ({
  resolve4Mock: vi.fn(),
  resolve6Mock: vi.fn(),
}))
vi.mock('node:dns/promises', () => ({
  resolve4: resolve4Mock,
  resolve6: resolve6Mock,
}))
// `vi.clearAllMocks()` in beforeEach clears CALLS, not implementations, so this
// default stands for the whole file; the #513 tests override it with
// `mockRejectedValueOnce` so the loud default is back on the next test.
const unexpectedDnsCall = (family: string) => async (host: string) => {
  throw new Error(
    `unexpected real DNS ${family} lookup for "${host}" — inject fqdnLookup in this test`
  )
}
resolve4Mock.mockImplementation(unexpectedDnsCall('A'))
resolve6Mock.mockImplementation(unexpectedDnsCall('AAAA'))

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    makeApiClient: vi.fn().mockImplementation((ApiClass: unknown) => {
      const name = (ApiClass as { name: string }).name
      if (name === 'AppsV1Api') return mockAppsApi
      if (name === 'BatchV1Api') return mockBatchApi
      if (name === 'CustomObjectsApi') return mockCustomApi
      if (name === 'NetworkingV1Api') return mockNetworkingApi
      return mockCoreApi
    }),
  })),
  AppsV1Api: { name: 'AppsV1Api' },
  BatchV1Api: { name: 'BatchV1Api' },
  CoreV1Api: { name: 'CoreV1Api' },
  CustomObjectsApi: { name: 'CustomObjectsApi' },
  NetworkingV1Api: { name: 'NetworkingV1Api' },
  setHeaderMiddleware: vi.fn(() => ({})),
}))

function workflowRecipeOwnerRef(name = 'parent-recipe') {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    name,
    uid: `uid-${name}`,
    controller: true,
    blockOwnerDeletion: true,
  }
}

function liveWorkflowRecipeUid(name?: string): string | undefined {
  if (name === 'test-recipe') return 'uid-123'
  if (name === 'child-run') return 'uid-child'
  if (name === 'parent-recipe') return 'uid-parent-recipe'
  return undefined
}

function makeRecipe(overrides?: Partial<WorkflowRecipeCRD>): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'test-recipe', namespace: 'sandbox-recipes', uid: 'uid-123' },
    spec: {
      workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
    },
    status: { phase: 'approved' },
    ...overrides,
  }
}

function snippetRun(code = 'return { ok: true }') {
  return { type: 'snippet' as const, language: 'typescript' as const, code }
}

function egressStateAnnotations(
  entries: Array<{ fqdn: string; ip: string; port: number }>
): Record<string, string> {
  const now = Date.now()
  return {
    'clerum.io/egress-fqdn-state': JSON.stringify(
      entries.map(entry => ({
        ...entry,
        protocol: 'TCP',
        expiresAt: now + 600_000,
        lastObservedAt: now,
      }))
    ),
    'clerum.io/egress-fqdn-resolved-at': new Date(now).toISOString(),
  }
}

type LiveManifest = { metadata: { name: string } & Record<string, unknown> } & Record<
  string,
  unknown
>

/**
 * Stateful apiserver double for one spec-hash-gated kind. `createOrReplace`
 * reads before it writes, so an object this test never created must read as a
 * 404; one it created or replaced reads back as written, carrying `status` —
 * the same "ready" status the observation path used to get from a static read.
 * `admit` models fields the apiserver assigns on create (a Service's clusterIP).
 *
 * `unseenReplace` says what a PUT to an object the store never held does.
 * `'reject'` answers 404, as the apiserver does. `'accept'` exists for kinds
 * whose tests override `read` to supply a live object with a specific status
 * (the readiness tests): the object exists in that test's model, so its PUT
 * succeeds.
 *
 * `patch`, when given, applies what the apiserver applies for the body it gets.
 * The body is first serialized as the client sends it, so a member whose value
 * is `undefined` is absent from the request, never a deletion. An array body is a JSON Patch (RFC 6902, see {@link applyJsonPatch}): applied
 * atomically to a copy, resourceVersion +1, generation +1 when an operation path
 * starts with `/spec/`. An object body is a strategic merge patch: annotations
 * merge, `spec.template` merges as a pod template does (see
 * {@link strategicMergePodTemplate}: lists merge by key and entries the patch
 * omits are kept), every other top-level `spec` key replaces, resourceVersion
 * +1, generation +1 when the body carries `spec`. A patch to an object the store
 * does not hold answers 404, as the apiserver does, whatever `unseenReplace` says.
 */
function installLiveStore(
  api: {
    read: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    replace: ReturnType<typeof vi.fn>
    patch?: ReturnType<typeof vi.fn>
  },
  status: Record<string, unknown>,
  admit?: (stored: LiveManifest) => void,
  unseenReplace: 'accept' | 'reject' = 'accept'
): void {
  const live = new Map<string, LiveManifest>()
  const key = (namespace: string, name: string) => `${namespace}/${name}`
  api.read
    .mockReset()
    .mockImplementation(async ({ name, namespace }: { name: string; namespace: string }) => {
      const found = live.get(key(namespace, name))
      if (!found) throw { code: 404 }
      return structuredClone(found)
    })
  api.create
    .mockReset()
    .mockImplementation(async ({ namespace, body }: { namespace: string; body: LiveManifest }) => {
      const k = key(namespace, body.metadata.name)
      if (live.has(k)) throw { code: 409 }
      const stored = structuredClone(body)
      stored.metadata = { ...stored.metadata, resourceVersion: '1', generation: 1 }
      admit?.(stored)
      live.set(k, { ...stored, status: structuredClone(status) })
      return {}
    })
  api.replace
    .mockReset()
    .mockImplementation(
      async ({
        name,
        namespace,
        body,
      }: {
        name: string
        namespace: string
        body: LiveManifest
      }) => {
        const k = key(namespace, name)
        const current = live.get(k)
        if (!current && unseenReplace === 'reject') throw { code: 404 }
        if (current && body.metadata.resourceVersion !== current.metadata.resourceVersion) {
          throw { code: 409 }
        }
        const stored = structuredClone(body)
        stored.metadata = {
          ...stored.metadata,
          resourceVersion: String(Number(current?.metadata.resourceVersion ?? '1') + 1),
          generation: 1,
        }
        live.set(k, { ...stored, status: structuredClone(status) })
        return {}
      }
    )
  api.patch?.mockReset().mockImplementation(
    async ({
      name,
      namespace,
      body: requestBody,
    }: {
      name: string
      namespace: string
      body:
        | JsonPatchOperation[]
        | {
            metadata?: { annotations?: Record<string, string> }
            spec?: Record<string, unknown>
          }
    }) => {
      const body = JSON.parse(JSON.stringify(requestBody)) as typeof requestBody
      const k = key(namespace, name)
      const current = live.get(k)
      if (!current) throw { code: 404 }
      const metadata = current.metadata as LiveManifest['metadata'] & {
        annotations?: Record<string, string>
        resourceVersion?: string
        generation?: number
      }
      if (Array.isArray(body)) {
        const patched = applyJsonPatch(current, body)
        const patchedMetadata = patched.metadata as typeof metadata
        patchedMetadata.resourceVersion = String(Number(metadata.resourceVersion ?? '1') + 1)
        patchedMetadata.generation =
          (metadata.generation ?? 1) + (body.some(op => op.path.startsWith('/spec/')) ? 1 : 0)
        live.set(k, patched)
        return {}
      }
      const currentSpec = current.spec as Record<string, unknown>
      const spec: Record<string, unknown> = { ...currentSpec, ...body.spec }
      if (body.spec?.template !== undefined) {
        spec.template = strategicMergePodTemplate(currentSpec.template, body.spec.template)
      }
      live.set(k, {
        ...current,
        metadata: {
          ...metadata,
          annotations: { ...metadata.annotations, ...body.metadata?.annotations },
          resourceVersion: String(Number(metadata.resourceVersion ?? '1') + 1),
          generation: (metadata.generation ?? 1) + (body.spec ? 1 : 0),
        },
        spec,
      })
      return {}
    }
  )
}

type JsonPatchOperation = { op: string; path: string; value?: unknown }

/**
 * RFC 6902 on a copy of `target`, returned only when every operation applied
 * (§5: the document is atomic). Supported: `add` (the parent must exist; sets
 * the member whether or not it exists), `replace` and `remove` (the target must
 * exist) and `test` (the target must exist and equal the value; scalars and
 * objects with members in the same order, which is all the callers send).
 * Pointer tokens are decoded per RFC 6901 (`~1` → `/`, then `~0` → `~`).
 * Anything else — another operation, an array parent, a missing parent or
 * target — throws, as a 422 from the apiserver would fail the call.
 */
function applyJsonPatch<T>(target: T, operations: JsonPatchOperation[]): T {
  const document = structuredClone(target) as Record<string, unknown>
  for (const operation of operations) {
    const tokens = operation.path
      .split('/')
      .slice(1)
      .map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (operation.path[0] !== '/' || tokens.length === 0) {
      throw new Error(`JSON Patch: unsupported path "${operation.path}"`)
    }
    let parent: unknown = document
    for (const token of tokens.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || Array.isArray(parent) || !(token in parent)) {
        throw new Error(`JSON Patch: missing parent for "${operation.path}"`)
      }
      parent = (parent as Record<string, unknown>)[token]
    }
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
      throw new Error(`JSON Patch: missing or unsupported parent for "${operation.path}"`)
    }
    const member = tokens[tokens.length - 1]
    const container = parent as Record<string, unknown>
    if (operation.op === 'add') {
      container[member] = structuredClone(operation.value)
    } else if (operation.op === 'replace' || operation.op === 'remove') {
      if (!(member in container)) {
        throw new Error(`JSON Patch: ${operation.op} target "${operation.path}" does not exist`)
      }
      if (operation.op === 'replace') container[member] = structuredClone(operation.value)
      else delete container[member]
    } else if (operation.op === 'test') {
      if (
        !(member in container) ||
        JSON.stringify(container[member]) !== JSON.stringify(operation.value)
      ) {
        throw new Error(`JSON Patch: test failed at "${operation.path}"`)
      }
    } else {
      throw new Error(`JSON Patch: unsupported operation "${operation.op}"`)
    }
  }
  return document as T
}

/** Merge key of the pod-template lists a strategic merge patch merges by key. */
const POD_TEMPLATE_LIST_MERGE_KEYS: Record<string, string> = {
  containers: 'name',
  initContainers: 'name',
  env: 'name',
  imagePullSecrets: 'name',
  volumes: 'name',
  volumeMounts: 'mountPath',
  ports: 'containerPort',
}

/**
 * The strategic merge of a pod template, as the apiserver applies it: object
 * members merge recursively; the lists of {@link POD_TEMPLATE_LIST_MERGE_KEYS}
 * merge entry by entry on their key, and live entries the patch does not name
 * are kept; any other list, and any scalar, is replaced; a `null` deletes.
 */
function strategicMergePodTemplate(live: unknown, patch: unknown, field?: string): unknown {
  if (patch === null) return undefined
  if (Array.isArray(patch)) {
    const mergeKey = field === undefined ? undefined : POD_TEMPLATE_LIST_MERGE_KEYS[field]
    if (mergeKey === undefined || !Array.isArray(live)) return structuredClone(patch)
    const merged = structuredClone(live) as Array<Record<string, unknown>>
    for (const entry of patch as Array<Record<string, unknown>>) {
      const index = merged.findIndex(existing => existing[mergeKey] === entry[mergeKey])
      if (index === -1) merged.push(structuredClone(entry))
      else
        merged[index] = strategicMergePodTemplate(merged[index], entry) as Record<string, unknown>
    }
    return merged
  }
  if (patch && typeof patch === 'object') {
    const base =
      live && typeof live === 'object' && !Array.isArray(live)
        ? (structuredClone(live) as Record<string, unknown>)
        : {}
    for (const [member, value] of Object.entries(patch as Record<string, unknown>)) {
      const next = strategicMergePodTemplate(base[member], value, member)
      if (next === undefined) delete base[member]
      else base[member] = next
    }
    return base
  }
  return patch
}

/** The operation of a JSON Patch request body at `path`; fails unless the body is an array. */
function jsonPatchOpAt(body: unknown, path: string): JsonPatchOperation | undefined {
  expect(Array.isArray(body)).toBe(true)
  return (body as JsonPatchOperation[]).find(operation => operation.path === path)
}

const NO_SECRET_BEARING_FACT_PATH = '/status/terminalRunTeardown/noSecretBearingWorkloads'

/**
 * The bodies of the status patches that write the terminal
 * `noSecretBearingWorkloads` fact, as a JSON Patch operation or as a merge-patch
 * member, so "no fact was written" holds whichever way a write would be sent.
 */
function noSecretBearingFactWrites(): unknown[] {
  return mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls
    .map(([arg]) => (arg as { body?: unknown }).body)
    .filter(body =>
      Array.isArray(body)
        ? (body as JsonPatchOperation[]).some(op => op.path === NO_SECRET_BEARING_FACT_PATH)
        : (body as { status?: { terminalRunTeardown?: { noSecretBearingWorkloads?: unknown } } })
            ?.status?.terminalRunTeardown?.noSecretBearingWorkloads !== undefined
    )
}

/**
 * A StatefulSet as kube-apiserver returns it after a create: the defaults a
 * v1.35.1 server stored on the probe object of 2026-11-14 (issue #1349, P-1),
 * applied to the fields this manifest has. `resources: {}` and the pod
 * `securityContext: {}` are the two the template comparison does not strip, so
 * the stored template differs from the rendered one on every update.
 */
function withApiServerDefaults(statefulSet: k8s.V1StatefulSet): k8s.V1StatefulSet {
  const stored = structuredClone(statefulSet)
  const spec = stored.spec!
  spec.podManagementPolicy ??= 'OrderedReady'
  spec.revisionHistoryLimit ??= 10
  spec.persistentVolumeClaimRetentionPolicy ??= { whenDeleted: 'Retain', whenScaled: 'Retain' }
  spec.updateStrategy ??= {
    type: 'RollingUpdate',
    rollingUpdate: { maxUnavailable: 1, partition: 0 },
  }
  const pod = spec.template.spec!
  pod.dnsPolicy ??= 'ClusterFirst'
  pod.restartPolicy ??= 'Always'
  pod.schedulerName ??= 'default-scheduler'
  pod.securityContext ??= {}
  pod.terminationGracePeriodSeconds ??= 30
  for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) {
    container.imagePullPolicy ??= 'IfNotPresent'
    container.resources ??= {}
    container.terminationMessagePath ??= '/dev/termination-log'
    container.terminationMessagePolicy ??= 'File'
  }
  return stored
}

const LIVE_CLUSTER_IP = '10.0.0.7'

// StatefulSet double used by every test unless a test overrides it: reads are
// 404 until something creates the object, then return it with a ready status.
const LIVE_STATEFULSET_STATUS = { observedGeneration: 1, readyReplicas: 1 }

function installLiveStatefulSetStore(): void {
  installLiveStore(
    {
      read: mockAppsApi.readNamespacedStatefulSet,
      create: mockAppsApi.createNamespacedStatefulSet,
      replace: mockAppsApi.replaceNamespacedStatefulSet,
      patch: mockAppsApi.patchNamespacedStatefulSet,
    },
    LIVE_STATEFULSET_STATUS
  )
}

/**
 * Observe the StatefulSet WRC created with a test-chosen generation, spec and
 * status. Reads still go through the live store, so an object WRC has not
 * created reads as a 404 and the read before create sees what a real
 * apiserver would.
 */
function observeLiveStatefulSetAs(observed: {
  generation: number
  spec: Record<string, unknown>
  status: Record<string, unknown>
}): void {
  const storeRead = mockAppsApi.readNamespacedStatefulSet.getMockImplementation()!
  mockAppsApi.readNamespacedStatefulSet.mockImplementation(
    async (args: { name: string; namespace: string }) => {
      const live = await storeRead(args)
      return {
        ...live,
        metadata: { ...live.metadata, generation: observed.generation },
        spec: { ...live.spec, ...observed.spec },
        status: observed.status,
      }
    }
  )
}

function installLiveServiceAndConfigMapStores(): void {
  installLiveStore(
    {
      read: mockCoreApi.readNamespacedService,
      create: mockCoreApi.createNamespacedService,
      replace: mockCoreApi.replaceNamespacedService,
    },
    {},
    stored => {
      stored.spec = { ...(stored.spec as Record<string, unknown>), clusterIP: LIVE_CLUSTER_IP }
    },
    'reject'
  )
  installLiveStore(
    {
      read: mockCoreApi.readNamespacedConfigMap,
      create: mockCoreApi.createNamespacedConfigMap,
      replace: mockCoreApi.replaceNamespacedConfigMap,
    },
    {},
    undefined,
    'reject'
  )
}

// Per-object write counts: one reconcile writes several objects of the same
// kind, so a bare call count cannot say which of them was written.
function postsOf(create: ReturnType<typeof vi.fn>, name: string): number {
  return create.mock.calls.filter(
    ([args]) => (args as { body: LiveManifest }).body.metadata.name === name
  ).length
}

function putsOf(replace: ReturnType<typeof vi.fn>, name: string): number {
  return replace.mock.calls.filter(([args]) => (args as { name: string }).name === name).length
}

function readsOf(read: ReturnType<typeof vi.fn>, name: string, namespace: string): number {
  return read.mock.calls.filter(([args]) => {
    const a = args as { name: string; namespace: string }
    return a.name === name && a.namespace === namespace
  }).length
}

describe('WorkflowRecipeReconciler', () => {
  let reconciler: WorkflowRecipeReconciler

  /**
   * Publish a pass's result as the watcher does: patch the status only when
   * shouldPatchRecipeStatus says the result changed it. Returns whether it patched.
   */
  async function publishAsWatcher(
    recipe: WorkflowRecipeCRD,
    result: Parameters<typeof shouldPatchRecipeStatus>[1]
  ): Promise<boolean> {
    if (!shouldPatchRecipeStatus(recipe, result)) return false
    await reconciler.patchStatus(recipe, result)
    return true
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyWorkflowRunProvenance.mockResolvedValue('verified')
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED = 'true'
    installLiveStore(
      {
        read: mockAppsApi.readNamespacedDeployment,
        create: mockAppsApi.createNamespacedDeployment,
        replace: mockAppsApi.replaceNamespacedDeployment,
      },
      { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }
    )
    installLiveStatefulSetStore()
    installLiveStore(
      {
        read: mockAppsApi.readNamespacedDaemonSet,
        create: mockAppsApi.createNamespacedDaemonSet,
        replace: mockAppsApi.replaceNamespacedDaemonSet,
      },
      { desiredNumberScheduled: 1, numberReady: 1 }
    )
    installLiveStore(
      {
        read: mockBatchApi.readNamespacedCronJob,
        create: mockBatchApi.createNamespacedCronJob,
        replace: mockBatchApi.replaceNamespacedCronJob,
      },
      {}
    )
    installLiveStore(
      {
        read: mockBatchApi.readNamespacedJob,
        create: mockBatchApi.createNamespacedJob,
        replace: mockBatchApi.replaceNamespacedJob,
      },
      { succeeded: 1 }
    )
    installLiveServiceAndConfigMapStores()
    // clearAllMocks keeps implementations and `Once` queues, so a Secret store
    // or a create override installed by one test would reach the next. Every
    // test starts with no live Secret; tests that need one install it.
    mockCoreApi.readNamespacedSecret.mockReset()
    mockCoreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    mockCoreApi.createNamespacedSecret.mockReset()
    mockCoreApi.createNamespacedSecret.mockResolvedValue({})
    mockCoreApi.replaceNamespacedSecret.mockReset()
    mockCoreApi.replaceNamespacedSecret.mockResolvedValue({})
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockReset()
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockRejectedValue({ code: 404 })
    // A test that makes the StatefulSet Pod delete fail must not reach the next
    // test's revocation teardown.
    mockCoreApi.deleteCollectionNamespacedPod.mockReset()
    mockCoreApi.deleteCollectionNamespacedPod.mockResolvedValue({})
    mockCustomApi.createNamespacedCustomObject.mockReset()
    mockCustomApi.createNamespacedCustomObject.mockResolvedValue({})
    mockCustomApi.replaceNamespacedCustomObject.mockReset()
    mockCustomApi.replaceNamespacedCustomObject.mockResolvedValue({})
    mockCustomApi.getNamespacedCustomObject.mockReset()
    // No per-recipe Context exists until a test seeds one: the Context writer
    // reads first (#760), and an object here would send every transport pass
    // down the replace path instead of the create.
    mockCustomApi.getNamespacedCustomObject.mockImplementation(
      ({ name, plural }: { name?: string; plural?: string }) =>
        plural === 'contexts'
          ? Promise.reject({ code: 404 })
          : Promise.resolve({
              metadata: {
                uid: liveWorkflowRecipeUid(name),
                resourceVersion: '1',
                annotations: { 'clerum.io/network-ready': 'true' },
                labels: { 'clerum.io/recipe': 'test-recipe' },
              },
              status: {
                conditions: [{ type: 'ExternalEgressReady', status: 'True' }],
              },
              spec: { mcpServers: [] },
            })
    )
    mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
    mockNetworkingApi.createNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.createNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.readNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.endsWith('-coordinator-to-gfs')) return Promise.reject({ code: 404 })
        // The live policy as WRC last wrote it: owned and converged, so a
        // read-first apply has nothing to write. Tests about an absent policy
        // say so explicitly.
        const converged = buildCoordinatorGfsNetworkPolicy({
          recipeName: name.replace(/-coordinator-to-gfs$/, ''),
          sandboxNamespace: 'sandbox-recipes',
        })
        return Promise.resolve({
          ...converged,
          metadata: { ...converged.metadata, name, uid: `uid-${name}`, resourceVersion: '1' },
        })
      }
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.listNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    const kc = new k8s.KubeConfig()
    reconciler = new WorkflowRecipeReconciler(kc, undefined, {
      verifyWorkflowRunProvenance: mockVerifyWorkflowRunProvenance,
    })
  })

  // ─── Pipeline Tests ─────────────────────────────────────────────

  describe('transport admission pending survives observation and restart', () => {
    const conditionType = 'TransportExternalEgressReady'
    const pendingCondition = {
      type: conditionType,
      status: 'False' as const,
      reason: 'ExternalEgressPending',
      message: 'Transport external egress admission is pending',
      lastTransitionTime: '2026-09-05T00:00:00.000Z',
    }
    function transportRecipe(workflow = false): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          generation: 7,
        },
        spec: {
          ...(workflow ? {} : { contextRef: 'context1' }),
          workloads: [
            {
              id: 'calculator',
              type: 'deployment',
              image: 'clerum/mock-stdio-mcp-server:test',
              port: 3000,
              transport: { type: 'stdio' },
              egressBindings: [{ dns: 'current.example.com', port: 443 }],
            },
          ],
          ...(workflow ? { steps: [{ id: 'step', run: snippetRun() }] } : {}),
        },
        status: { phase: 'approved' },
      })
    }
    function hccReadiness() {
      const healthyRead = mockCustomApi.getNamespacedCustomObject.getMockImplementation()!
      const state = { ready: false }
      mockCustomApi.getNamespacedCustomObject.mockImplementation(async request => {
        const response = await healthyRead(request)
        if (request.plural === 'mcpservers') {
          response.metadata.generation = 7
          response.status.conditions = [
            {
              type: 'ExternalEgressReady',
              status: state.ready ? 'True' : 'False',
              observedGeneration: 7,
              reason: state.ready ? 'Reconciled' : 'ExternalEgressReconcileFailed',
              message: 'Policy observation pending',
            },
          ]
        }
        return response
      })
      return state
    }
    function watcherFor(rec: WorkflowRecipeReconciler, recipe?: WorkflowRecipeCRD) {
      const watcher: any = Object.create(WorkflowRecipeWatcher.prototype)
      Object.assign(watcher, {
        recipes: new Map(recipe ? [[recipe.metadata.name, recipe]] : []),
        transientRetries: new Map(),
        stopped: false,
        traceReporter: null,
        dbRunProcessor: null,
        reconciler: rec,
        eventQueue: { enqueue: vi.fn((_key: string, work: () => Promise<void>) => work()) },
        config: loadConfig(),
      })
      return watcher
    }
    function stopWatcher(watcher: any) {
      watcher.stopped = true
      for (const { timer } of watcher.transientRetries.values()) clearTimeout(timer)
      watcher.transientRetries.clear()
    }
    function patchedStatus(previous?: WorkflowRecipeCRD['status']) {
      return {
        ...previous,
        ...mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body.status,
      }
    }

    it('retries persisted stdio-only admission with backoff after restart and cannot become active from ready pods', async () => {
      const recipe = transportRecipe()
      const hcc = hccReadiness()
      const watcher = watcherFor(reconciler)
      let restarted: any
      vi.useFakeTimers()
      try {
        const firstRun = watcher.handleRecipeEvent('ADDED', recipe)
        await vi.advanceTimersByTimeAsync(31_000)
        await firstRun
        expect(watcher.transientRetries.get(recipe.metadata.name)?.attempts).toBe(1)
        const pendingRecipe = { ...recipe, status: patchedStatus() }
        expect(pendingRecipe.status.phase).toBe('degraded')
        expect(pendingRecipe.status.conditions).toContainEqual(
          expect.objectContaining({ type: conditionType, status: 'False' })
        )
        await watcher.handleRecipeEvent('MODIFIED', pendingRecipe)
        await watcher.refreshWorkloadStatusesForSteadyRecipes()
        const observedStatus = patchedStatus(pendingRecipe.status)
        expect(observedStatus.phase).toBe('degraded')
        expect(observedStatus.conditions).toContainEqual(
          expect.objectContaining({ type: conditionType, status: 'False' })
        )
        stopWatcher(watcher)

        // A new process has no previous retry timer; only persisted condition state remains.
        const restartRecipe = { ...recipe, status: observedStatus }
        const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig())
        restarted = watcherFor(rec, restartRecipe)
        const run = vi.spyOn(rec, 'reconcile')
        const restartPass = restarted.refreshRuntimeCredentialsForInProgressRecipes()
        await vi.advanceTimersByTimeAsync(31_000)
        await restartPass
        expect(run).toHaveBeenCalledTimes(1)
        expect(restarted.transientRetries.get(recipe.metadata.name)?.attempts).toBe(1)
        await restarted.handleRecipeEvent('MODIFIED', { ...recipe, status: patchedStatus() })
        await vi.advanceTimersByTimeAsync(35_000)
        expect(run).toHaveBeenCalledTimes(2)
        expect(restarted.transientRetries.get(recipe.metadata.name)?.attempts).toBe(2)
        expect(patchedStatus().phase).toBe('degraded')
        hcc.ready = true
        await vi.advanceTimersByTimeAsync(10_000)
        expect(run).toHaveBeenCalledTimes(3)
        expect(patchedStatus().phase).toBe('active')
        expect(
          patchedStatus().conditions?.some(
            (condition: { type: string }) => condition.type === conditionType
          )
        ).not.toBe(true)
        expect(restarted.transientRetries.size).toBe(0)
        expect(recipe.metadata.generation).toBe(7)
      } finally {
        stopWatcher(watcher)
        if (restarted) stopWatcher(restarted)
        vi.useRealTimers()
      }
    })

    it('persists workflow admission pending and only starts the workflow after HCC heals', async () => {
      const recipe = transportRecipe(true)
      const hcc = hccReadiness()
      const workflow = vi
        .fn()
        .mockResolvedValue({ phase: 'active', workflowPhase: 'running', message: 'Workflow ready' })
      ;(reconciler as any).workflowReconciler = {
        reconcile: workflow,
        validateWorkflowSpec: () => undefined,
      }
      vi.useFakeTimers()
      try {
        const pending = reconciler.reconcile(recipe)
        await vi.advanceTimersByTimeAsync(31_000)
        const first = await pending
        expect(first.phase, first.message).toBe('degraded')
        expect(first.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(workflow).not.toHaveBeenCalled()
        await reconciler.patchStatus(recipe, first)
        const persisted = { ...recipe, status: patchedStatus() }
        expect(persisted.status.conditions).toContainEqual(
          expect.objectContaining({ type: conditionType, status: 'False' })
        )
        expect(persisted.status.workflowExecution?.phase).not.toBe('failed')
        hcc.ready = true
        const result = await reconciler.reconcile(persisted)
        expect(result.phase).toBe('active')
        expect(workflow).toHaveBeenCalledTimes(1)
        await reconciler.patchStatus(persisted, result)
        expect(
          patchedStatus().conditions?.some(
            (condition: { type: string }) => condition.type === conditionType
          )
        ).not.toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('preserves pending admission through an earlier validation failure and clears it after transport removal', async () => {
      const recipe = transportRecipe()
      recipe.status = { phase: 'degraded', conditions: [pendingCondition] }
      recipe.spec.workloads![0].egressBindings![0].port = 0
      const failed = await reconciler.reconcile(recipe)
      expect(failed.phase).toBe('failed')
      await reconciler.patchStatus(recipe, failed)
      expect(patchedStatus(recipe.status).conditions).toContainEqual(pendingCondition)
      recipe.spec.workloads![0].egressBindings = []
      delete recipe.spec.workloads![0].transport
      const removed = await reconciler.reconcile(recipe)
      expect(removed.phase).toBe('active')
      await reconciler.patchStatus(recipe, removed)
      expect(
        patchedStatus(recipe.status).conditions?.some(
          (condition: { type: string }) => condition.type === conditionType
        )
      ).not.toBe(true)
    })

    it('preserves ordinary Pod-only downgrade and recovery when no admission is pending', async () => {
      const recipe = makeRecipe({ status: { phase: 'degraded' } })
      mockAppsApi.readNamespacedDeployment
        .mockResolvedValueOnce({
          spec: { replicas: 1 },
          status: { readyReplicas: 0, updatedReplicas: 0, availableReplicas: 0 },
        })
        .mockResolvedValueOnce({
          spec: { replicas: 1 },
          status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 },
        })
      expect((await reconciler.observeCurrentWorkloadStatus(recipe)).phase).toBe('degraded')
      expect((await reconciler.observeCurrentWorkloadStatus(recipe)).phase).toBe('active')
    })
  })

  function captureNetworkPolicyLogs(): {
    entries: Array<Record<string, unknown>>
    restore: () => void
  } {
    const previousLevel = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'info'
    const entries: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (String(parsed.msg).startsWith('network policy')) entries.push(parsed)
      }
      return true
    }) as unknown as typeof process.stdout.write)
    return {
      entries,
      restore: () => {
        spy.mockRestore()
        if (previousLevel === undefined) delete process.env.LOG_LEVEL
        else process.env.LOG_LEVEL = previousLevel
      },
    }
  }

  describe('#567 regression: policy contraction', () => {
    describe('#580 contraction lifecycle regression', () => {
      const namespace = 'sandbox-recipes'
      type Pipeline = {
        applyNetworkPolicyContraction(input: {
          existing: k8s.V1NetworkPolicy
          desired: k8s.V1NetworkPolicy | null
          namespace: string
          recipeName: string
        }): Promise<k8s.V1NetworkPolicy | null>
        applyNetworkPolicy(
          policy: k8s.V1NetworkPolicy,
          namespace: string,
          options: {
            family: NetworkPolicyFamily
            recipeName: string
            existing: k8s.V1NetworkPolicy | null
          }
        ): Promise<void>
      }
      for (const family of ['ui-ingress', 'workload-ingress'] as const) {
        const build = (ports: number[]) => {
          const recipe = makeRecipe()
          return (
            family === 'ui-ingress'
              ? buildUiIngressNetworkPolicy(recipe, 'app', ports, namespace, 'sandbox-ui')
              : buildWorkloadIngressNetworkPolicy(
                  recipe.spec.workloads![0],
                  recipe,
                  namespace,
                  ports.map(port => ({
                    fromWorkloadId: 'source',
                    fromNamespace: namespace,
                    port,
                    protocol: 'TCP' as const,
                  }))
                )
          )!
        }
        const decorated = (ports = [443, 8443]) => {
          const policy = build(ports)
          policy.metadata!.labels!['external.example/team'] = 'payments'
          policy.metadata!.annotations = { 'external.example/review': 'retained' }
          policy.metadata!.finalizers = ['external.example/cleanup']
          return policy
        }
        it(`${family}: preserves external metadata through contraction and final apply`, async () => {
          const original = decorated()
          const live = policyStore([original])
          const name = original.metadata!.name!
          const desired = build([443])
          const pipeline = reconciler as unknown as Pipeline
          const contracted = await pipeline.applyNetworkPolicyContraction({
            existing: structuredClone(live.get(name)!),
            desired,
            namespace,
            recipeName: 'test-recipe',
          })
          const captured = captureNetworkPolicyLogs()
          try {
            await pipeline.applyNetworkPolicy(desired, namespace, {
              family,
              recipeName: 'test-recipe',
              existing: contracted,
            })
            expect(captured.entries).toContainEqual(
              expect.objectContaining({
                level: 'info',
                msg: 'network policy unchanged; skipping update',
                policy: name,
                namespace,
                family,
              })
            )
          } finally {
            captured.restore()
          }
          expect(live.get(name)?.metadata).toMatchObject({
            labels: { 'external.example/team': 'payments' },
            annotations: { 'external.example/review': 'retained' },
            finalizers: ['external.example/cleanup'],
          })
          expect(live.get(name)?.spec).toEqual(desired.spec)
          expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        })
        it(`${family}: keeps owned metadata on a no-op and fences an authorized delete`, async () => {
          const original = decorated([443])
          const live = policyStore([original])
          const existing = structuredClone(live.get(original.metadata!.name!)!)
          const pipeline = reconciler as unknown as Pipeline
          const input = { existing, namespace, recipeName: 'test-recipe' }
          expect(
            await pipeline.applyNetworkPolicyContraction({ ...input, desired: build([443]) })
          ).toEqual(existing)
          expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
          expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
          await pipeline.applyNetworkPolicyContraction({ ...input, desired: null })
          expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
            name: original.metadata!.name,
            namespace,
            body: {
              preconditions: {
                uid: existing.metadata!.uid,
                resourceVersion: existing.metadata!.resourceVersion,
              },
            },
          })
        })
        for (const lifecycle of ['foreign-owner', 'terminating'] as const) {
          it(`${family}: does not revoke an unsafe ${lifecycle} read-back`, async () => {
            const original = decorated()
            const live = policyStore([original])
            const name = original.metadata!.name!
            const existing = structuredClone(live.get(name)!)
            mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(async () => {
              const readBack = structuredClone(live.get(name)!)
              // Admission/concurrency re-broadens the spec; the defensive
              // deletion must not override a new lifecycle owner or termination.
              readBack.spec = original.spec
              if (lifecycle === 'terminating') readBack.metadata!.deletionTimestamp = new Date()
              else
                readBack.metadata!.ownerReferences = [
                  {
                    apiVersion: 'v1',
                    kind: 'ConfigMap',
                    name: 'foreign',
                    uid: 'foreign-uid',
                    controller: true,
                  },
                ]
              return readBack
            })
            await expect(
              (reconciler as unknown as Pipeline).applyNetworkPolicyContraction({
                existing,
                desired: build([443]),
                namespace,
                recipeName: 'test-recipe',
              })
            ).rejects.toMatchObject({
              name:
                lifecycle === 'terminating'
                  ? 'RetryableReconcileError'
                  : 'NetworkPolicyOwnershipConflictError',
              message: expect.stringContaining(
                lifecycle === 'terminating' ? 'terminating' : 'owner-reference-mismatch'
              ),
            })
            expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
            expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
          })
        }
        for (const operation of ['replace', 'delete', 'unchanged'] as const) {
          for (const lifecycle of [
            'controller-owner',
            'non-controller-owner',
            'terminating',
          ] as const) {
            it(`${family}: vetoes ${lifecycle} before contraction ${operation}`, async () => {
              const original = decorated()
              if (lifecycle === 'terminating') original.metadata!.deletionTimestamp = new Date()
              else
                original.metadata!.ownerReferences = [
                  {
                    apiVersion: 'v1',
                    kind: 'ConfigMap',
                    name: 'foreign',
                    uid: 'foreign-uid',
                    controller: lifecycle === 'controller-owner',
                  },
                ]
              const live = policyStore([original])
              await expect(
                (reconciler as unknown as Pipeline).applyNetworkPolicyContraction({
                  existing: live.get(original.metadata!.name!)!,
                  namespace,
                  recipeName: 'test-recipe',
                  desired:
                    operation === 'delete'
                      ? null
                      : build(operation === 'replace' ? [443] : [443, 8443]),
                })
              ).rejects.toMatchObject({
                name:
                  lifecycle === 'terminating'
                    ? 'RetryableReconcileError'
                    : 'NetworkPolicyOwnershipConflictError',
                message: expect.stringContaining(
                  lifecycle === 'terminating' ? 'terminating' : 'owner-reference-mismatch'
                ),
              })
              expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
              expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
            })
          }
        }
      }
    })
    function policyStore(policies: k8s.V1NetworkPolicy[]) {
      const live = new Map<string, k8s.V1NetworkPolicy>()
      let version = 0
      const persist = (body: k8s.V1NetworkPolicy) => {
        const policy = structuredClone(body)
        const name = policy.metadata!.name!
        policy.metadata = {
          ...policy.metadata,
          uid: `uid-${name}`,
          resourceVersion: String(++version),
        }
        // The API's omitempty serialization omits empty top-level rule lists.
        if (policy.spec?.egress?.length === 0) delete policy.spec.egress
        if (policy.spec?.ingress?.length === 0) delete policy.spec.ingress
        live.set(name, policy)
        return structuredClone(policy)
      }
      for (const policy of policies) persist(policy)
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
        if (!live.has(name)) throw { code: 404 }
        return structuredClone(live.get(name))
      })
      mockNetworkingApi.createNamespacedNetworkPolicy.mockImplementation(async ({ body }) => {
        if (live.has(body.metadata.name)) throw { code: 409 }
        return persist(body)
      })
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
        async ({ name, body }) => {
          expect(body.metadata.resourceVersion).toBe(live.get(name)?.metadata?.resourceVersion)
          return persist(body)
        }
      )
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(async ({ name, body }) => {
        if (body?.preconditions) {
          expect(body.preconditions).toEqual({
            uid: live.get(name)?.metadata?.uid,
            resourceVersion: live.get(name)?.metadata?.resourceVersion,
          })
        }
        live.delete(name)
        return {}
      })
      return live
    }

    function uiRecipe(ports = [8080, 9090]) {
      return makeRecipe({
        spec: {
          workloads: [
            { id: 'ui', type: 'deployment', image: 'ui:1', port: 8080 },
            { id: 'backend', type: 'deployment', image: 'backend:1', port: 8080 },
          ],
          ui: {
            workloadRef: 'ui',
            port: 8080,
            egress: {
              internal: ports.map(port => ({ workloadRef: 'backend', port })),
              external: [{ fqdn: 'current.example.com', port: 443 }],
            },
          },
        },
      })
    }

    it.each([[8080], [8080, 9090, 9443], [9090, 8080]])(
      'preserves the intersection of grouped UI ports during a DNS fault: %j',
      async (...ports) => {
        const rb = await import('./resourceBuilder')
        const recipe = uiRecipe()
        const name = 'ui-ingress-test-recipe-backend'
        const live = policyStore([
          rb.buildUiIngressNetworkPolicy(
            recipe,
            'backend',
            [8080, 9090],
            'sandbox-recipes',
            'sandbox-ui'
          )!,
        ])
        recipe.spec.ui!.egress!.internal = ports.map(port => ({ workloadRef: 'backend', port }))
        const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
          fqdnLookup: async () => {
            throw new Error('resolver controller fault')
          },
        })
        const result = await rec.reconcile({ ...recipe, status: { phase: 'active' } })
        expect(result.phase).toBe('failed')
        const retained = (live.get(name)?.spec?.ingress ?? [])
          .flatMap(rule => rule.ports ?? [])
          .map(port => port.port)
        expect(retained.sort()).toEqual(ports.filter(port => port === 8080 || port === 9090).sort())
      }
    )

    it.each([false, true])(
      'accepts empty UI readback before external replacement=%s',
      async replacement => {
        const rb = await import('./resourceBuilder')
        const recipe = uiRecipe([])
        const name = 'ui-egress-test-recipe'
        const live = policyStore([
          rb.buildUiEgressNetworkPolicy(
            recipe,
            'sandbox-ui',
            'sandbox-recipes',
            [
              {
                cidr: '93.184.216.20/32',
                port: 443,
                source: { kind: 'fqdn', fqdn: 'current.example.com' },
              },
            ],
            egressStateAnnotations([
              { fqdn: 'current.example.com', ip: '93.184.216.20', port: 443 },
            ])
          )!,
        ])
        recipe.spec.ui!.egress!.external = replacement
          ? [{ fqdn: 'new.example.com', port: 443 }]
          : []
        const lookup = vi.fn(async () => ({
          kind: 'ok' as const,
          ipv4: ['93.184.216.21'],
          ipv6: [],
          ttlSeconds: 300,
        }))
        const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
          fqdnLookup: lookup,
        })
        const result = await rec.reconcile({ ...recipe, status: { phase: 'active' } })
        expect(result.phase).toBe('active')
        expect(live.has(name)).toBe(true)
        expect(lookup).toHaveBeenCalledTimes(replacement ? 1 : 0)
        expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
          expect.objectContaining({ name })
        )
      }
    )

    it.each([
      { mode: 'broader-rules', phase: 'failed', deleted: true },
      { mode: 'annotation-only', phase: 'failed', deleted: true },
      { mode: 'replacement-uid', phase: 'degraded', deleted: false },
      { mode: 'foreign-owner', phase: 'failed', deleted: false },
      { mode: 'missing-uid', phase: 'failed', deleted: false },
      { mode: 'wrong-namespace', phase: 'failed', deleted: false },
    ] as const)('rejects unsafe readback: $mode', async ({ mode, phase, deleted }) => {
      const rb = await import('./resourceBuilder')
      const recipe = uiRecipe([])
      const name = 'ui-egress-test-recipe'
      const live = policyStore([
        rb.buildUiEgressNetworkPolicy(
          recipe,
          'sandbox-ui',
          'sandbox-recipes',
          [
            {
              cidr: '93.184.216.20/32',
              port: 443,
              source: { kind: 'fqdn', fqdn: 'current.example.com' },
            },
          ],
          egressStateAnnotations([{ fqdn: 'current.example.com', ip: '93.184.216.20', port: 443 }])
        )!,
      ])
      recipe.spec.ui!.egress!.external = []
      const replace = mockNetworkingApi.replaceNamespacedNetworkPolicy.getMockImplementation()!
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(async request => {
        const result = await replace(request)
        if (request.name === name) {
          const observed = live.get(name)!
          if (mode === 'broader-rules')
            observed.spec!.egress = [
              {
                to: [{ ipBlock: { cidr: '8.8.8.8/32' } }],
                ports: [{ port: 443, protocol: 'TCP' }],
              },
            ]
          if (mode === 'annotation-only')
            observed.metadata!.annotations = egressStateAnnotations([
              { fqdn: 'removed.example.com', ip: '8.8.8.8', port: 443 },
            ])
          if (mode === 'replacement-uid') observed.metadata!.uid = 'uid-new-owned-object'
          if (mode === 'missing-uid') delete observed.metadata!.uid
          if (mode === 'wrong-namespace') observed.metadata!.namespace = 'another-namespace'
          if (mode === 'foreign-owner')
            observed.metadata!.labels!['clerum.io/managed-by'] = 'another-controller'
        }
        return result
      })
      const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
        fqdnLookup: async () => {
          throw new Error('no external lookup is declared')
        },
      })
      const result = await rec.reconcile({ ...recipe, status: { phase: 'active' } })
      expect(result.phase).toBe(phase)
      expect(live.has(name)).toBe(!deleted)
      if (!deleted) expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(result.requeueAfterMs).toBe(
        mode === 'replacement-uid' ? TRANSIENT_REQUEUE_BASE_MS : undefined
      )
    })

    it.each(['ui', 'workload'] as const)(
      'replans additive %s conflicts and disappearance without latching a healthy recipe',
      async lane => {
        for (const failure of ['replace-conflict', 'read-disappearance', 'replace-disappearance']) {
          const recipe =
            lane === 'ui'
              ? uiRecipe([])
              : makeRecipe({
                  spec: {
                    workloads: [
                      {
                        id: 'worker',
                        type: 'deployment',
                        image: 'worker:1',
                        port: 8080,
                        egressBindings: [{ dns: 'current.example.com', port: 443 }],
                      },
                    ],
                  },
                })
          const name = lane === 'ui' ? 'ui-egress-test-recipe' : 'wl-egress-test-recipe-worker'
          const live = policyStore([])
          let address = '93.184.216.20'
          const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
            fqdnLookup: async () => ({ kind: 'ok', ipv4: [address], ipv6: [], ttlSeconds: 300 }),
          })
          expect((await rec.reconcile({ ...recipe, status: { phase: 'active' } })).phase).toBe(
            'active'
          )
          const healthyReplace =
            mockNetworkingApi.replaceNamespacedNetworkPolicy.getMockImplementation()!
          const healthyCreate =
            mockNetworkingApi.createNamespacedNetworkPolicy.getMockImplementation()!
          address = '93.184.216.21'
          if (failure === 'read-disappearance') {
            // Both lanes are read-first: start absent so the create can race
            // with another creator, whose winner then disappears.
            live.delete(name)
            mockNetworkingApi.createNamespacedNetworkPolicy.mockImplementation(async request => {
              if (request.body.metadata.name === name) {
                live.delete(name)
                throw Object.assign(new Error('object existed before replacement read'), {
                  code: 409,
                })
              }
              return healthyCreate(request)
            })
          } else {
            mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(async request => {
              if (request.name === name && JSON.stringify(request.body.spec).includes(address)) {
                if (failure === 'replace-disappearance') live.delete(name)
                throw Object.assign(new Error('object snapshot changed'), {
                  code: failure === 'replace-conflict' ? 409 : 404,
                })
              }
              return healthyReplace(request)
            })
          }
          const first = await rec.reconcile({ ...recipe, status: { phase: 'active' } })
          expect(first.phase, `${lane}/${failure}`).toBe('degraded')
          if (failure === 'read-disappearance') {
            // The UI lane replaces through applyOwnedRecipeNetworkPolicy; the
            // workload lane converges through its own create-conflict path.
            expect(first.message, `${lane}/${failure}`).toMatch(
              lane === 'ui' ? /disappeared before replace/ : /still absent after create conflict/
            )
          }
          expect(first.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
          await rec.patchStatus(recipe, first)
          const persisted =
            mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body.status
          mockNetworkingApi.createNamespacedNetworkPolicy.mockImplementation(healthyCreate)
          mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(healthyReplace)
          const recovered = await rec.reconcile({ ...recipe, status: persisted })
          expect(recovered.phase).toBe('active')
          expect(JSON.stringify(live.get(name)?.spec)).toContain(address)
        }
      }
    )

    it.each(['delete', 'replace'] as const)(
      'retries a fenced %s conflict after the status roundtrip',
      async operation => {
        const rb = await import('./resourceBuilder')
        const recipe = makeRecipe({
          spec: {
            workloads: [
              {
                id: 'worker',
                type: 'deployment',
                image: 'worker:1',
                port: 8080,
                egressBindings: [
                  { dns: 'current.example.com', port: 443 },
                  { dns: 'removed.example.com', port: 443 },
                ],
              },
              {
                id: 'keeper',
                type: 'deployment',
                image: 'keeper:1',
                port: 8080,
                egressBindings: [{ dns: 'keeper.example.com', port: 443 }],
              },
            ],
          },
        })
        const name = 'wl-egress-test-recipe-worker'
        const entries = [
          { fqdn: 'current.example.com', ip: '93.184.216.20', port: 443 },
          { fqdn: 'removed.example.com', ip: '93.184.216.21', port: 443 },
        ]
        const live = policyStore([
          rb.buildWorkloadEgressNetworkPolicy(
            recipe.spec.workloads![0],
            recipe,
            'sandbox-recipes',
            entries.map(entry => ({
              cidr: `${entry.ip}/32`,
              port: entry.port,
              source: { kind: 'fqdn', fqdn: entry.fqdn },
            })),
            egressStateAnnotations(entries)
          )!,
        ])
        recipe.spec.workloads![0].egressBindings =
          operation === 'delete' ? [] : [{ dns: 'current.example.com', port: 443 }]
        const mutation =
          operation === 'delete'
            ? mockNetworkingApi.deleteNamespacedNetworkPolicy
            : mockNetworkingApi.replaceNamespacedNetworkPolicy
        const healthyMutation = mutation.getMockImplementation()!
        mutation.mockImplementationOnce(async () => {
          throw Object.assign(new Error('object modified'), { code: 409 })
        })
        const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
          fqdnLookup: async () => ({
            kind: 'ok',
            ipv4: ['93.184.216.20'],
            ipv6: [],
            ttlSeconds: 300,
          }),
        })
        type Watcher = {
          recipes: Map<string, WorkflowRecipeCRD>
          transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
          stopped: boolean
          traceReporter: null
          dbRunProcessor: null
          reconciler: WorkflowRecipeReconciler
          eventQueue: { enqueue: (key: string, task: () => Promise<void>) => Promise<void> }
          handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
        }
        const watcher = Object.create(WorkflowRecipeWatcher.prototype) as Watcher
        Object.assign(watcher, {
          recipes: new Map(),
          transientRetries: new Map(),
          stopped: false,
          traceReporter: null,
          dbRunProcessor: null,
          reconciler: rec,
          eventQueue: { enqueue: vi.fn((_key: string, task: () => Promise<void>) => task()) },
        })
        const reconcile = vi.spyOn(rec, 'reconcile')
        const active = {
          ...recipe,
          metadata: { ...recipe.metadata, generation: 1 },
          status: { phase: 'active' as const },
        }
        vi.useFakeTimers()
        try {
          await watcher.handleRecipeEvent('ADDED', active)
          const first = await reconcile.mock.results[0].value
          expect(first.phase).toBe('degraded')
          expect(first.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
          const patched =
            mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body.status
          // Deliver the real status-only watch event without changing generation.
          await watcher.handleRecipeEvent('MODIFIED', { ...active, status: patched })
          expect(reconcile).toHaveBeenCalledTimes(1)
          expect(watcher.transientRetries.get(recipe.metadata.name)?.attempts).toBe(1)
          mutation.mockImplementationOnce(async () => {
            throw Object.assign(new Error('object modified again'), { code: 409 })
          })
          await vi.advanceTimersByTimeAsync(TRANSIENT_REQUEUE_BASE_MS)
          expect(reconcile).toHaveBeenCalledTimes(2)
          expect(watcher.transientRetries.get(recipe.metadata.name)?.attempts).toBe(2)
          mutation.mockImplementation(healthyMutation)
          await vi.advanceTimersByTimeAsync(TRANSIENT_REQUEUE_BASE_MS * 2)
          const next = await reconcile.mock.results[2].value
          expect(next.phase).toBe('active')
          expect(watcher.transientRetries.size).toBe(0)
          expect(JSON.stringify(live.get(name)?.spec ?? {})).not.toContain('93.184.216.21')
          expect(live.has(name)).toBe(operation === 'replace')
        } finally {
          for (const { timer } of watcher.transientRetries.values()) clearTimeout(timer)
          vi.useRealTimers()
        }
      }
    )
  })

  it('processes full pipeline successfully (3.11a)', async () => {
    const result = await reconciler.reconcile(makeRecipe())
    expect(result.phase).toBe('active')
    expect(result.workloadStatuses).toHaveLength(1)
    expect(result.workloadStatuses[0].ready).toBe(true)
  })

  it('uses the SDK-only runtime adapter without invoking workflow reconciliation', async () => {
    const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Plugin Workload SDK mcp-host registered',
      pluginWorkloadSdkBootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'sdk-pod-uid',
        provider: 'zai',
        model: 'glm-4.7',
        policyReady: true,
        verifiedAt: '2026-08-04T00:00:00.000Z',
      },
      networkPolicies: {
        conflicts: [],
        retryPending: false,
        prune: 'converged',
        legacy: 'removed',
      },
    })
    const workflowReconcile = vi.fn()
    const setCodexReconcileContext = vi.fn()
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          setCodexReconcileContext: typeof setCodexReconcileContext
        }
      }
    ).config.pluginWorkloadSdkEnabled = true
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          setCodexReconcileContext: typeof setCodexReconcileContext
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      reconcilePluginWorkloadSdkOnly,
      setCodexReconcileContext,
    }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(setCodexReconcileContext).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeName: 'test-recipe',
        runtimeScopeRecipeName: 'test-recipe',
      })
    )
    expect(reconcilePluginWorkloadSdkOnly).toHaveBeenCalledWith(
      'test-recipe',
      'uid-123',
      'sandbox-recipes',
      recipe.spec,
      'test-recipe'
    )
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('never settles promptBridge active when the SDK adapter omits bootstrap proof', async () => {
    const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Plugin Workload SDK mcp-host registered',
      networkPolicies: {
        conflicts: [],
        retryPending: false,
        prune: 'converged',
        legacy: 'removed',
      },
    })
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).config.pluginWorkloadSdkEnabled = true
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      message: 'Plugin Workload SDK bootstrap identity proof pending',
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
      requeueFixedInterval: true,
    })
  })

  it('keeps an SDK-only recipe deploying and requeues while the eager host boots', async () => {
    const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Plugin Workload SDK mcp-host starting',
      networkPolicies: {
        conflicts: [],
        retryPending: false,
        prune: 'converged',
        legacy: 'removed',
      },
    })
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).config.pluginWorkloadSdkEnabled = true
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      message: 'Plugin Workload SDK mcp-host starting',
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
      requeueFixedInterval: true,
    })
  })

  describe('SDK-only NetworkPolicy ownership condition', () => {
    const ownershipCondition = {
      type: 'WorkflowNetworkPolicyOwnership',
      status: 'False' as const,
      reason: 'OwnershipConflict',
      message:
        'NetworkPolicy ownership conflict: test-recipe-mcp-host-to-gfs (owner-reference-mismatch)',
      lastTransitionTime: '2026-09-23T10:00:00.000Z',
    }
    const bootstrapProof = {
      ready: true,
      contractVersion: 2,
      podUid: 'sdk-pod-uid',
      provider: 'zai',
      model: 'glm-4.7',
      policyReady: true,
      verifiedAt: '2026-08-04T00:00:00.000Z',
    }
    const sdkOnlyRecipe = (conditions?: unknown[]) =>
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
        status: { phase: 'active', ...(conditions ? { conditions } : {}) },
      } as Partial<WorkflowRecipeCRD>)
    const stubSdkOnly = (resolved: Record<string, unknown>) => {
      const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue(resolved)
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          }
        }
      ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }
      return reconcilePluginWorkloadSdkOnly
    }

    it('publishes a False condition naming each conflicting policy', async () => {
      const sdkOnly = stubSdkOnly({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: bootstrapProof,
        networkPolicies: {
          conflicts: [
            {
              policy: 'test-recipe-workload-to-mcp-host-sdk-ingress',
              reason: 'owner-reference-mismatch',
            },
          ],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const result = await reconciler.reconcile(sdkOnlyRecipe())

      expect(sdkOnly).toHaveBeenCalledTimes(1)
      expect(result.phase).toBe('active')
      expect(result.networkPolicyOwnershipConditions).toEqual([
        expect.objectContaining({
          type: 'WorkflowNetworkPolicyOwnership',
          status: 'False',
          reason: 'OwnershipConflict',
          message: expect.stringContaining(
            'test-recipe-workload-to-mcp-host-sdk-ingress (owner-reference-mismatch)'
          ),
        }),
      ])
    })

    it('clears the condition with an explicit empty set once no policy conflicts', async () => {
      const sdkOnly = stubSdkOnly({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: bootstrapProof,
        networkPolicies: {
          conflicts: [],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const result = await reconciler.reconcile(sdkOnlyRecipe([ownershipCondition]))

      expect(sdkOnly).toHaveBeenCalledTimes(1)
      expect(result.phase).toBe('active')
      expect(result.networkPolicyOwnershipConditions).toEqual([])
    })

    // `failed` can return before the apply, so the pass cannot say whether the
    // conflict is gone. The field stays undefined and patchStatus keeps the
    // published condition (see the patchStatus describe for the merge side).
    it('leaves the ownership field undefined when the eager host fails before applying', async () => {
      const sdkOnly = stubSdkOnly({
        phase: 'failed',
        message: 'Plugin Workload SDK promptBridge has no resolvable agent',
      })

      const result = await reconciler.reconcile(sdkOnlyRecipe([ownershipCondition]))

      expect(sdkOnly).toHaveBeenCalledTimes(1)
      expect(result.phase).toBe('failed')
      expect(result.message).toBe('Plugin Workload SDK promptBridge has no resolvable agent')
      expect(result).not.toHaveProperty('networkPolicyOwnershipConditions')
    })

    // The mcp-host pod failed after the apply, so the summary is a real
    // evaluation: a conflict is published and an empty set clears the condition.
    it('publishes the evaluated set when the eager host fails after applying', async () => {
      const conflicted = stubSdkOnly({
        phase: 'failed',
        message: 'Plugin Workload SDK mcp-host could not start',
        networkPolicies: {
          conflicts: [
            {
              policy: 'test-recipe-workload-to-mcp-host-sdk-ingress',
              reason: 'owner-reference-mismatch',
            },
          ],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const failedWithConflict = await reconciler.reconcile(sdkOnlyRecipe())

      expect(conflicted).toHaveBeenCalledTimes(1)
      expect(failedWithConflict.phase).toBe('failed')
      expect(failedWithConflict.networkPolicyOwnershipConditions).toEqual([
        expect.objectContaining({
          type: 'WorkflowNetworkPolicyOwnership',
          status: 'False',
          reason: 'OwnershipConflict',
          message: expect.stringContaining(
            'test-recipe-workload-to-mcp-host-sdk-ingress (owner-reference-mismatch)'
          ),
        }),
      ])

      const converged = stubSdkOnly({
        phase: 'failed',
        message: 'Plugin Workload SDK mcp-host could not start',
        networkPolicies: {
          conflicts: [],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const failedConverged = await reconciler.reconcile(sdkOnlyRecipe([ownershipCondition]))

      expect(converged).toHaveBeenCalledTimes(1)
      expect(failedConverged.phase).toBe('failed')
      expect(failedConverged.networkPolicyOwnershipConditions).toEqual([])
    })

    // A policy being deleted is retried on the transient path. The twin with
    // retryPending false shows that no other input of the requeue expression is
    // set, so the first requeue can only come from the pending retry.
    it('requeues on the transient path while a policy is being deleted', async () => {
      const pending = stubSdkOnly({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: bootstrapProof,
        networkPolicies: {
          conflicts: [],
          retryPending: true,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const retrying = await reconciler.reconcile(sdkOnlyRecipe())

      expect(pending).toHaveBeenCalledTimes(1)
      expect(retrying.phase).toBe('active')
      expect(retrying.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(retrying.requeueFixedInterval).toBe(false)
      // Being deleted is not a conflict; the only owned condition is the
      // RetryPending marker the short-circuits key their reapply on.
      expect(retrying.networkPolicyOwnershipConditions).toEqual([
        expect.objectContaining({
          type: 'WorkflowNetworkPoliciesConverged',
          status: 'False',
          reason: 'RetryPending',
        }),
      ])

      const settled = stubSdkOnly({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: bootstrapProof,
        networkPolicies: {
          conflicts: [],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const steady = await reconciler.reconcile(sdkOnlyRecipe())

      expect(settled).toHaveBeenCalledTimes(1)
      expect(steady.phase).toBe('active')
      expect(steady.requeueAfterMs).toBeUndefined()
      expect(steady.networkPolicyOwnershipConditions).toEqual([])
    })

    // The mcp-host pod failed after an apply that left a policy being deleted.
    // The `failed` return must still requeue, or nothing rewrites the policy
    // until the next CR event. The twin with retryPending false shows the
    // `failed` return sets no requeue of its own, so the first one can only
    // come from the pending retry.
    it('requeues a failed pass on the transient path while a policy is being deleted', async () => {
      const pending = stubSdkOnly({
        phase: 'failed',
        message: 'Plugin Workload SDK mcp-host could not start',
        networkPolicies: {
          conflicts: [],
          retryPending: true,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const retrying = await reconciler.reconcile(sdkOnlyRecipe())

      expect(pending).toHaveBeenCalledTimes(1)
      expect(retrying.phase).toBe('failed')
      expect(retrying.message).toBe('Plugin Workload SDK mcp-host could not start')
      expect(retrying.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(retrying.requeueFixedInterval).toBe(false)
      expect(retrying.networkPolicyOwnershipConditions).toEqual([
        expect.objectContaining({
          type: 'WorkflowNetworkPoliciesConverged',
          status: 'False',
          reason: 'RetryPending',
        }),
      ])

      const settled = stubSdkOnly({
        phase: 'failed',
        message: 'Plugin Workload SDK mcp-host could not start',
        networkPolicies: {
          conflicts: [],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })

      const terminal = await reconciler.reconcile(sdkOnlyRecipe())

      expect(settled).toHaveBeenCalledTimes(1)
      expect(terminal.phase).toBe('failed')
      expect(terminal.message).toBe('Plugin Workload SDK mcp-host could not start')
      expect(terminal.networkPolicyOwnershipConditions).toEqual([])
      expect(terminal.requeueAfterMs).toBeUndefined()
    })

    // Removing spec.pluginWorkloadSdk tears the runtime down and falls through
    // to the transport return without an SDK runtime. No policy is managed any
    // more, so the lane must send `[]` (clear), not undefined (keep).
    it('clears a published condition once the SDK capability is removed from the spec', async () => {
      const sdkOnly = stubSdkOnly({})
      const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
      ;(
        reconciler as unknown as {
          workflowReconciler: { cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk }
        }
      ).workflowReconciler.cleanupPluginWorkloadSdk = cleanupPluginWorkloadSdk
      const recipe = makeRecipe({
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        },
        status: {
          phase: 'active',
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
          conditions: [ownershipCondition],
        },
      } as Partial<WorkflowRecipeCRD>)

      const result = await reconciler.reconcile(recipe)

      // Liveness witness: the capability-removal teardown ran and the pass
      // reached the transport return, not the SDK-only lane.
      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledTimes(1)
      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
        preserveWorkflowRuntime: false,
        recipeUid: 'uid-123',
      })
      expect(sdkOnly).not.toHaveBeenCalled()
      expect(result.phase).not.toBe('failed')
      expect(result.networkPolicyOwnershipConditions).toEqual([])
      expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
      // The pass itself may patch an intermediate phase; the status write under
      // test is the one patchStatus adds.
      const patchesBefore = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.length

      await reconciler.patchStatus(recipe, result)

      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(
        patchesBefore + 1
      )
      const conditions = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body
        .status.conditions as Array<{ type: string }>
      expect(conditions.length).toBeGreaterThan(0)
      expect(conditions.map(condition => condition.type)).not.toContain(
        'WorkflowNetworkPolicyOwnership'
      )
    })

    // R4-L3: the teardown removed every SDK-owned policy, including the
    // legacy one by name, so the lane without an SDK runtime is `unmanaged`:
    // a prune it can no longer finish is not carried as PrunePending.
    const prunePendingMarker = () =>
      buildNetworkPolicyConvergedCondition(
        { apply: 'converged', prune: 'pending' },
        '2026-09-23T10:00:00.000Z',
        undefined
      )!
    const capabilityRemovedRecipe = (phase: string, conditions: unknown[]) =>
      makeRecipe({
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        },
        status: {
          phase,
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
          conditions,
        },
      } as Partial<WorkflowRecipeCRD>)
    const stubCapabilityRemovalTeardown = () => {
      stubSdkOnly({})
      const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
      ;(
        reconciler as unknown as {
          workflowReconciler: { cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk }
        }
      ).workflowReconciler.cleanupPluginWorkloadSdk = cleanupPluginWorkloadSdk
      return cleanupPluginWorkloadSdk
    }

    it.each(['SDK-never-published', 'steps-removed'] as const)(
      'R5-L1: %s without an SDK runtime or teardown keeps its published apply, prune and legacy facts',
      async history => {
        const cleanup = stubCapabilityRemovalTeardown()
        const inner = (reconciler as unknown as { workflowReconciler: WorkflowReconciler })
          .workflowReconciler
        const retryLegacy = vi.fn().mockResolvedValue('pending')
        inner.retryLegacyMcpServersInternetEgressDelete = retryLegacy
        inner.legacyMcpServersInternetEgressRetryDelayMs = vi.fn().mockReturnValue(60_000)
        const facts = networkPolicyMarkerConditions(
          {
            kind: 'reconcile',
            summary: { conflicts: [], retryPending: true, prune: 'pending', legacy: 'pending' },
          },
          [],
          '2026-09-23T10:00:00.000Z'
        )
        const recipe = makeRecipe({
          spec: {
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            ...(history === 'steps-removed' ? { steps: [] } : {}),
          },
          status: {
            phase: 'active',
            conditions: [ownershipCondition, ...facts],
            ...(history === 'steps-removed' ? { workflowExecution: { phase: 'completed' } } : {}),
          },
        })
        expect(recipe.spec.pluginWorkloadSdk).toBeUndefined()
        expect(recipe.status?.pluginWorkloadSdk).toBeUndefined()

        const result = await reconciler.reconcile(recipe)

        expect(retryLegacy).toHaveBeenCalledWith('test-recipe', 'uid-123')
        expect(cleanup).not.toHaveBeenCalled()
        expect(result.networkPolicyOwnershipConditions).toBeUndefined()
        expect(result.requeueAfterMs).toBe(60_000)
        expect(result.requeueOperation).toBe('legacy-network-policy-delete')
        await reconciler.patchStatus(recipe, result)
        const published = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body
          .status.conditions as StatusCondition[]
        for (const fact of [ownershipCondition, ...facts]) {
          expect(published).toContainEqual(fact)
        }
      }
    )

    it('R4-L3: clears a published PrunePending marker once the SDK capability is removed from the spec', async () => {
      const cleanupPluginWorkloadSdk = stubCapabilityRemovalTeardown()
      const recipe = capabilityRemovedRecipe('active', [ownershipCondition, prunePendingMarker()])

      const result = await reconciler.reconcile(recipe)

      // Liveness witness: the capability-removal teardown ran.
      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
        preserveWorkflowRuntime: false,
        recipeUid: 'uid-123',
      })
      expect(result.phase).not.toBe('failed')
      expect(result.networkPolicyOwnershipConditions).toEqual([])
    })

    it('R4-L3: clears a published PrunePending marker when the SDK capability is removed from a failed recipe', async () => {
      const cleanupPluginWorkloadSdk = stubCapabilityRemovalTeardown()
      const recipe = capabilityRemovedRecipe('failed', [ownershipCondition, prunePendingMarker()])

      await reconciler.reconcile(recipe)

      // Liveness witness: the capability-removal teardown ran.
      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
        preserveWorkflowRuntime: false,
        recipeUid: 'uid-123',
      })
      const conditionPatches = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls
        .map(call => call[0].body.status)
        .filter(status => Object.keys(status).length === 1 && 'conditions' in status)
      expect(conditionPatches).toHaveLength(1)
      const types = (conditionPatches[0].conditions as Array<{ type: string }>).map(c => c.type)
      expect(types).not.toContain('WorkflowNetworkPoliciesConverged')
      expect(types).not.toContain('WorkflowNetworkPolicyOwnership')
    })
  })

  // awaiting_policy waits for an operator grant. The grant arrives by event
  // (handleGrantUpdateNotification) or by the 30s credential-refresh floor, so a
  // fixed 5s poll cannot make the state advance. It must keep requeueing, but on
  // the transient backoff path rather than the fixed progress interval.
  describe('SDK-only recipe awaiting operator policy', () => {
    const reconcileAwaitingPolicy = async () => {
      const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
        phase: 'awaiting_policy',
        message: 'operator policy pending (policy_not_ready)',
        networkPolicies: {
          conflicts: [],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })
      ;(
        reconciler as unknown as {
          config: { pluginWorkloadSdkEnabled: boolean }
          workflowReconciler: {
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          }
        }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          }
        }
      ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

      const recipe = makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
      })
      const result = await reconciler.reconcile(recipe)

      // Liveness witness: the awaiting_policy branch ran, and the watcher's
      // projection of this result publishes PluginWorkloadSdkPolicyPending=True.
      expect(reconcilePluginWorkloadSdkOnly).toHaveBeenCalledTimes(1)
      expect(result.pluginWorkloadSdkPolicyPending).toBe(true)
      expect(result.message).toBe('operator policy pending (policy_not_ready)')
      expect(reconciler.projectPluginWorkloadSdk(recipe, result).conditions).toContainEqual(
        expect.objectContaining({
          type: PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
          status: 'True',
        })
      )
      return result
    }

    it('does not requeue at a fixed interval', async () => {
      const result = await reconcileAwaitingPolicy()

      expect(result.requeueFixedInterval).toBe(false)
    })

    it('still requeues, on the transient backoff base', async () => {
      const result = await reconcileAwaitingPolicy()

      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    })
  })

  it('cleans SDK-only runtime resources after the capability is removed without invoking workflow reconciliation', async () => {
    const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
    const workflowReconcile = vi.fn()
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, cleanupPluginWorkloadSdk }

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
      preserveWorkflowRuntime: false,
      recipeUid: 'uid-123',
    })
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it.each(['failed', 'deprecated', 'rollback-failed'] as const)(
    'cleans a removed SDK capability even when the recipe is already %s',
    async phase => {
      const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
      ;(
        reconciler as unknown as {
          workflowReconciler: { cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk }
        }
      ).workflowReconciler = { cleanupPluginWorkloadSdk }

      const result = await reconciler.reconcile(
        makeRecipe({
          status: {
            phase,
            pluginWorkloadSdk: {
              state: 'validated',
              promptBridge: true,
              clientNotifications: false,
            },
          },
        })
      )

      expect(result.phase).toBe(phase)
      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
        preserveWorkflowRuntime: false,
        recipeUid: 'uid-123',
      })
    }
  )

  it('tears down an existing SDK-only host when the global feature flag is disabled', async () => {
    const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
    const workflowReconcile = vi.fn()
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
        }
      }
    ).config.pluginWorkloadSdkEnabled = false
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, cleanupPluginWorkloadSdk }

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
        },
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'active',
      pluginWorkloadSdkTeardownConfirmed: true,
      message: 'Plugin Workload SDK disabled after confirmed teardown',
    })
    expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
      preserveWorkflowRuntime: false,
      recipeUid: 'uid-123',
    })
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it.each(['kill-switch', 'capability-removal'] as const)(
    'R5-L2: %s cleanup passes the live UID and preserves the exact legacy backoff',
    async branch => {
      const cleanup = vi.fn()
      const retry = vi.fn()
      const delay = vi.fn()
      const internal = reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: unknown
      }
      internal.config.pluginWorkloadSdkEnabled = branch !== 'kill-switch'
      internal.workflowReconciler = {
        cleanupPluginWorkloadSdk: cleanup,
        retryLegacyMcpServersInternetEgressDelete: retry,
        legacyMcpServersInternetEgressRetryDelayMs: delay,
      }
      const conditions = networkPolicyMarkerConditions(
        {
          kind: 'reconcile',
          summary: { conflicts: [], retryPending: true, prune: 'pending', legacy: 'pending' },
        },
        [],
        '2026-09-23T10:00:00.000Z'
      )
      const recipe = makeRecipe({
        spec: {
          workloads: [],
          ...(branch === 'kill-switch' ? { pluginWorkloadSdk: { allowedCallers: [] } } : {}),
        },
        status: {
          phase: 'active',
          conditions,
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
        },
      })
      for (const remaining of [60_000, 40_123, 999]) {
        cleanup.mockRejectedValue(
          new LegacyNetworkPolicyDeletePendingError('test-recipe', remaining)
        )
        const result = await reconciler.reconcile(recipe)
        expect(cleanup).toHaveBeenLastCalledWith('test-recipe', {
          preserveWorkflowRuntime: false,
          recipeUid: 'uid-123',
        })
        expect(result.requeueAfterMs).toBe(remaining)
        expect(result.requeueFixedInterval).toBe(true)
        expect(result.requeueOperation).toBeUndefined()
        expect(result.skipStatusPatch).toBe(true)
        expect(result.networkPolicyOwnershipConditions).toBeUndefined()
        expect(result.pluginWorkloadSdkTeardownConfirmed).toBeUndefined()
        expect(recipe.status?.conditions).toEqual(conditions)
      }
      expect(retry).not.toHaveBeenCalled()
      expect(delay).not.toHaveBeenCalled()
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    }
  )

  // The kill switch returns before the SDK-only lane, which is the only path
  // that clears the ownership condition. With the runtime torn down no policy
  // is managed, so a conflict published earlier is stale.
  it('clears a published NetworkPolicy ownership condition after the feature-flag teardown', async () => {
    const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
    const reconcilePluginWorkloadSdkOnly = vi.fn()
    ;(
      reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
    ).config.pluginWorkloadSdkEnabled = false
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).workflowReconciler = { cleanupPluginWorkloadSdk, reconcilePluginWorkloadSdkOnly }
    const ownershipConflict = {
      type: 'WorkflowNetworkPolicyOwnership',
      status: 'False' as const,
      reason: 'OwnershipConflict',
      message:
        'NetworkPolicy ownership conflict: test-recipe-mcp-host-to-gfs (owner-reference-mismatch)',
      lastTransitionTime: '2026-09-23T10:00:00.000Z',
    }
    const recipe = makeRecipe({
      status: {
        phase: 'active',
        pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
        conditions: [ownershipConflict],
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
      },
    } as Partial<WorkflowRecipeCRD>)

    const result = await reconciler.reconcile(recipe)

    // Liveness witness: the teardown ran and the kill-switch return produced
    // this result, not the SDK-only lane.
    expect(cleanupPluginWorkloadSdk).toHaveBeenCalledTimes(1)
    expect(result.pluginWorkloadSdkTeardownConfirmed).toBe(true)
    expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
    expect(result.networkPolicyOwnershipConditions).toEqual([])
    // The watcher writes this result, so the cleared set reaches the status.
    expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)

    await reconciler.patchStatus(recipe, result)

    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    const conditions = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body.status
      .conditions as Array<{ type: string }>
    expect(conditions.length).toBeGreaterThan(0)
    expect(conditions.map(condition => condition.type)).not.toContain(
      'WorkflowNetworkPolicyOwnership'
    )
  })

  it('degrades an active recipe when observed child Deployment readiness drifts', async () => {
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1', generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'app',
        phase: 'degraded',
        ready: false,
        message:
          'Deployment "' +
          resolveScopedWorkloadResourceName(makeRecipe(), 'app') +
          '" updated/ready/available/desired 1/0/0/1',
      },
    ])
  })

  it('treats a fully-available Deployment as ready when observedGeneration transiently lags (no false degraded flap)', async () => {
    // Regression (prod "degraded↔active" flap): WRC's non-idempotent full-replace apply
    // re-defaults server-managed Deployment fields every reconcile, bumping metadata.generation
    // with no real change. A fully-available Deployment (updated/ready/available 1/1/1) therefore
    // momentarily reports observedGeneration < generation. That transient bookkeeping lag must NOT
    // flip the recipe to degraded — replica health is the real readiness signal.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '598', generation: 598 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 597,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
      },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([{ id: 'app', phase: 'deployed', ready: true }])
  })

  it('treats a fully-ready StatefulSet as ready when observedGeneration transiently lags', async () => {
    observeLiveStatefulSetAs({
      generation: 265,
      spec: { replicas: 1 },
      status: { observedGeneration: 264, readyReplicas: 1 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'db', type: 'statefulset', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([{ id: 'db', phase: 'deployed', ready: true }])
  })

  it('keeps a Deployment degraded when its rollout exceeded the progress deadline', async () => {
    // The progress-deadline gate is the genuine stuck-rollout signal and must survive: even with
    // all replicas reporting ready, a ProgressDeadlineExceeded condition still degrades the workload.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '3', generation: 3 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 3,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }],
      },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.workloadStatuses[0].ready).toBe(false)
    expect(result.workloadStatuses[0].message).toContain('ProgressDeadlineExceeded')
  })

  it('degrades when a child Deployment was externally scaled below recipe replicas', async () => {
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '2', generation: 2 },
      spec: { replicas: 0 },
      status: { observedGeneration: 2, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'app',
        phase: 'degraded',
        ready: false,
        message:
          'Deployment "' +
          resolveScopedWorkloadResourceName(makeRecipe(), 'app') +
          '" updated/ready/available/desired 0/0/0/1',
      },
    ])
  })

  it('degrades when a child StatefulSet was externally scaled below recipe replicas', async () => {
    observeLiveStatefulSetAs({
      generation: 2,
      spec: { replicas: 0 },
      status: { observedGeneration: 2, readyReplicas: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'db', type: 'statefulset', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'db',
        phase: 'degraded',
        ready: false,
        message:
          'StatefulSet "' +
          resolveScopedStatefulSetResourceName(
            makeRecipe({
              spec: {
                workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }],
              },
            }),
            'db'
          ) +
          '" readyReplicas 0/1',
      },
    ])
  })

  it('recovers a degraded recipe when observed child Deployment readiness returns', async () => {
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1', generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'degraded',
          message: 'Some workloads not ready',
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              phase: 'degraded',
              ready: false,
              message: 'Deployment "app" updated/ready/available/desired 1/0/0/1',
            },
          ],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([{ id: 'app', phase: 'deployed', ready: true }])
  })

  it('degrades a DaemonSet workload when no pods are scheduled', async () => {
    mockAppsApi.readNamespacedDaemonSet.mockRejectedValueOnce({ code: 404 }).mockResolvedValue({
      metadata: { resourceVersion: '2', generation: 2 },
      status: { observedGeneration: 2, desiredNumberScheduled: 0, numberReady: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [{ id: 'agent', type: 'daemonset', image: 'agent:test' }],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'agent', type: 'daemonset', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'agent',
        phase: 'degraded',
        ready: false,
        message:
          'DaemonSet "' +
          resolveScopedWorkloadResourceName(
            makeRecipe({
              spec: {
                workloads: [{ id: 'agent', type: 'daemonset', image: 'agent:test' }],
              },
            }),
            'agent'
          ) +
          '" readyReplicas 0/0',
      },
    ])
  })

  // ─── issue #575: live NetworkPolicy convergence ────────────────────────
  describe('applyNetworkPolicy live convergence (issue #575)', () => {
    const SPEC_HASH = 'clerum.io/spec-hash'
    const NS = 'sandbox-recipes'
    const clone = <T>(value: T): T => structuredClone(value)
    type Priv = {
      applyNetworkPolicy: (
        policy: k8s.V1NetworkPolicy,
        namespace: string,
        options: {
          family: NetworkPolicyFamily
          existing?: k8s.V1NetworkPolicy | null
          recipeName?: string
        }
      ) => Promise<void>
    }
    const apply = (
      policy: k8s.V1NetworkPolicy,
      family: NetworkPolicyFamily = 'workload-ingress',
      existing?: k8s.V1NetworkPolicy | null
    ) =>
      (reconciler as unknown as Priv).applyNetworkPolicy(policy, NS, {
        family,
        ...(existing === undefined ? {} : { existing }),
      })

    const plainPolicy = (): k8s.V1NetworkPolicy => ({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'wl-ingress-r-w',
        namespace: NS,
        labels: { 'clerum.io/managed-by': 'workflow-recipes', 'clerum.io/recipe': 'r' },
      },
      spec: {
        podSelector: { matchLabels: { 'clerum.io/workload': 'w' } },
        policyTypes: ['Ingress'],
        ingress: [{ ports: [{ port: 8080, protocol: 'TCP' }] }],
      },
    })

    const intdepPolicy = (): k8s.V1NetworkPolicy => ({
      ...plainPolicy(),
      metadata: {
        name: 'wr-intdep-egress-r-w',
        namespace: NS,
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'r',
          'clerum.io/policy-type': 'internal-dependency',
        },
      },
    })

    const gatewayPolicy = (ownerUid = 'uid-current'): k8s.V1NetworkPolicy => ({
      ...plainPolicy(),
      metadata: {
        name: 'allow-webhook-proxy-ingress-r',
        namespace: NS,
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe-namespace': NS,
          'clerum.io/recipe-name': 'r',
          'clerum.io/webhook-gateway': 'true',
        },
        ownerReferences: [
          {
            apiVersion: 'clerum.io/v1alpha1',
            kind: 'WorkflowRecipe',
            name: 'r',
            uid: ownerUid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
    })

    const livePolicy = (
      desired: k8s.V1NetworkPolicy,
      metadata: Partial<k8s.V1ObjectMeta> = {}
    ): k8s.V1NetworkPolicy => ({
      ...clone(desired),
      metadata: {
        ...clone(desired.metadata ?? {}),
        resourceVersion: '9',
        ...metadata,
      },
    })

    const families: NetworkPolicyFamily[] = [
      'ui-ingress',
      'workload-ingress',
      'workload-egress',
      'internal-dependency',
      'oauth-broker-egress',
      'webhook-gateway',
    ]
    const policyForFamily = (family: NetworkPolicyFamily) =>
      family === 'webhook-gateway'
        ? gatewayPolicy()
        : family === 'internal-dependency'
          ? intdepPolicy()
          : plainPolicy()

    it.each(['ui-ingress', 'workload-ingress', 'workload-egress'] as const)(
      'preserves the dev recipe-ownership boundary on the supplied %s snapshot',
      async family => {
        const desired = plainPolicy()
        const live = livePolicy(desired)
        live.metadata!.labels!['clerum.io/recipe'] = 'another-recipe'
        mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(livePolicy(desired))
        await expect(
          (reconciler as unknown as Priv).applyNetworkPolicy(desired, NS, {
            family,
            recipeName: 'r',
            existing: live,
          })
        ).rejects.toMatchObject({ name: 'NetworkPolicyOwnershipConflictError' })
        expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      }
    )

    it.each(['ui-ingress', 'workload-ingress', 'workload-egress'] as const)(
      'keeps owned %s read-only until real drift and replaces the validated version',
      async family => {
        const desired = plainPolicy()
        const live = livePolicy(desired)
        const options = { family, recipeName: 'r', existing: live }
        await (reconciler as unknown as Priv).applyNetworkPolicy(desired, NS, options)
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
        desired.spec!.podSelector = { matchLabels: { updated: 'selector' } }
        await (reconciler as unknown as Priv).applyNetworkPolicy(desired, NS, options)
        expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        expect(
          mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0].body.metadata
            .resourceVersion
        ).toBe('9')
      }
    )

    it.each(families)(
      'preserves external metadata while repairing real %s spec drift',
      async family => {
        const desired = policyForFamily(family)
        desired.metadata!.labels!['clerum.io/test-contract'] = 'current'
        desired.metadata!.annotations = {
          'clerum.io/test-contract': 'current',
          [SPEC_HASH]: 'obsolete',
        }
        const live = livePolicy(desired)
        live.metadata!.labels!['clerum.io/test-contract'] = 'stale'
        live.metadata!.labels!['admission.example/tier'] = 'audited'
        live.metadata!.annotations = {
          'admission.example/audit': 'keep',
          'clerum.io/test-contract': 'stale',
          [SPEC_HASH]: 'legacy',
          'clerum.io/egress-fqdn-state': 'stale-state',
          'clerum.io/egress-fqdn-targets': 'stale-targets',
          'clerum.io/egress-fqdn-resolved-at': 'stale-time',
        }
        live.metadata!.finalizers = ['admission.example/cleanup']
        live.spec!.podSelector = {}
        const desiredBefore = clone(desired)
        const liveBefore = clone(live)
        mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)

        await apply(desired, family)

        expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        const body = mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0].body
        expect(body.metadata.labels).toEqual({
          ...desired.metadata!.labels,
          'admission.example/tier': 'audited',
        })
        expect(body.metadata.annotations).toEqual({
          'admission.example/audit': 'keep',
          'clerum.io/test-contract': 'current',
        })
        expect(body.metadata.finalizers).toEqual(['admission.example/cleanup'])
        expect(body.metadata.ownerReferences).toEqual(desired.metadata!.ownerReferences)
        expect(body.metadata.resourceVersion).toBe('9')
        expect(body.spec).toEqual(desired.spec)
        expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        expect(desired).toEqual(desiredBefore)
        expect(live).toEqual(liveBefore)
      }
    )

    it.each(families)(
      'performs zero create/replace calls for equivalent %s with external metadata',
      async family => {
        const desired = policyForFamily(family)
        const live = livePolicy(desired)
        live.metadata!.labels!['admission.example/tier'] = 'audited'
        live.metadata!.annotations = { 'admission.example/audit': 'keep', [SPEC_HASH]: 'legacy' }
        live.metadata!.finalizers = ['admission.example/cleanup']
        mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)

        await apply(desired, family)

        expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
      }
    )

    it('vetoes an additional non-controller owner instead of removing it on gateway replace', async () => {
      const desired = gatewayPolicy()
      const live = livePolicy(desired)
      live.metadata!.ownerReferences!.push({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        name: 'foreign',
        uid: 'foreign',
      })
      live.spec!.podSelector = {}
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)

      await expect(apply(desired, 'webhook-gateway')).rejects.toMatchObject({
        name: 'NetworkPolicyOwnershipConflictError',
      })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
    })

    it('removes retired workload-egress state once without churning external metadata', async () => {
      const desired = plainPolicy()
      desired.metadata!.name = 'wl-egress-r-w'
      const live = livePolicy(desired, {
        annotations: {
          'admission.example/audit': 'keep',
          'clerum.io/egress-fqdn-state': 'retired',
          'clerum.io/egress-fqdn-targets': 'retired',
          'clerum.io/egress-fqdn-resolved-at': 'retired',
        },
      })
      const priv = reconciler as unknown as {
        egressWriteNeeded: (existing: k8s.V1NetworkPolicy, desired: k8s.V1NetworkPolicy) => boolean
      }
      expect(priv.egressWriteNeeded(live, desired)).toBe(true)
      await apply(desired, 'workload-egress', live)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const updated = mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0].body
      expect(updated.metadata.annotations).toEqual({ 'admission.example/audit': 'keep' })
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

      expect(priv.egressWriteNeeded(updated, desired)).toBe(false)
      await apply(desired, 'workload-egress', updated)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
    })

    it('T1 skips a live-equivalent policy and emits a structured liveness witness', async () => {
      const desired = plainPolicy()
      const live = livePolicy(desired, { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      live.spec!.ingress![0].ports![0].protocol = undefined
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)
      const captured = captureNetworkPolicyLogs()
      try {
        await apply(desired)
        expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(captured.entries).toContainEqual(
          expect.objectContaining({
            level: 'info',
            msg: 'network policy unchanged; skipping update',
            policy: 'wl-ingress-r-w',
            namespace: NS,
            family: 'workload-ingress',
          })
        )
      } finally {
        captured.restore()
      }
    })

    it('T2 repairs live spec drift even when the legacy spec-hash is preserved', async () => {
      const desired = plainPolicy()
      const live = livePolicy(desired, { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      live.spec!.podSelector = {}
      live.spec!.ingress = [{}]
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)

      await apply(desired)

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = (
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
          body: k8s.V1NetworkPolicy
        }
      ).body
      expect(body.metadata?.resourceVersion).toBe('9')
      expect(body.metadata?.annotations?.[SPEC_HASH]).toBeUndefined()
      expect(body.spec).toEqual(desired.spec)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('does not let a supplied cluster-local wl-egress snapshot veto detected drift', async () => {
      const desired = plainPolicy()
      desired.metadata!.name = 'wl-egress-r-w'
      desired.spec = {
        podSelector: { matchLabels: { 'clerum.io/workload': 'w' } },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ podSelector: { matchLabels: { 'clerum.io/workload': 'db' } } }],
            ports: [{ port: 5432, protocol: 'TCP' }],
          },
        ],
      }
      const live = livePolicy(desired, { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      live.spec!.podSelector = {}

      await apply(desired, 'workload-egress', live)

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(
        (
          mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
            body: k8s.V1NetworkPolicy
          }
        ).body.spec?.podSelector
      ).toEqual(desired.spec.podSelector)
    })

    it('routes workload-egress label drift through the live apply prefilter', () => {
      const desired = plainPolicy()
      desired.metadata!.name = 'wl-egress-r-w'
      desired.spec = { podSelector: {}, policyTypes: ['Egress'], egress: [] }
      const live = livePolicy(desired)
      live.metadata!.labels = { ...live.metadata!.labels, 'clerum.io/recipe': 'wrong' }

      const writeNeeded = (
        reconciler as unknown as {
          egressWriteNeeded: (
            existing: k8s.V1NetworkPolicy | null,
            wanted: k8s.V1NetworkPolicy
          ) => boolean
        }
      ).egressWriteNeeded(live, desired)

      expect(writeNeeded).toBe(true)

      live.metadata!.labels = desired.metadata!.labels
      live.metadata!.ownerReferences = [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: 'foreign',
          uid: 'foreign-uid',
          controller: true,
        },
      ]
      expect(
        (
          reconciler as unknown as {
            egressWriteNeeded: (
              existing: k8s.V1NetworkPolicy | null,
              wanted: k8s.V1NetworkPolicy
            ) => boolean
          }
        ).egressWriteNeeded(live, desired)
      ).toBe(true)
    })

    it('T3 creates on 404 and the next equivalent reconcile is read-only', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

      await apply(desired)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const created = clone(
        (
          mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
            body: k8s.V1NetworkPolicy
          }
        ).body
      )
      expect(created.metadata?.annotations?.[SPEC_HASH]).toBeUndefined()

      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(livePolicy(created))

      await apply(desired)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('T4 propagates a foreign intdep ownership veto after exactly one read', async () => {
      const desired = intdepPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockResolvedValueOnce({
          metadata: {
            name: 'wr-intdep-egress-r-w',
            resourceVersion: '9',
            labels: { 'clerum.io/managed-by': 'hcc' },
          },
        })
        .mockRejectedValueOnce({ code: 503 })

      const rejection = await apply(desired, 'internal-dependency').then(
        () => new Error('expected the ownership assertion to reject'),
        (error: unknown) => error as Error
      )
      expect(rejection.name).toBe('NetworkPolicyOwnershipConflictError')
      expect(rejection.message).toMatch(/Refusing to replace NetworkPolicy "wr-intdep-egress-r-w"/)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('T4b lets an intdep policy WRC owns converge read-only', async () => {
      const desired = intdepPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(livePolicy(desired))

      await expect(apply(desired, 'internal-dependency')).resolves.toBeUndefined()

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('T5 retries an HTTP read failure, replaces with the recovered RV, and logs safely', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 500, authorization: 'Bearer must-not-appear' })
        .mockResolvedValueOnce(livePolicy(desired))
      const captured = captureNetworkPolicyLogs()
      try {
        await apply(desired)

        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
        expect(
          (
            mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
              body: k8s.V1NetworkPolicy
            }
          ).body.metadata?.resourceVersion
        ).toBe('9')
        expect(captured.entries).toContainEqual(
          expect.objectContaining({
            level: 'info',
            msg: 'network policy replaced',
            policy: desired.metadata!.name,
            namespace: NS,
            family: 'workload-ingress',
            reason: 'read-recovery',
          })
        )
        const warning = captured.entries.find(
          entry => entry.msg === 'network policy read unavailable; retrying once'
        )
        expect(warning).toEqual(
          expect.objectContaining({
            level: 'warn',
            errorName: 'NetworkPolicyInfraError',
            errorCode: 500,
            retryable: true,
          })
        )
        expect(JSON.stringify(warning)).not.toContain('must-not-appear')
      } finally {
        captured.restore()
      }
    })

    it('T5b retries a transport read failure once and replaces', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 'ECONNRESET' })
        .mockResolvedValueOnce(livePolicy(desired))

      await apply(desired)

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    })

    it('T5c retries a codeless read failure once and replaces', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce(new Error('transient read timeout'))
        .mockResolvedValueOnce(livePolicy(desired))

      await apply(desired)

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    })

    it('repairs the gateway owner UID and refuses a foreign controller owner', async () => {
      const desired = gatewayPolicy('uid-current')
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(
        livePolicy(gatewayPolicy('uid-old'), { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      )

      await apply(desired, 'webhook-gateway')

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = (
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
          body: k8s.V1NetworkPolicy
        }
      ).body
      expect(body.metadata?.ownerReferences?.[0].uid).toBe('uid-current')

      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      const foreign = livePolicy(desired)
      foreign.metadata!.ownerReferences = [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: 'foreign',
          uid: 'foreign-uid',
          controller: true,
        },
      ]
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(foreign)

      await expect(apply(desired, 'webhook-gateway')).rejects.toMatchObject({
        name: 'NetworkPolicyOwnershipConflictError',
      })
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('handles a read/create race by re-reading instead of blind replacing', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 404 })
        .mockResolvedValueOnce(livePolicy(desired))
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 409 })

      await apply(desired)

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('creates after a transient first read is followed by a confirmed 404', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 500 })
        .mockRejectedValueOnce({ code: 404 })

      await apply(desired)

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('uses a supplied absent workload-egress snapshot without issuing another read', async () => {
      const desired = plainPolicy()
      desired.metadata!.name = 'wl-egress-r-w'

      await apply(desired, 'workload-egress', null)

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('retries when a create-conflict winner is absent on the bounded re-read', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValue({ code: 404 })
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 409 })

      await expect(apply(desired)).rejects.toMatchObject({
        name: 'RetryableReconcileError',
        cause: { code: 409 },
      })
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('retries instead of blind replacing a drifted live policy without resourceVersion', async () => {
      const desired = plainPolicy()
      const live = livePolicy(desired)
      delete live.metadata!.resourceVersion
      live.spec!.podSelector = {}
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)

      await expect(apply(desired)).rejects.toMatchObject({
        name: 'RetryableReconcileError',
        message: expect.stringMatching(/has no resourceVersion/),
      })
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it.each([404, 409])('classifies replace race status %s as retryable', async code => {
      const desired = plainPolicy()
      const live = livePolicy(desired)
      live.spec!.podSelector = {}
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce({ code })

      await expect(apply(desired)).rejects.toMatchObject({
        name: 'RetryableReconcileError',
        cause: { code },
      })
    })

    it.each([500, 'ETIMEDOUT'])('preserves replace infrastructure failure %s', async code => {
      const desired = plainPolicy()
      const live = livePolicy(desired)
      live.spec!.podSelector = {}
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)
      const apiError = Object.assign(new Error(`replace failed: ${code}`), { code })
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce(apiError)

      await expect(apply(desired)).rejects.toMatchObject({
        name: 'NetworkPolicyInfraError',
        code,
        cause: apiError,
      })
    })

    it('propagates a permanent replace rejection without reclassifying it as transient', async () => {
      const desired = plainPolicy()
      const live = livePolicy(desired)
      live.spec!.podSelector = {}
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)
      const permanent = { code: 422, reason: 'Invalid' }
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce(permanent)

      await expect(apply(desired)).rejects.toBe(permanent)
    })

    it('propagates a permanent create rejection without attempting a replace', async () => {
      const desired = plainPolicy()
      const permanent = { code: 422, reason: 'Invalid' }
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(permanent)

      await expect(apply(desired)).rejects.toBe(permanent)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('propagates a permanent second-read rejection after the bounded retry', async () => {
      const desired = plainPolicy()
      const permanent = { code: 422, reason: 'Invalid' }
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 500 })
        .mockRejectedValueOnce(permanent)

      await expect(apply(desired)).rejects.toBe(permanent)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses to create a gateway policy without a complete desired owner', async () => {
      const desired = gatewayPolicy('')

      await expect(apply(desired, 'webhook-gateway')).rejects.toMatchObject({
        name: 'NetworkPolicyOwnershipConflictError',
      })
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses a desired gateway policy with multiple controller owners before I/O', async () => {
      const desired = gatewayPolicy()
      desired.metadata!.ownerReferences!.push({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'second-controller',
        uid: 'second-controller-uid',
        controller: true,
      })

      await expect(apply(desired, 'webhook-gateway')).rejects.toMatchObject({
        name: 'NetworkPolicyOwnershipConflictError',
      })
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses a desired policy without metadata.name before I/O', async () => {
      const desired = plainPolicy()
      delete desired.metadata!.name

      await expect(apply(desired)).rejects.toThrow(/without metadata\.name/)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })
  })

  describe('idempotent apply (stops generation churn)', () => {
    const SPEC_HASH = 'clerum.io/spec-hash'
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

    afterEach(() => {
      mockAppsApi.createNamespacedDeployment.mockReset().mockResolvedValue({})
      mockAppsApi.readNamespacedDeployment
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockAppsApi.replaceNamespacedDeployment.mockReset().mockResolvedValue({})
      installLiveStatefulSetStore()
      mockAppsApi.createNamespacedDaemonSet.mockReset().mockResolvedValue({})
      mockAppsApi.readNamespacedDaemonSet
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockAppsApi.replaceNamespacedDaemonSet.mockReset().mockResolvedValue({})
      mockBatchApi.createNamespacedCronJob.mockReset().mockResolvedValue({})
      mockBatchApi.readNamespacedCronJob
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockBatchApi.replaceNamespacedCronJob.mockReset().mockResolvedValue({})
      mockBatchApi.createNamespacedJob.mockReset().mockResolvedValue({})
      mockBatchApi.readNamespacedJob
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockBatchApi.replaceNamespacedJob.mockReset().mockResolvedValue({})
    })

    it('replaces a Deployment when the desired spec-hash differs', async () => {
      const recipe = makeRecipe()
      const workload = recipe.spec.workloads![0]

      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: { [SPEC_HASH]: 'stale-or-foreign' } },
        spec: {},
      })
      mockAppsApi.replaceNamespacedDeployment.mockClear().mockResolvedValue({})

      await (
        reconciler as unknown as {
          ensureDeployment: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDeployment(workload, recipe, 'minimal', {})

      // A present object with another hash is replaced directly: no POST probe.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(0)
      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(
        mockAppsApi.replaceNamespacedDeployment.mock.calls[0][0].body.metadata.resourceVersion
      ).toBe('9')
    })

    describe('read-first apply', () => {
      type Manifest = { metadata: { name: string; namespace: string; resourceVersion?: string } }
      const ensureDeployment = (workload: unknown, recipe: unknown) =>
        (
          reconciler as unknown as {
            ensureDeployment: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureDeployment(workload, recipe, 'minimal', {})
      const ensureStatefulSet = (workload: unknown, recipe: unknown) =>
        (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(workload, recipe, 'minimal', {})

      // Stateful Deployment double: a read of an absent object is a 404, a
      // create of a present one is a 409, and a replace must carry the live
      // resourceVersion — the apiserver's own contract.
      const deploymentStore = () => {
        let live: Manifest | null = null
        mockAppsApi.readNamespacedDeployment.mockImplementation(async () => {
          if (!live) throw { code: 404 }
          return clone(live)
        })
        mockAppsApi.createNamespacedDeployment.mockImplementation(
          async ({ body }: { body: Manifest }) => {
            if (live) throw { code: 409 }
            live = { ...clone(body), metadata: { ...clone(body).metadata, resourceVersion: '1' } }
            return {}
          }
        )
        mockAppsApi.replaceNamespacedDeployment.mockImplementation(
          async ({ body }: { body: Manifest }) => {
            expect(body.metadata.resourceVersion).toBe(live?.metadata.resourceVersion)
            live = clone(body)
            return {}
          }
        )
        return { live: () => live }
      }

      it('reads an absent Deployment first, then sends exactly one POST and no PUT', async () => {
        const recipe = makeRecipe()
        const store = deploymentStore()

        await ensureDeployment(recipe.spec.workloads![0], recipe)

        const created = store.live()!
        expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalledTimes(1)
        expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalledWith({
          name: created.metadata.name,
          namespace: created.metadata.namespace,
        })
        expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
        expect(mockAppsApi.readNamespacedDeployment.mock.invocationCallOrder[0]).toBeLessThan(
          mockAppsApi.createNamespacedDeployment.mock.invocationCallOrder[0]
        )
        expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(0)
      })

      it('sends neither POST nor PUT for a live Deployment whose spec-hash is unchanged', async () => {
        const recipe = makeRecipe()
        const store = deploymentStore()
        await ensureDeployment(recipe.spec.workloads![0], recipe)
        const live = store.live()!
        mockAppsApi.readNamespacedDeployment.mockClear()
        mockAppsApi.createNamespacedDeployment.mockClear()
        mockAppsApi.replaceNamespacedDeployment.mockClear()

        await ensureDeployment(recipe.spec.workloads![0], recipe)

        // Witness: the gate read the live object before deciding not to write.
        expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalledTimes(1)
        expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalledWith({
          name: live.metadata.name,
          namespace: live.metadata.namespace,
        })
        expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(0)
        expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(0)
      })

      it('sends no PUT when another writer created the desired Deployment between read and POST', async () => {
        const recipe = makeRecipe()
        const store = deploymentStore()
        await ensureDeployment(recipe.spec.workloads![0], recipe)
        const live = store.live()!
        mockAppsApi.readNamespacedDeployment.mockClear()
        mockAppsApi.createNamespacedDeployment.mockClear()
        mockAppsApi.replaceNamespacedDeployment.mockClear()
        // The gate read misses the object the other writer is about to create.
        mockAppsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })

        await ensureDeployment(recipe.spec.workloads![0], recipe)

        expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
        // Witness: the conflict re-read the winner before deciding not to write.
        expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalledTimes(2)
        expect(mockAppsApi.readNamespacedDeployment).toHaveBeenLastCalledWith({
          name: live.metadata.name,
          namespace: live.metadata.namespace,
        })
        expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(0)
      })

      // The POST is mocked to 409 only so that the pre-read-first code reaches
      // the gate at all; with the read first, it must never be sent.
      it('propagates an unclassifiable gate-read error and writes nothing', async () => {
        const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
        const recipe = makeRecipe({ spec: { workloads: [workload] } })
        const boom = new Error('boom')
        mockCoreApi.readNamespacedService.mockRejectedValueOnce(boom)
        mockCoreApi.createNamespacedService.mockRejectedValue({ code: 409 })

        const outcome = ensureStatefulSet(workload, recipe)

        await expect(outcome).rejects.toBe(boom)
        expect(mockCoreApi.readNamespacedService).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(0)
        expect(mockCoreApi.replaceNamespacedService).toHaveBeenCalledTimes(0)
      })

      // The same failure seen from reconcile(): the phase it lands in is part
      // of the behaviour change, not an implementation detail.
      it('degrades, not fails, a recipe whose gate read hits an unclassifiable error', async () => {
        const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
        const recipe = makeRecipe({ spec: { workloads: [workload] } })
        const boom = new Error('boom')
        mockCoreApi.readNamespacedService.mockRejectedValueOnce(boom)

        const result = await reconciler.reconcile(recipe)

        expect(mockCoreApi.readNamespacedService).toHaveBeenCalled()
        expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(0)
        expect(mockCoreApi.replaceNamespacedService).toHaveBeenCalledTimes(0)
        // The workload fails like any other non-409 create failure, and the
        // recipe degrades rather than latching at the terminal `failed`:
        // degraded recipes are re-enqueued by the workload status refresh loop.
        expect(result.phase).toBe('degraded')
        expect(result.workloadStatuses).toEqual([
          { id: 'db', phase: 'failed', ready: false, message: 'Error: boom' },
        ])
      })

      it.each([
        ['an apiserver 500', { code: 500 }],
        ['an apiserver 403', { code: 403 }],
        [
          'a transport reset',
          Object.assign(new Error('connect ECONNRESET 10.0.0.1:443'), { code: 'ECONNRESET' }),
        ],
      ])('propagates a gate read that fails with %s without writing', async (_, failure) => {
        const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
        const recipe = makeRecipe({ spec: { workloads: [workload] } })
        // The first pass creates the headless Service, so a replace would have
        // a live object to write: only the gate's decision can keep the PUT out.
        await ensureStatefulSet(workload, recipe)
        mockCoreApi.readNamespacedService.mockClear()
        mockCoreApi.createNamespacedService.mockClear()
        mockCoreApi.replaceNamespacedService.mockClear()
        mockCoreApi.readNamespacedService.mockRejectedValueOnce(failure)

        await expect(ensureStatefulSet(workload, recipe)).rejects.toBe(failure)

        // Witness: the gate read ran and failed; nothing followed it.
        expect(mockCoreApi.readNamespacedService).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(0)
        expect(mockCoreApi.replaceNamespacedService).toHaveBeenCalledTimes(0)
      })

      it('propagates a failed re-read after a create conflict without writing', async () => {
        const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
        const recipe = makeRecipe({ spec: { workloads: [workload] } })
        const unavailable = { code: 503 }
        // The gate read misses, the POST loses a race, and the conflict re-read
        // fails: nothing says whether the object exists, so nothing is written.
        mockCoreApi.readNamespacedService
          .mockRejectedValueOnce({ code: 404 })
          .mockRejectedValueOnce(unavailable)
        mockCoreApi.createNamespacedService.mockRejectedValueOnce({ code: 409 })

        await expect(ensureStatefulSet(workload, recipe)).rejects.toBe(unavailable)

        // Witness: the missed read, the POST and the failed re-read all ran.
        expect(mockCoreApi.readNamespacedService).toHaveBeenCalledTimes(2)
        expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.replaceNamespacedService).toHaveBeenCalledTimes(0)
      })
    })

    describe('read-first apply of Services and ConfigMaps', () => {
      type CreateArgs = { namespace: string; body: LiveManifest }

      const clearServiceAndConfigMapCalls = () => {
        for (const fn of [
          mockCoreApi.readNamespacedService,
          mockCoreApi.createNamespacedService,
          mockCoreApi.replaceNamespacedService,
          mockCoreApi.readNamespacedConfigMap,
          mockCoreApi.createNamespacedConfigMap,
          mockCoreApi.replaceNamespacedConfigMap,
        ]) {
          fn.mockClear()
        }
      }
      const onlyPost = (create: ReturnType<typeof vi.fn>): CreateArgs => {
        expect(create).toHaveBeenCalledTimes(1)
        return create.mock.calls[0][0] as CreateArgs
      }

      it('sends neither POST nor PUT for an unchanged recipe-lane Service', async () => {
        const recipe = makeRecipe()
        await reconciler.reconcile(recipe)
        const created = onlyPost(mockCoreApi.createNamespacedService)
        const name = created.body.metadata.name
        clearServiceAndConfigMapCalls()

        await reconciler.reconcile(recipe)

        // Witness: the gate read the live Service before deciding not to write.
        expect(readsOf(mockCoreApi.readNamespacedService, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedService, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedService, name)).toBe(0)
      })

      it('keeps the live clusterIP when a changed recipe-lane Service is replaced', async () => {
        await reconciler.reconcile(makeRecipe())
        const created = onlyPost(mockCoreApi.createNamespacedService)
        const name = created.body.metadata.name
        clearServiceAndConfigMapCalls()

        await reconciler.reconcile(
          makeRecipe({
            spec: {
              workloads: [
                { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 9090 },
              ],
            },
          })
        )

        expect(postsOf(mockCoreApi.createNamespacedService, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedService, name)).toBe(1)
        const replaced = mockCoreApi.replaceNamespacedService.mock.calls[0][0] as {
          body: { metadata: { resourceVersion?: string }; spec: { clusterIP?: string } }
        }
        expect(replaced.body.spec.clusterIP).toBe(LIVE_CLUSTER_IP)
        expect(replaced.body.metadata.resourceVersion).toBe('1')
      })

      // Before the read-first change the POST went first, and a 503 on it kept
      // the phase and requeued. The same 503 on the gate read must do the same,
      // not reach a replace whose re-read 404s into a terminal `failed`.
      it('keeps the phase and requeues when the gate read of an absent Service fails with 503', async () => {
        const recipe = makeRecipe({
          status: { phase: 'active', message: 'All workloads deployed' },
        })
        mockCoreApi.readNamespacedService.mockRejectedValueOnce({ code: 503 })

        const result = await reconciler.reconcile(recipe)

        // Witness: the gate read ran exactly once and nothing was written.
        expect(mockCoreApi.readNamespacedService).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(0)
        expect(mockCoreApi.replaceNamespacedService).toHaveBeenCalledTimes(0)
        expect(result.phase).toBe('active')
        expect(result.skipStatusPatch).toBe(true)
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      })

      it('sends neither POST nor PUT for an unchanged workflow-lane Service', async () => {
        const recipe = makeRecipe({
          spec: {
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            steps: [{ id: 'run', run: snippetRun() }],
          },
        })
        const deployWorkflowWorkloads = () =>
          (
            reconciler as unknown as {
              deployWorkflowWorkloads: (
                r: WorkflowRecipeCRD,
                n: string,
                oauthBrokerTokenReapedEarly: boolean
              ) => Promise<unknown>
            }
          ).deployWorkflowWorkloads(recipe, recipe.metadata.name, false)
        await deployWorkflowWorkloads()
        const created = onlyPost(mockCoreApi.createNamespacedService)
        const name = created.body.metadata.name
        clearServiceAndConfigMapCalls()

        await deployWorkflowWorkloads()

        expect(readsOf(mockCoreApi.readNamespacedService, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedService, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedService, name)).toBe(0)
      })

      it('sends neither POST nor PUT for an unchanged resource ConfigMap', async () => {
        const res = { id: 'cfg', type: 'configmap' as const, data: { k: 'v' } }
        const recipe = makeRecipe({
          spec: {
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            resources: [res],
          },
        })
        const ensureConfigMap = () =>
          (
            reconciler as unknown as {
              ensureConfigMap: (r: unknown, recipe: WorkflowRecipeCRD) => Promise<void>
            }
          ).ensureConfigMap(res, recipe)
        await ensureConfigMap()
        const created = onlyPost(mockCoreApi.createNamespacedConfigMap)
        const name = created.body.metadata.name
        clearServiceAndConfigMapCalls()

        await ensureConfigMap()

        expect(readsOf(mockCoreApi.readNamespacedConfigMap, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedConfigMap, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedConfigMap, name)).toBe(0)
      })

      describe('a resource ConfigMap that vanished between create conflict and re-read', () => {
        const res = { id: 'cfg', type: 'configmap' as const, data: { k: 'v' } }
        const recipe = () =>
          makeRecipe({
            spec: {
              workloads: [
                { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
              ],
              resources: [res],
            },
          })
        // Both the gate read and the conflict re-read miss the ConfigMap, while
        // the POST between them collides with an object that is gone again.
        const vanishAfterConflict = async (r: WorkflowRecipeCRD) => {
          const name = (await import('./resourceBuilder')).resolveResourceName(r, res.id)
          const storeRead = mockCoreApi.readNamespacedConfigMap.getMockImplementation()!
          const storeCreate = mockCoreApi.createNamespacedConfigMap.getMockImplementation()!
          mockCoreApi.readNamespacedConfigMap.mockImplementation(
            async (args: { name: string; namespace: string }) => {
              if (args.name === name) throw { code: 404 }
              return storeRead(args)
            }
          )
          mockCoreApi.createNamespacedConfigMap.mockImplementation(async (args: CreateArgs) => {
            if (args.body.metadata.name === name) throw { code: 409 }
            return storeCreate(args)
          })
          return name
        }

        it('raises a retryable error without attempting a PUT', async () => {
          const r = recipe()
          const name = await vanishAfterConflict(r)
          clearServiceAndConfigMapCalls()

          await expect(
            (
              reconciler as unknown as {
                ensureConfigMap: (r: unknown, recipe: WorkflowRecipeCRD) => Promise<void>
              }
            ).ensureConfigMap(res, r)
          ).rejects.toMatchObject({
            name: 'RetryableReconcileError',
            message: expect.stringContaining(
              'disappeared after create conflict; a fresh reconciliation is required'
            ),
          })

          // Witness: gate read, POST, conflict re-read, in that order.
          const reads = mockCoreApi.readNamespacedConfigMap.mock.invocationCallOrder
          const post = mockCoreApi.createNamespacedConfigMap.mock.invocationCallOrder[0]
          expect(mockCoreApi.readNamespacedConfigMap).toHaveBeenCalledTimes(2)
          expect(reads[0]).toBeLessThan(post)
          expect(post).toBeLessThan(reads[1])
          expect(postsOf(mockCoreApi.createNamespacedConfigMap, name)).toBe(1)
          expect(putsOf(mockCoreApi.replaceNamespacedConfigMap, name)).toBe(0)
        })

        it('degrades the recipe with a requeue instead of failing it', async () => {
          const r = recipe()
          const name = await vanishAfterConflict(r)

          const result = await reconciler.reconcile(r)

          expect(postsOf(mockCoreApi.createNamespacedConfigMap, name)).toBe(1)
          expect(putsOf(mockCoreApi.replaceNamespacedConfigMap, name)).toBe(0)
          expect(result.phase).toBe('degraded')
          expect(result.message).toContain('disappeared after create conflict')
          expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        })
      })

      it('refuses to replace a changed resource ConfigMap owned by another recipe', async () => {
        const res = { id: 'cfg', type: 'configmap' as const, data: { k: 'v' } }
        const recipe = makeRecipe({
          spec: {
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            resources: [res],
          },
        })
        const ensureConfigMap = () =>
          (
            reconciler as unknown as {
              ensureConfigMap: (r: unknown, recipe: WorkflowRecipeCRD) => Promise<void>
            }
          ).ensureConfigMap(res, recipe)
        await ensureConfigMap()
        const created = onlyPost(mockCoreApi.createNamespacedConfigMap)
        const name = created.body.metadata.name
        clearServiceAndConfigMapCalls()
        // A ConfigMap under the same physical name, labelled for another recipe
        // and without this manifest's hash, so the gate takes the changed path.
        mockCoreApi.readNamespacedConfigMap.mockResolvedValue({
          metadata: {
            name,
            namespace: created.namespace,
            resourceVersion: '4',
            labels: { 'clerum.io/recipe': 'other-recipe' },
          },
          data: { k: 'foreign' },
        })

        await expect(ensureConfigMap()).rejects.toThrow('not owned by WorkflowRecipe')

        // Witness: the gate read the foreign object and refused it before the
        // replace path could read it again.
        expect(readsOf(mockCoreApi.readNamespacedConfigMap, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedConfigMap, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedConfigMap, name)).toBe(0)
      })

      it('refuses a hash-matching ConfigMap labelled for another recipe instead of treating it as unchanged', async () => {
        const res = { id: 'cfg', type: 'configmap' as const, data: { k: 'v' } }
        const recipe = makeRecipe({
          spec: {
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            resources: [res],
          },
        })
        const ensureConfigMap = () =>
          (
            reconciler as unknown as {
              ensureConfigMap: (r: unknown, recipe: WorkflowRecipeCRD) => Promise<void>
            }
          ).ensureConfigMap(res, recipe)
        await ensureConfigMap()
        const created = onlyPost(mockCoreApi.createNamespacedConfigMap)
        const name = created.body.metadata.name
        clearServiceAndConfigMapCalls()
        // The object WRC wrote (spec-hash and controller ownerReference intact),
        // relabelled for another recipe: the hash alone must not stand in for
        // ownership.
        mockCoreApi.readNamespacedConfigMap.mockResolvedValue({
          ...structuredClone(created.body),
          metadata: {
            ...structuredClone(created.body.metadata),
            resourceVersion: '4',
            labels: { 'clerum.io/recipe': 'other-recipe' },
          },
        })

        await expect(ensureConfigMap()).rejects.toThrow('not owned by WorkflowRecipe')

        // Witness: the gate read the foreign object before refusing it.
        expect(readsOf(mockCoreApi.readNamespacedConfigMap, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedConfigMap, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedConfigMap, name)).toBe(0)
      })
    })

    describe('read-first apply of resource Secrets', () => {
      type SecretManifest = LiveManifest & { data?: Record<string, string> }
      type CreateArgs = { namespace: string; body: SecretManifest }
      type SecretRes = {
        id: string
        type: 'secret'
        data?: Record<string, string>
        generateKeys?: string[]
      }

      // Local to this describe: many other tests override readNamespacedSecret
      // with their own fixtures, so the stateful store is not installed globally.
      beforeEach(() => {
        installLiveStore(
          {
            read: mockCoreApi.readNamespacedSecret,
            create: mockCoreApi.createNamespacedSecret,
            replace: mockCoreApi.replaceNamespacedSecret,
          },
          {}
        )
      })

      const recipeWith = (res: SecretRes) =>
        makeRecipe({
          spec: {
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            resources: [res],
          },
        })
      const ensureSecret = (res: SecretRes, recipe: WorkflowRecipeCRD) =>
        (
          reconciler as unknown as {
            ensureSecret: (r: unknown, recipe: WorkflowRecipeCRD) => Promise<void>
          }
        ).ensureSecret(res, recipe)
      const clearSecretCalls = () => {
        for (const fn of [
          mockCoreApi.readNamespacedSecret,
          mockCoreApi.createNamespacedSecret,
          mockCoreApi.replaceNamespacedSecret,
        ]) {
          fn.mockClear()
        }
      }
      const onlyPost = (): CreateArgs => {
        expect(mockCoreApi.createNamespacedSecret).toHaveBeenCalledTimes(1)
        return mockCoreApi.createNamespacedSecret.mock.calls[0][0] as CreateArgs
      }
      const readLive = (name: string, namespace: string): Promise<SecretManifest> =>
        mockCoreApi.readNamespacedSecret({ name, namespace }) as Promise<SecretManifest>
      // Models an external writer relabelling the live Secret to another recipe.
      const relabelToForeignOwner = async (name: string, namespace: string) => {
        const live = await readLive(name, namespace)
        await mockCoreApi.replaceNamespacedSecret({
          name,
          namespace,
          body: {
            ...live,
            metadata: {
              ...live.metadata,
              labels: {
                ...(live.metadata.labels as Record<string, string>),
                'clerum.io/recipe': 'other-recipe',
              },
            },
          },
        })
      }

      it('sends neither POST nor PUT for an existing generated-key Secret and keeps its keys', async () => {
        const res: SecretRes = { id: 'creds', type: 'secret', generateKeys: ['password'] }
        const recipe = recipeWith(res)
        await ensureSecret(res, recipe)
        const created = onlyPost()
        const name = created.body.metadata.name
        const before = await readLive(name, created.namespace)
        clearSecretCalls()

        await ensureSecret(res, recipe)

        // Witness: the gate read the live Secret before deciding not to write.
        expect(readsOf(mockCoreApi.readNamespacedSecret, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedSecret, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedSecret, name)).toBe(0)
        const after = await readLive(name, created.namespace)
        expect(after.data).toEqual(before.data)
      })

      it('refuses a generated-key Secret owned by another recipe without writing it', async () => {
        const res: SecretRes = { id: 'creds', type: 'secret', generateKeys: ['password'] }
        const recipe = recipeWith(res)
        await ensureSecret(res, recipe)
        const created = onlyPost()
        const name = created.body.metadata.name
        await relabelToForeignOwner(name, created.namespace)
        clearSecretCalls()

        await expect(ensureSecret(res, recipe)).rejects.toThrow(
          /not owned by WorkflowRecipe "test-recipe".*clerum\.io\/recipe=other-recipe/
        )

        expect(readsOf(mockCoreApi.readNamespacedSecret, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedSecret, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedSecret, name)).toBe(0)
      })

      it('keeps a generated-key Secret created by a racing writer without claiming an update', async () => {
        const res: SecretRes = { id: 'creds', type: 'secret', generateKeys: ['password'] }
        const recipe = recipeWith(res)
        await ensureSecret(res, recipe)
        const created = onlyPost()
        const name = created.body.metadata.name
        const before = await readLive(name, created.namespace)
        clearSecretCalls()
        // The read misses; the POST then finds the Secret another writer created.
        mockCoreApi.readNamespacedSecret.mockRejectedValueOnce({ code: 404 })
        const infoLog = captureLogger('info')
        try {
          await ensureSecret(res, recipe)

          // Witness: the missed read, the POST and the conflict re-read all ran.
          expect(readsOf(mockCoreApi.readNamespacedSecret, name, created.namespace)).toBe(2)
          expect(postsOf(mockCoreApi.createNamespacedSecret, name)).toBe(1)
          expect(putsOf(mockCoreApi.replaceNamespacedSecret, name)).toBe(0)
          const label = `Secret "creds" in ${created.namespace}`
          expect(infoLog).toHaveBeenCalledWith(
            'Secret with generated keys exists; keeping its keys',
            { label }
          )
          expect(infoLog).not.toHaveBeenCalledWith('Updated resource', { label })
          const after = await readLive(name, created.namespace)
          expect(after.data).toEqual(before.data)
        } finally {
          infoLog.mockRestore()
        }
      })

      it('sends neither POST nor PUT for an unchanged user-data Secret', async () => {
        const res: SecretRes = { id: 'api', type: 'secret', data: { token: 'v1' } }
        const recipe = recipeWith(res)
        await ensureSecret(res, recipe)
        const created = onlyPost()
        const name = created.body.metadata.name
        clearSecretCalls()

        await ensureSecret(res, recipe)

        expect(readsOf(mockCoreApi.readNamespacedSecret, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedSecret, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedSecret, name)).toBe(0)
      })

      it('replaces a user-data Secret whose data changed, carrying the live resourceVersion', async () => {
        const first: SecretRes = { id: 'api', type: 'secret', data: { token: 'v1' } }
        await ensureSecret(first, recipeWith(first))
        const created = onlyPost()
        const name = created.body.metadata.name
        clearSecretCalls()

        const second: SecretRes = { id: 'api', type: 'secret', data: { token: 'v2' } }
        await ensureSecret(second, recipeWith(second))

        expect(postsOf(mockCoreApi.createNamespacedSecret, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedSecret, name)).toBe(1)
        const replaced = mockCoreApi.replaceNamespacedSecret.mock.calls[0][0] as {
          body: SecretManifest & { metadata: { resourceVersion?: string } }
        }
        expect(replaced.body.data).toEqual({ token: Buffer.from('v2').toString('base64') })
        expect(replaced.body.metadata.resourceVersion).toBe('1')
      })

      it('refuses a user-data Secret owned by another recipe without writing it', async () => {
        const res: SecretRes = { id: 'api', type: 'secret', data: { token: 'v1' } }
        const recipe = recipeWith(res)
        await ensureSecret(res, recipe)
        const created = onlyPost()
        const name = created.body.metadata.name
        await relabelToForeignOwner(name, created.namespace)
        clearSecretCalls()

        await expect(ensureSecret(res, recipe)).rejects.toThrow(
          /not owned by WorkflowRecipe "test-recipe".*clerum\.io\/recipe=other-recipe/
        )

        expect(readsOf(mockCoreApi.readNamespacedSecret, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedSecret, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedSecret, name)).toBe(0)
      })

      // Each case leaves data equal to the desired Secret and changes one other
      // field secretMatchesDesired compares, so only that comparison can force
      // the PUT.
      it.each([
        ['its type', (live: SecretManifest) => ({ ...live, type: 'kubernetes.io/basic-auth' })],
        [
          'a label that is not the ownership label',
          (live: SecretManifest) => {
            const labels = { ...(live.metadata.labels as Record<string, string>) }
            const key = Object.keys(labels).find(k => k !== 'clerum.io/recipe')
            if (!key) throw new Error('the built Secret carries no non-ownership label')
            delete labels[key]
            return { ...live, metadata: { ...live.metadata, labels } }
          },
        ],
        [
          'the uid of its controller owner (recipe recreated under the same name)',
          (live: SecretManifest) => {
            const refs = live.metadata.ownerReferences as Array<{
              controller?: boolean
              uid?: string
            }>
            if (!refs?.some(ref => ref.controller && ref.uid)) {
              throw new Error('the built Secret carries no controller owner uid')
            }
            return {
              ...live,
              metadata: {
                ...live.metadata,
                ownerReferences: refs.map(ref =>
                  ref.controller ? { ...ref, uid: 'uid-old' } : ref
                ),
              },
            }
          },
        ],
      ])('replaces a user-data Secret whose live copy differs in %s', async (_field, drift) => {
        const res: SecretRes = { id: 'api', type: 'secret', data: { token: 'v1' } }
        const recipe = recipeWith(res)
        await ensureSecret(res, recipe)
        const created = onlyPost()
        const name = created.body.metadata.name
        const live = await readLive(name, created.namespace)
        await mockCoreApi.replaceNamespacedSecret({
          name,
          namespace: created.namespace,
          body: drift(live),
        })
        clearSecretCalls()

        await ensureSecret(res, recipe)

        // Witness: the gate read the drifted Secret before deciding to write.
        expect(readsOf(mockCoreApi.readNamespacedSecret, name, created.namespace)).toBe(1)
        expect(postsOf(mockCoreApi.createNamespacedSecret, name)).toBe(0)
        expect(putsOf(mockCoreApi.replaceNamespacedSecret, name)).toBe(1)
        const replaced = mockCoreApi.replaceNamespacedSecret.mock.calls[0][0] as {
          body: SecretManifest
        }
        expect(replaced.body).toMatchObject({
          type: created.body.type,
          metadata: {
            labels: created.body.metadata.labels,
            ownerReferences: created.body.metadata.ownerReferences,
          },
        })
      })

      it.each([
        ['403', { code: 403 }],
        ['503', { code: 503 }],
      ])(
        'propagates a Secret read that fails with %s without writing',
        async (_status, failure) => {
          const res: SecretRes = { id: 'api', type: 'secret', data: { token: 'v1' } }
          const recipe = recipeWith(res)
          await ensureSecret(res, recipe)
          const created = onlyPost()
          const name = created.body.metadata.name
          clearSecretCalls()
          mockCoreApi.readNamespacedSecret.mockRejectedValueOnce(failure)

          await expect(ensureSecret(res, recipe)).rejects.toBe(failure)

          // Witness: the failing read is the only call; nothing was written blind.
          expect(readsOf(mockCoreApi.readNamespacedSecret, name, created.namespace)).toBe(1)
          expect(mockCoreApi.createNamespacedSecret).toHaveBeenCalledTimes(0)
          expect(mockCoreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(0)
        }
      )
    })

    // #760: the StatefulSet writer reads before it creates, so a pass over an
    // object that already exists writes nothing. Every read and create count
    // below is filtered by name, because the same read serves the readiness
    // probe and the legacy checks. Patch counts stay unfiltered: nothing else
    // patches a StatefulSet, so the unfiltered zero is the stricter assertion.
    describe('read-first StatefulSet apply (#760)', () => {
      type StsBody = {
        metadata: { name: string; annotations: Record<string, string> }
        spec: Record<string, unknown>
      }
      const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })
      const namespace = 'sandbox-recipes'
      const ensure = () =>
        (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(workload, recipe, 'minimal', {})
      const create = mockAppsApi.createNamespacedStatefulSet
      const read = mockAppsApi.readNamespacedStatefulSet
      const patch = mockAppsApi.patchNamespacedStatefulSet
      const createdBody = (call = 0) => create.mock.calls[call][0].body as StsBody
      const loggedFor = (level: ReturnType<typeof vi.fn>, message: string, name: string) =>
        level.mock.calls.filter(
          ([msg, ctx]) => msg === message && (ctx as { name?: string })?.name === name
        ).length

      it('S1: an existing StatefulSet with the same hash is read and nothing is written', async () => {
        await ensure()
        const name = createdBody().metadata.name
        create.mockClear()
        read.mockClear()
        patch.mockClear()

        const logs = captureLoggerLevels(['info', 'debug'] as const)
        try {
          await ensure()
          expect(
            loggedFor(logs.calls.info, 'StatefulSet spec hash unchanged; skipping update', name)
          ).toBe(1)
        } finally {
          logs.restore()
        }
        expect(readsOf(read, name, namespace)).toBe(1)
        expect(postsOf(create, name)).toBe(0)
        expect(patch).toHaveBeenCalledTimes(0)
      })

      it('S2: an absent StatefulSet is read, then created', async () => {
        const logs = captureLoggerLevels(['info', 'debug'] as const)
        try {
          await ensure()
          const name = createdBody().metadata.name
          expect(loggedFor(logs.calls.info, 'Created StatefulSet', name)).toBe(1)
          expect(postsOf(create, name)).toBe(1)
          expect(readsOf(read, name, namespace)).toBe(1)
          const readOrder =
            read.mock.invocationCallOrder[
              read.mock.calls.findIndex(([a]) => (a as { name: string }).name === name)
            ]
          expect(readOrder).toBeLessThan(create.mock.invocationCallOrder[0])
        } finally {
          logs.restore()
        }
      })

      it('S3: a create conflict with an identical object re-reads it and skips the update', async () => {
        const storeCreate = create.getMockImplementation()!
        create.mockImplementationOnce(async (args: { namespace: string; body: StsBody }) => {
          await storeCreate(args)
          throw { code: 409 }
        })

        const logs = captureLoggerLevels(['info', 'debug'] as const)
        try {
          await ensure()
          const name = createdBody().metadata.name
          expect(
            loggedFor(logs.calls.info, 'StatefulSet spec hash unchanged; skipping update', name)
          ).toBe(1)
          expect(readsOf(read, name, namespace)).toBe(2)
        } finally {
          logs.restore()
        }
        expect(patch).toHaveBeenCalledTimes(0)
      })

      it('S3b: a create conflict with a drifted object re-reads it and patches it', async () => {
        const storeCreate = create.getMockImplementation()!
        create.mockImplementationOnce(async (args: { namespace: string; body: StsBody }) => {
          const other = structuredClone(args.body)
          other.metadata.annotations = {
            ...other.metadata.annotations,
            [SPEC_HASH]: 'other-writer',
          }
          other.spec = { ...other.spec, replicas: 3 }
          await storeCreate({ namespace: args.namespace, body: other })
          throw { code: 409 }
        })

        await ensure()

        const desired = createdBody()
        expect(readsOf(read, desired.metadata.name, namespace)).toBe(2)
        expect(patch).toHaveBeenCalledTimes(1)
        const sent = patch.mock.calls[0][0] as { name: string; body: JsonPatchOperation[] }
        expect(sent.name).toBe(desired.metadata.name)
        // Issue #1349 (P-1) — the body is a JSON Patch: the other writer's object
        // has annotations, so the hash is added as one member of them.
        expect(jsonPatchOpAt(sent.body, '/metadata/annotations/clerum.io~1spec-hash')).toEqual({
          op: 'add',
          path: '/metadata/annotations/clerum.io~1spec-hash',
          value: desired.metadata.annotations[SPEC_HASH],
        })
        expect(jsonPatchOpAt(sent.body, '/spec/replicas')).toEqual({
          op: 'add',
          path: '/spec/replicas',
          value: desired.spec.replicas,
        })
      })

      it('S4: a read error other than 404 is rethrown and nothing is created', async () => {
        const failure = { code: 500 }
        read.mockImplementation(async () => {
          throw failure
        })

        await expect(ensure()).rejects.toBe(failure)

        // Witness: the failing read happened; the create (which would succeed) did not.
        const writerReads = read.mock.calls.filter(
          ([args]) => args.namespace === namespace && String(args.name).includes(workload.id)
        )
        expect(writerReads).toHaveLength(1)
        expect(create).toHaveBeenCalledTimes(0)
        expect(patch).toHaveBeenCalledTimes(0)
      })

      it('S5: an object that vanishes after the create conflict asks for a fresh reconcile', async () => {
        create.mockRejectedValueOnce({ code: 409 })

        const outcome = ensure()

        await expect(outcome).rejects.toBeInstanceOf(ResourceVanishedAfterConflictError)
        // The cause is the 404 of the re-read, as in ensureTransportService.
        await expect(outcome).rejects.toMatchObject({ cause: { code: 404 } })
        const name = createdBody().metadata.name
        expect(readsOf(read, name, namespace)).toBe(2)
        expect(patch).toHaveBeenCalledTimes(0)
      })

      it('S6: the second reconcile of a recipe whose StatefulSet exists writes no StatefulSet', async () => {
        await reconciler.reconcile(recipe)
        const name = createdBody().metadata.name
        // Witness for the first pass: it did create the object.
        expect(postsOf(create, name)).toBe(1)
        create.mockClear()

        const logs = captureLoggerLevels(['info', 'debug'] as const)
        try {
          await reconciler.reconcile(recipe)
          expect(
            loggedFor(logs.calls.info, 'StatefulSet spec hash unchanged; skipping update', name)
          ).toBe(1)
        } finally {
          logs.restore()
        }
        expect(postsOf(create, name)).toBe(0)
      })
    })

    it('does NOT replace a StatefulSet whose spec-hash is unchanged', async () => {
      const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      // Not reached on the read-first path (#760). If the writer went back to
      // POST-first, this 409 would keep the old path working and only the
      // zero-create assertion below would catch it.
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: createdBody!.metadata.annotations },
        spec: createdBody!.spec,
      })
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockClear()
      const name = (createdBody! as unknown as { metadata: { name: string } }).metadata.name

      // Liveness witnesses for the negative assertions below: the writer read
      // this object and took the unchanged-hash branch.
      const logs = captureLoggerLevels(['info', 'debug'] as const)
      try {
        await (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(workload, recipe, 'minimal', {})
        expect(
          logs.calls.info.mock.calls.filter(
            ([msg, ctx]) =>
              msg === 'StatefulSet spec hash unchanged; skipping update' &&
              (ctx as { name?: string })?.name === name
          )
        ).toHaveLength(1)
      } finally {
        logs.restore()
      }
      expect(readsOf(mockAppsApi.readNamespacedStatefulSet, name, 'sandbox-recipes')).toBe(1)

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
    })

    // Issue #1349 (P-1) — a StatefulSet update replaces the pod template with a
    // JSON Patch. A strategic merge kept the env entries, pull Secrets and volumes
    // the new template omits; these tests read the object the store holds after
    // the patch, through the store's strategic and JSON Patch branches.
    describe('StatefulSet template replace (issue #1349)', () => {
      const namespace = 'sandbox-recipes'
      const recipe = makeRecipe({ spec: { workloads: [] } })
      type StsWorkload = Parameters<typeof buildStatefulSet>[0]
      const ensure = (workload: StsWorkload) =>
        (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(workload, recipe, 'minimal', {})
      const stsNameOf = (workload: StsWorkload) =>
        buildStatefulSet(workload, recipe, 'minimal', undefined).statefulSet.metadata!.name!
      const stored = async (name: string) =>
        (await mockAppsApi.readNamespacedStatefulSet({ name, namespace })) as k8s.V1StatefulSet

      it('T-P1-0: the store merges a strategic pod-template patch as the API server does', async () => {
        // The server-confirmed case (kube-apiserver v1.35.1): a strategic merge
        // whose template names env [PLAIN] and no imagePullSecrets keeps API_KEY
        // and the pull Secret; only the annotation changes.
        await mockAppsApi.createNamespacedStatefulSet({
          namespace: 'p1-probe',
          body: {
            apiVersion: 'apps/v1',
            kind: 'StatefulSet',
            metadata: {
              name: 'p1-probe',
              namespace: 'p1-probe',
              annotations: { 'clerum.io/spec-hash': 'old' },
            },
            spec: {
              serviceName: 'p1-probe',
              replicas: 0,
              selector: { matchLabels: { app: 'p1-probe' } },
              template: {
                metadata: { labels: { app: 'p1-probe' } },
                spec: {
                  imagePullSecrets: [{ name: 'foreign-pull' }],
                  containers: [
                    {
                      name: 'app',
                      image: 'busybox:1.36',
                      env: [
                        { name: 'PLAIN', value: '1' },
                        {
                          name: 'API_KEY',
                          valueFrom: { secretKeyRef: { name: 'foreign-creds', key: 'api-key' } },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        })

        await mockAppsApi.patchNamespacedStatefulSet({
          name: 'p1-probe',
          namespace: 'p1-probe',
          body: {
            metadata: { annotations: { 'clerum.io/spec-hash': 'new' } },
            spec: {
              template: {
                metadata: { labels: { app: 'p1-probe' } },
                spec: {
                  containers: [
                    { name: 'app', image: 'busybox:1.36', env: [{ name: 'PLAIN', value: '1' }] },
                  ],
                },
              },
            },
          },
        })

        const after = (await mockAppsApi.readNamespacedStatefulSet({
          name: 'p1-probe',
          namespace: 'p1-probe',
        })) as k8s.V1StatefulSet
        expect(after.metadata?.annotations?.['clerum.io/spec-hash']).toBe('new')
        expect(after.spec?.template.spec?.containers[0].env).toEqual([
          { name: 'PLAIN', value: '1' },
          {
            name: 'API_KEY',
            valueFrom: { secretKeyRef: { key: 'api-key', name: 'foreign-creds' } },
          },
        ])
        expect(after.spec?.template.spec?.imagePullSecrets).toEqual([{ name: 'foreign-pull' }])
      })

      it('T-P1-2: an update that drops an env entry and a volume mount removes them from the stored template', async () => {
        const oldWorkload: StsWorkload = {
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          env: [
            { name: 'A', value: '1' },
            { name: 'B', value: '2' },
          ],
          volumeMounts: [{ name: 'scratch', mountPath: '/scratch' }],
        }
        const newWorkload: StsWorkload = {
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          env: [{ name: 'A', value: '1' }],
        }
        const name = stsNameOf(oldWorkload)
        await ensure(oldWorkload)
        const before = await stored(name)
        expect(before.spec!.template.spec!.containers[0].env?.map(e => e.name)).toContain('B')
        expect(before.spec!.template.spec!.volumes?.map(v => v.name)).toContain('scratch')
        mockAppsApi.patchNamespacedStatefulSet.mockClear()

        await ensure(newWorkload)

        // Witness: the update was sent.
        expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
        const after = await stored(name)
        const container = after.spec!.template.spec!.containers[0]
        expect(container.env?.map(e => e.name)).toContain('A')
        expect(container.env?.map(e => e.name)).not.toContain('B')
        expect((container.volumeMounts ?? []).filter(m => m.mountPath === '/scratch')).toEqual([])
        expect(
          (after.spec!.template.spec!.volumes ?? []).filter(v => v.name === 'scratch')
        ).toEqual([])
      })

      it('T-P1-3: the update is a JSON Patch that replaces the template, sent as application/json-patch+json', async () => {
        const actual =
          await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node')
        const setHeader = vi.mocked(k8s.setHeaderMiddleware)
        const oldWorkload: StsWorkload = { id: 'db', type: 'statefulset', image: 'postgres:15' }
        const newWorkload: StsWorkload = { id: 'db', type: 'statefulset', image: 'postgres:16' }
        await ensure(oldWorkload)
        mockAppsApi.patchNamespacedStatefulSet.mockClear()
        setHeader.mockImplementation(actual.setHeaderMiddleware)
        try {
          await ensure(newWorkload)
        } finally {
          setHeader.mockImplementation(() => ({}) as ReturnType<typeof actual.setHeaderMiddleware>)
        }

        expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
        const [args, options] = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0] as [
          { body: unknown },
          { middleware: Array<{ pre: (context: unknown) => unknown }> },
        ]
        const desiredTemplate = buildStatefulSet(newWorkload, recipe, 'minimal', {} as never)
          .statefulSet.spec!.template
        expect(jsonPatchOpAt(args.body, '/spec/template')).toEqual({
          op: 'replace',
          path: '/spec/template',
          value: desiredTemplate,
        })
        expect(
          jsonPatchOpAt(args.body, '/metadata/annotations/clerum.io~1spec-hash')?.value
        ).toEqual(expect.any(String))
        const paths = (args.body as JsonPatchOperation[]).map(operation => operation.path)
        for (const field of ['volumeClaimTemplates', 'selector', 'serviceName']) {
          expect(paths.filter(path => path.startsWith(`/spec/${field}`))).toEqual([])
        }
        // The header the middleware sets on the request.
        const setHeaderParam = vi.fn()
        expect(options.middleware).toHaveLength(1)
        options.middleware[0].pre({ setHeaderParam })
        expect(setHeaderParam).toHaveBeenCalledWith('Content-Type', 'application/json-patch+json')
      })

      // R1-M2 — `kubectl rollout restart` writes restartedAt on the stored pod
      // template. The update carries it over, so replacing the template does not
      // remove it and start one more rollout.
      for (const shape of ['as WRC sent it', 'as the API server stores it'] as const) {
        it(`T-R3-M2-1: a replicas-only update keeps restartedAt on a template stored ${shape} (issue #1349)`, async () => {
          const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'
          const one: StsWorkload = {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            replicas: 1,
          }
          const name = stsNameOf(one)
          await ensure(one)
          const created = await stored(name)
          const live = shape === 'as WRC sent it' ? created : withApiServerDefaults(created)
          live.spec!.template.metadata = {
            ...live.spec!.template.metadata,
            annotations: {
              ...live.spec!.template.metadata?.annotations,
              [RESTARTED_AT]: '2026-11-16T10:00:00Z',
            },
          }
          await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: live })
          mockAppsApi.patchNamespacedStatefulSet.mockClear()

          await ensure({ ...one, replicas: 2 })

          // Witness: the update was sent and stored.
          expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
          const after = await stored(name)
          expect(after.spec!.replicas).toBe(2)
          expect(after.spec!.template.metadata?.annotations?.[RESTARTED_AT]).toBe(
            '2026-11-16T10:00:00Z'
          )
          const body = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
          const templateOp = jsonPatchOpAt(body, '/spec/template')
          if (shape === 'as the API server stores it') {
            // The defaults keep the template in the patch: the replace value
            // itself carries the annotation.
            expect(templateOp?.op).toBe('replace')
            expect(
              (templateOp!.value as k8s.V1PodTemplateSpec).metadata?.annotations?.[RESTARTED_AT]
            ).toBe('2026-11-16T10:00:00Z')
          } else {
            expect(templateOp).toBeUndefined()
          }
          // The annotation is not part of the hashed manifest: the same spec
          // again is a no-op.
          await ensure({ ...one, replicas: 2 })
          expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
        })
      }

      it('T-R3-M2-2: the template replace still drops every other annotation only the stored template has (issue #1349)', async () => {
        const one: StsWorkload = {
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          replicas: 1,
        }
        const name = stsNameOf(one)
        await ensure(one)
        const live = withApiServerDefaults(await stored(name))
        live.spec!.template.metadata = {
          ...live.spec!.template.metadata,
          annotations: {
            ...live.spec!.template.metadata?.annotations,
            'kubectl.kubernetes.io/restartedAt': '2026-11-16T10:00:00Z',
            'example.com/injected': 'by-another-writer',
          },
        }
        await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: live })
        mockAppsApi.patchNamespacedStatefulSet.mockClear()

        await ensure({ ...one, replicas: 2 })

        // Witness: the template was replaced, and restartedAt came through it.
        const body = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
        expect(jsonPatchOpAt(body, '/spec/template')?.op).toBe('replace')
        const annotations = (await stored(name)).spec!.template.metadata?.annotations ?? {}
        expect(annotations['kubectl.kubernetes.io/restartedAt']).toBe('2026-11-16T10:00:00Z')
        expect(annotations).not.toHaveProperty('example.com/injected')
      })

      // Issue #1530 — the API server stores a quantity in its canonical spelling, so a
      // claim template size is compared by amount.
      const withClaim = (size: string, replicas = 1): StsWorkload =>
        ({
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          replicas,
          volumeClaimTemplates: [{ name: 'data', size, accessMode: 'ReadWriteOnce' }],
        }) as StsWorkload
      const storeClaimSize = async (name: string, size: string) => {
        const live = await stored(name)
        live.spec!.volumeClaimTemplates![0].spec!.resources!.requests!.storage = size
        await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: live })
      }

      it.each([
        ['1024Mi', '1Gi'],
        ['1.5Gi', '1536Mi'],
        ['0.5Gi', '512Mi'],
        ['2048Mi', '2Gi'],
      ])(
        'T-1530-2: a claim template size %s stored as %s is not immutable drift (issue #1530)',
        async (specSize, storedSize) => {
          const name = stsNameOf(withClaim(specSize))
          await ensure(withClaim(specSize))
          await storeClaimSize(name, storedSize)
          mockAppsApi.patchNamespacedStatefulSet.mockClear()

          await ensure(withClaim(specSize, 2))

          expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
          expect((await stored(name)).spec!.replicas).toBe(2)
        }
      )

      it.each([
        ['2Gi', '1Gi'],
        ['1G', '1Gi'],
        ['plenty', '1Gi'],
        ['1e3', '1k'],
        // 65 characters, over MAX_QUANTITY_LENGTH: the same amount as 1Gi, still compared as text.
        [`1.${'0'.repeat(61)}Gi`, '1Gi'],
      ])(
        'T-1530-3: a claim template size %s against a stored %s is still immutable drift (issue #1530)',
        async (specSize, storedSize) => {
          const name = stsNameOf(withClaim(specSize))
          await ensure(withClaim(specSize))
          await storeClaimSize(name, storedSize)
          mockAppsApi.patchNamespacedStatefulSet.mockClear()

          await expect(ensure(withClaim(specSize, 2))).rejects.toMatchObject({
            name: 'ImmutableStatefulSetDriftError',
            condition: {
              message: expect.stringContaining('spec.volumeClaimTemplates'),
            },
          })
          expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
          expect((await stored(name)).spec!.replicas).toBe(1)
        }
      )

      // Issue #1518 — the drift error says whether the stored spec hash is the
      // desired one, and only its condition names the last writer.
      const driftOnStaleHash = async (managedFields: k8s.V1ManagedFieldsEntry[] | undefined) => {
        const oldWorkload: StsWorkload = { id: 'db', type: 'statefulset', image: 'postgres:15' }
        const newWorkload: StsWorkload = { id: 'db', type: 'statefulset', image: 'postgres:16' }
        const name = stsNameOf(oldWorkload)
        await ensure(oldWorkload)
        const live = await stored(name)
        live.spec!.serviceName = 'renamed-by-hand'
        live.metadata!.managedFields = managedFields
        await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: live })
        const error = await ensure(newWorkload).then(
          () => undefined,
          (rejection: unknown) => rejection as Error & { condition: { message: string } }
        )
        expect(error?.name).toBe('ImmutableStatefulSetDriftError')
        const head =
          `ImmutableStatefulSetDrift: StatefulSet "${name}" in ${namespace} has immutable drift ` +
          'in spec.serviceName; WRC will not full-replace StatefulSets. '
        const tail = 'Recreate through an explicit data-safe migration.'
        for (const text of [error!.message, error!.condition.message]) {
          expect(text.startsWith(head)).toBe(true)
          expect(text.endsWith(tail)).toBe(true)
          expect(text).toContain('The stored spec hash is not the desired one')
        }
        return error!
      }

      it('T-1518-4 (i): a drift on a stale hash says so, and a live object without managedFields names no writer (issue #1518)', async () => {
        const error = await driftOnStaleHash(undefined)

        expect(error.condition.message).toContain('The live object records no field manager.')
        expect(error.message).not.toContain('field manager')
      })

      it('T-1518-4 (ii): the last writer is named in the condition message only, so a manager name is never classified as retryable (issue #1518)', async () => {
        const error = await driftOnStaleHash([
          {
            manager: 'connect ETIMEDOUT',
            operation: 'Update',
            time: new Date('2026-11-17T10:00:00Z'),
          },
        ])

        // Witness: the same error names the manager in its condition message.
        expect(error.condition.message).toContain(
          'Last writer of the live object (metadata.managedFields): "connect ETIMEDOUT". '
        )
        expect(error.message).not.toContain('connect ETIMEDOUT')
        expect(isRetryableInfraError(error.message)).toBe(false)
        expect(isRetryableInfraError('connect ETIMEDOUT')).toBe(true)
      })

      it('T-P1-4: an existing StatefulSet without annotations gets the hash annotation', async () => {
        const oldWorkload: StsWorkload = { id: 'db', type: 'statefulset', image: 'postgres:15' }
        const newWorkload: StsWorkload = { id: 'db', type: 'statefulset', image: 'postgres:16' }
        const name = stsNameOf(oldWorkload)
        await ensure(oldWorkload)
        const legacy = await stored(name)
        delete legacy.metadata!.annotations
        await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: legacy })
        expect((await stored(name)).metadata?.annotations).toBeUndefined()
        mockAppsApi.patchNamespacedStatefulSet.mockClear()

        await ensure(newWorkload)

        expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
        const after = await stored(name)
        expect(after.metadata?.annotations?.['clerum.io/spec-hash']).toEqual(expect.any(String))
        expect(after.spec!.template.spec!.containers[0].image).toBe('postgres:16')
      })
    })

    it('patches only StatefulSet metadata when the desired spec already matches', async () => {
      const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: {
        metadata: { annotations: Record<string, string> }
        spec: Record<string, unknown>
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})

      const existing = clone(createdBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-or-missing' }
      // Not reached on the read-first path (#760). If the writer went back to
      // POST-first, this 409 would keep the old path working and only the
      // zero-create assertion below would catch it.
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()
      // The existing object lives in the read mock above, not in the live store,
      // so the patch answers here instead of the store's 404 for an absent object.
      mockAppsApi.patchNamespacedStatefulSet.mockResolvedValue({})

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      // Issue #1349 (P-1) — a JSON Patch with the hash operation only.
      expect(mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body).toEqual([
        {
          op: 'add',
          path: '/metadata/annotations/clerum.io~1spec-hash',
          value: createdBody!.metadata.annotations[SPEC_HASH],
        },
      ])
    })

    it('patches mutable StatefulSet spec fields without full replace', async () => {
      const oldWorkload = { id: 'db', type: 'statefulset' as const, image: 'postgres:15' }
      const newWorkload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const oldRecipe = makeRecipe({ spec: { workloads: [oldWorkload] } })
      const newRecipe = makeRecipe({ spec: { workloads: [newWorkload] } })

      let existingBody: {
        metadata: { annotations: Record<string, string> }
        spec: Record<string, unknown>
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-old-template' }
      // Not reached on the read-first path (#760). If the writer went back to
      // POST-first, this 409 would keep the old path working and only the
      // zero-create assertion below would catch it.
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()
      // The existing object lives in the read mock above, not in the live store,
      // so the patch answers here instead of the store's 404 for an absent object.
      mockAppsApi.patchNamespacedStatefulSet.mockResolvedValue({})

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      // Issue #1349 (P-1) — the template is replaced through a JSON Patch.
      const patchBody = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
      const templateOp = jsonPatchOpAt(patchBody, '/spec/template')
      expect(templateOp?.op).toBe('replace')
      expect(
        (templateOp?.value as { spec: { containers: Array<{ image: string }> } }).spec.containers[0]
          .image
      ).toBe('postgres:16')
      expect(
        (patchBody as JsonPatchOperation[]).filter(operation =>
          operation.path.startsWith('/spec/volumeClaimTemplates')
        )
      ).toEqual([])
    })

    it('treats API-server defaulted StatefulSet volumeClaimTemplates as equivalent', async () => {
      const oldWorkload = {
        id: 'db',
        type: 'statefulset' as const,
        image: 'postgres:15',
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '256Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
        volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
      }
      const newWorkload = { ...oldWorkload, image: 'postgres:16' }
      const oldRecipe = makeRecipe({ spec: { workloads: [oldWorkload] } })
      const newRecipe = makeRecipe({ spec: { workloads: [newWorkload] } })

      let existingBody: {
        metadata: { annotations: Record<string, string> }
        spec: {
          template: Record<string, unknown>
          volumeClaimTemplates?: Array<Record<string, unknown>>
        }
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-old-template' }
      existing.spec.volumeClaimTemplates = existing.spec.volumeClaimTemplates?.map(template => ({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        ...template,
        spec: {
          ...(template.spec as Record<string, unknown>),
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Pending' },
      }))
      // Not reached on the read-first path (#760). If the writer went back to
      // POST-first, this 409 would keep the old path working and only the
      // zero-create assertion below would catch it.
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()
      // The existing object lives in the read mock above, not in the live store,
      // so the patch answers here instead of the store's 404 for an absent object.
      mockAppsApi.patchNamespacedStatefulSet.mockResolvedValue({})

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      // Issue #1349 (P-1) — the template is replaced through a JSON Patch.
      const patchBody = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
      const templateOp = jsonPatchOpAt(patchBody, '/spec/template')
      expect(templateOp?.op).toBe('replace')
      expect(
        (templateOp?.value as { spec: { containers: Array<{ image: string }> } }).spec.containers[0]
          .image
      ).toBe('postgres:16')
      expect(
        (patchBody as JsonPatchOperation[]).filter(operation =>
          operation.path.startsWith('/spec/volumeClaimTemplates')
        )
      ).toEqual([])
    })

    it('patches a legacy scoped StatefulSet with volumeClaimTemplates instead of reporting false drift', async () => {
      const runtimeName = 'issue-690-preexisting-nohash-sim-db-6fd5da9b'
      const oldWorkload = {
        id: 'db',
        type: 'statefulset' as const,
        image: 'postgres:16-alpine',
        port: 5432,
        env: [
          { name: 'POSTGRES_HOST_AUTH_METHOD', value: 'trust' },
          { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
        ],
        security: {
          addCapabilities: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
          fsGroup: 70,
          runAsGroup: 70,
          runAsUser: 70,
        },
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '256Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
        volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
      }
      const newWorkload = {
        ...oldWorkload,
        env: [...oldWorkload.env, { name: 'ISSUE_690_GENERATION_BUMP', value: '1' }],
      }
      const oldRecipe = makeRecipe({
        metadata: {
          name: 'issue-690-preexisting-nohash-sim',
          namespace: 'sandbox-recipes',
          uid: '959605ce-077f-4638-b5d0-403fbcd431cf',
        },
        spec: { workloads: [oldWorkload] },
        status: { phase: 'active', workloadInstances: { db: runtimeName } },
      })
      const newRecipe = makeRecipe({
        metadata: oldRecipe.metadata,
        spec: { workloads: [newWorkload] },
        status: oldRecipe.status,
      })

      let existingBody: {
        metadata: { annotations?: Record<string, string> }
        spec: {
          template: Record<string, unknown>
          volumeClaimTemplates?: Array<Record<string, unknown>>
        }
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = {
        'kubectl.kubernetes.io/last-applied-configuration': '{}',
      }
      existing.spec.volumeClaimTemplates = existing.spec.volumeClaimTemplates?.map(template => ({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        ...template,
        spec: {
          ...(template.spec as Record<string, unknown>),
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Pending' },
      }))
      // Not reached on the read-first path (#760). If the writer went back to
      // POST-first, this 409 would keep the old path working and only the
      // zero-create assertion below would catch it.
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()
      // The existing object lives in the read mock above, not in the live store,
      // so the patch answers here instead of the store's 404 for an absent object.
      mockAppsApi.patchNamespacedStatefulSet.mockResolvedValue({})

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      // Issue #1349 (P-1) — the template is replaced through a JSON Patch.
      const patchBody = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
      const templateOp = jsonPatchOpAt(patchBody, '/spec/template')
      expect(templateOp?.op).toBe('replace')
      expect(
        (templateOp?.value as { spec: { containers: Array<{ env: unknown[] }> } }).spec
          .containers[0].env
      ).toContainEqual({
        name: 'ISSUE_690_GENERATION_BUMP',
        value: '1',
      })
      expect(
        (patchBody as JsonPatchOperation[]).filter(operation =>
          operation.path.startsWith('/spec/volumeClaimTemplates')
        )
      ).toEqual([])
    })

    it('fails StatefulSet reconciliation when volumeClaimTemplate storage drifts', async () => {
      const oldWorkload = {
        id: 'db',
        type: 'statefulset' as const,
        image: 'postgres:16',
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '256Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
        volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
      }
      const newWorkload = {
        ...oldWorkload,
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '512Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
      }
      const oldRecipe = makeRecipe({ spec: { workloads: [oldWorkload] } })
      const newRecipe = makeRecipe({ spec: { workloads: [newWorkload] } })

      let existingBody: {
        metadata: { annotations: Record<string, string> }
        spec: {
          volumeClaimTemplates?: Array<Record<string, unknown>>
        }
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-storage' }
      // Not reached on the read-first path (#760). If the writer went back to
      // POST-first, this 409 would keep the old path working and only the
      // zero-create assertion below would catch it.
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await expect(
        (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})
      ).rejects.toMatchObject({
        name: 'ImmutableStatefulSetDriftError',
        condition: {
          type: 'StatefulSetImmutableDrift',
          reason: 'ImmutableStatefulSetDrift',
        },
      })

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
    })

    it('fails StatefulSet reconciliation with a stable immutable-drift reason', async () => {
      const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: {
        metadata: { annotations: Record<string, string> }
        spec: Record<string, unknown>
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})

      const existing = clone(createdBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-immutable-drift' }
      existing.spec.serviceName = 'manually-mutated-headless-service'
      // Not reached on the read-first path (#760). If the writer went back to
      // POST-first, this 409 would keep the old path working and only the
      // zero-create assertion below would catch it.
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await expect(
        (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(workload, recipe, 'minimal', {})
      ).rejects.toMatchObject({
        name: 'ImmutableStatefulSetDriftError',
        condition: {
          type: 'StatefulSetImmutableDrift',
          reason: 'ImmutableStatefulSetDrift',
        },
      })

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
    })

    it('does NOT replace a CronJob whose spec-hash is unchanged', async () => {
      const workload = {
        id: 'cron',
        type: 'cronjob' as const,
        image: 'busybox:1.36',
        schedule: '*/5 * * * *',
      }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockBatchApi.createNamespacedCronJob.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureCronJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureCronJob(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      // Second apply: the read-first gate finds the object with the SAME hash.
      // The apiserver returns the metadata WRC wrote, controller ownerReference included.
      mockBatchApi.readNamespacedCronJob.mockClear().mockResolvedValue({
        metadata: { ...createdBody!.metadata, resourceVersion: '9' },
        spec: createdBody!.spec,
      })
      mockBatchApi.createNamespacedCronJob.mockClear()
      mockBatchApi.replaceNamespacedCronJob.mockClear()

      await (
        reconciler as unknown as {
          ensureCronJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureCronJob(workload, recipe, 'minimal', {})

      // Witness: the gate read the live object before deciding not to write.
      expect(mockBatchApi.readNamespacedCronJob).toHaveBeenCalledTimes(1)
      expect(mockBatchApi.createNamespacedCronJob).toHaveBeenCalledTimes(0)
      expect(mockBatchApi.replaceNamespacedCronJob).toHaveBeenCalledTimes(0)
    })

    it('does NOT replace a Job whose spec-hash is unchanged', async () => {
      const workload = { id: 'job', type: 'job' as const, image: 'busybox:1.36' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockBatchApi.createNamespacedJob.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureJob(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      // Second apply: the read-first gate finds the object with the SAME hash.
      // The apiserver returns the metadata WRC wrote, controller ownerReference included.
      mockBatchApi.readNamespacedJob.mockClear().mockResolvedValue({
        metadata: { ...createdBody!.metadata, resourceVersion: '9' },
        spec: createdBody!.spec,
      })
      mockBatchApi.createNamespacedJob.mockClear()
      mockBatchApi.replaceNamespacedJob.mockClear()

      await (
        reconciler as unknown as {
          ensureJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureJob(workload, recipe, 'minimal', {})

      // Witness: the gate read the live object before deciding not to write.
      expect(mockBatchApi.readNamespacedJob).toHaveBeenCalledTimes(1)
      expect(mockBatchApi.createNamespacedJob).toHaveBeenCalledTimes(0)
      expect(mockBatchApi.replaceNamespacedJob).toHaveBeenCalledTimes(0)
    })

    it('does NOT replace a DaemonSet whose spec-hash is unchanged', async () => {
      const workload = { id: 'ds', type: 'daemonset' as const, image: 'agent:test' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockAppsApi.createNamespacedDaemonSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureDaemonSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDaemonSet(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      // Second apply: the read-first gate finds the object with the SAME hash.
      // The apiserver returns the metadata WRC wrote, controller ownerReference included.
      mockAppsApi.readNamespacedDaemonSet.mockClear().mockResolvedValue({
        metadata: { ...createdBody!.metadata, resourceVersion: '9' },
        spec: createdBody!.spec,
      })
      mockAppsApi.createNamespacedDaemonSet.mockClear()
      mockAppsApi.replaceNamespacedDaemonSet.mockClear()

      await (
        reconciler as unknown as {
          ensureDaemonSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDaemonSet(workload, recipe, 'minimal', {})

      // Witness: the gate read the live object before deciding not to write.
      expect(mockAppsApi.readNamespacedDaemonSet).toHaveBeenCalledTimes(1)
      expect(mockAppsApi.createNamespacedDaemonSet).toHaveBeenCalledTimes(0)
      expect(mockAppsApi.replaceNamespacedDaemonSet).toHaveBeenCalledTimes(0)
    })

    it('propagates a transport failure on the gate read instead of writing blind', async () => {
      const recipe = makeRecipe()
      const workload = recipe.spec.workloads![0]
      const timeout = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), {
        code: 'ETIMEDOUT',
      })

      // The gate read times out at the socket; a later read would succeed, so
      // only the gate's decision can keep the replace path from running.
      mockAppsApi.readNamespacedDeployment
        .mockReset()
        .mockRejectedValueOnce(timeout)
        .mockResolvedValue({ metadata: { resourceVersion: '9' } })
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockAppsApi.replaceNamespacedDeployment.mockClear().mockResolvedValue({})

      await expect(
        (
          reconciler as unknown as {
            ensureDeployment: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureDeployment(workload, recipe, 'minimal', {})
      ).rejects.toBe(timeout)

      // Witness: the gate read ran once; neither write followed it.
      expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(0)
      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(0)
    })
  })

  describe('RBAC for StatefulSet patch reconciliation', () => {
    type RoleManifest = {
      kind?: string
      metadata?: { namespace?: string; name?: string }
      rules?: Array<{ apiGroups?: string[]; resources?: string[]; verbs?: string[] }>
    }

    function repoRoot(): string {
      return process.cwd().endsWith('/workflow-recipes')
        ? resolve(process.cwd(), '..')
        : process.cwd()
    }

    function loadRoles(pathFromRoot: string): RoleManifest[] {
      const docs = loadAll(readFileSync(resolve(repoRoot(), pathFromRoot), 'utf8'))
      return docs.filter((doc): doc is RoleManifest => {
        return Boolean(doc && typeof doc === 'object' && (doc as RoleManifest).kind === 'Role')
      })
    }

    function workflowRecipesRole(
      pathFromRoot: string,
      namespace: string,
      name = 'workflow-recipes'
    ): RoleManifest {
      const role = loadRoles(pathFromRoot).find(
        doc => doc.metadata?.name === name && doc.metadata.namespace === namespace
      )
      expect(role).toBeDefined()
      return role!
    }

    it('grants patch only on apps/statefulsets in sandbox-recipes', () => {
      const role = workflowRecipesRole(
        'deploy/base/sandbox-recipes/rbac.yaml',
        'sandbox-recipes',
        'workflow-recipes-sandbox'
      )
      const statefulSetRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('statefulsets')
      )
      expect(statefulSetRule?.verbs).toEqual(['get', 'list', 'create', 'update', 'patch', 'delete'])

      const deploymentRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('deployments')
      )
      expect(deploymentRule?.verbs).not.toContain('patch')
    })

    it('allows only read access to Service endpoints for SDK teardown absence checks', () => {
      const role = workflowRecipesRole(
        'deploy/base/sandbox-recipes/rbac.yaml',
        'sandbox-recipes',
        'workflow-recipes-sandbox'
      )
      const endpointsRule = role.rules?.find(
        rule => rule.apiGroups?.includes('') && rule.resources?.includes('endpoints')
      )
      expect(endpointsRule?.verbs).toEqual(['get'])
    })

    it('grants patch only on apps/statefulsets in mcp-server', () => {
      const role = workflowRecipesRole('deploy/base/mcp-server/rbac.yaml', 'mcp-server')
      const statefulSetRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('statefulsets')
      )
      expect(statefulSetRule?.verbs).toEqual(['get', 'list', 'create', 'update', 'patch', 'delete'])

      const deploymentRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('deployments')
      )
      expect(deploymentRule?.verbs).not.toContain('patch')
    })
  })

  it('materializes WRC internal-dependency NetworkPolicies and status condition', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_URL', value: 'postgres://{{db:host}}:{{db:port}}/app' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      type: 'InternalDependenciesReady',
      status: 'True',
      reason: 'Reconciled',
    })
    const internalPolicies = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(call => call[0].body)
      .filter(
        policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'internal-dependency'
      )

    expect(internalPolicies.map(policy => policy.metadata?.name)).toEqual([
      'wr-intdep-egress-test-recipe-api',
      'wr-intdep-ingress-test-recipe-db',
    ])
    expect(internalPolicies[0].spec.podSelector.matchLabels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/workload': 'api',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
  })

  it('patchStatus merges InternalDependenciesReady without deleting unrelated conditions', async () => {
    const r = makeRecipe({
      status: {
        phase: 'approved',
        conditions: [
          { type: 'ExternalEgressReady', status: 'True', lastTransitionTime: 'old' },
          {
            type: 'InternalDependenciesReady',
            status: 'False',
            reason: 'Old',
            lastTransitionTime: 'old',
          },
        ],
      },
    })

    await reconciler.patchStatus(r, {
      phase: 'active',
      message: 'All workloads deployed',
      workloadStatuses: [],
      internalDependencyConditions: [
        {
          type: 'InternalDependenciesReady',
          status: 'True',
          reason: 'Reconciled',
          message: 'ok',
          lastTransitionTime: 'now',
        },
      ],
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.conditions).toEqual([
      { type: 'ExternalEgressReady', status: 'True', lastTransitionTime: 'old' },
      {
        type: 'InternalDependenciesReady',
        status: 'True',
        reason: 'Reconciled',
        message: 'ok',
        lastTransitionTime: 'now',
      },
    ])
  })

  describe('patchStatus and the NetworkPolicy ownership condition', () => {
    const egressReady = {
      type: 'ExternalEgressReady',
      status: 'True' as const,
      lastTransitionTime: 'old',
    }
    const ownershipConflict = {
      type: 'WorkflowNetworkPolicyOwnership',
      status: 'False' as const,
      reason: 'OwnershipConflict',
      message:
        'NetworkPolicy ownership conflict: test-recipe-coord-to-wrc (owner-reference-mismatch)',
      lastTransitionTime: 'old',
    }
    const recipeWithConflict = () =>
      makeRecipe({
        status: { phase: 'active', conditions: [egressReady, ownershipConflict] },
      })
    const patchedConditions = () => {
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      return mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body.status.conditions
    }

    it('keeps the condition when the result does not carry the ownership field', async () => {
      // A pass that returns before applying the policies (in-progress short
      // circuit, degraded retry, preflight) still patches status when the
      // phase or message changes. The conflict is still live, so the
      // condition and its lastTransitionTime must survive that patch.
      await reconciler.patchStatus(recipeWithConflict(), {
        phase: 'degraded',
        message: 'Waiting for the workflow run',
        workloadStatuses: [],
      })

      const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0]?.[0].body
      expect(patch?.status.phase).toBe('degraded')
      expect(patchedConditions() ?? [egressReady, ownershipConflict]).toEqual([
        egressReady,
        ownershipConflict,
      ])
    })

    it('keeps the condition when only the workflow-output conditions are cleared', async () => {
      await reconciler.patchStatus(recipeWithConflict(), {
        phase: 'active',
        message: 'All workloads deployed',
        workloadStatuses: [],
        workflowConditions: [],
      })

      expect(patchedConditions() ?? [egressReady, ownershipConflict]).toEqual([
        egressReady,
        ownershipConflict,
      ])
    })

    it('removes the condition when the owned set is empty', async () => {
      await reconciler.patchStatus(recipeWithConflict(), {
        phase: 'active',
        message: 'All workloads deployed',
        workloadStatuses: [],
        networkPolicyOwnershipConditions: [],
      })

      expect(patchedConditions()).toEqual([egressReady])
    })

    it('replaces the condition with the fresh one', async () => {
      const fresh = {
        ...ownershipConflict,
        message:
          'NetworkPolicy ownership conflict: test-recipe-snippet-runner-egress (owner-reference-mismatch)',
      }
      await reconciler.patchStatus(recipeWithConflict(), {
        phase: 'active',
        message: 'All workloads deployed',
        workloadStatuses: [],
        networkPolicyOwnershipConditions: [fresh],
      })

      expect(patchedConditions()).toEqual([egressReady, fresh])
    })
  })

  it('replaces and clears the SDK provider-unavailable condition on recovery', async () => {
    ;(
      reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
    ).config.pluginWorkloadSdkEnabled = true
    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
      },
      status: {
        phase: 'degraded',
        conditions: [
          {
            type: PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
            status: 'True',
            reason: 'ProviderUnavailable',
            lastTransitionTime: 'old',
          },
        ],
      },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'degraded',
      message: 'configured provider unavailable',
      workloadStatuses: [],
      pluginWorkloadSdkProviderUnavailable: true,
    })
    const degradedPatch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body
    expect(
      degradedPatch.status.conditions.filter(
        (condition: { type: string }) =>
          condition.type === PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE
      )
    ).toHaveLength(1)

    mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
    const recoveredRecipe: WorkflowRecipeCRD = {
      ...recipe,
      status: { phase: 'degraded', conditions: degradedPatch.status.conditions },
    }
    await reconciler.patchStatus(recoveredRecipe, {
      phase: 'active',
      message: 'All workloads deployed',
      workloadStatuses: [],
      pluginWorkloadSdkProviderUnavailable: false,
      pluginWorkloadSdkBootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'mcp-host-pod-uid',
        provider: 'zai',
        model: 'glm-4.7',
        policyRevision: 3,
        policyHash: 'sha256:policy',
        defaultTargetRef: 'zai/glm-4.7',
        defaultProvider: 'zai',
        defaultModel: 'glm-4.7',
        verifiedAt: new Date().toISOString(),
      },
    })
    const recoveredPatch =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body
    expect(
      recoveredPatch.status.conditions.some(
        (condition: { type: string }) =>
          condition.type === PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE
      )
    ).toBe(false)
    expect(recoveredPatch.status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PluginWorkloadSdkCapability',
          status: 'True',
          reason: 'Validated',
        }),
      ])
    )
  })

  it('prunes only selected stale internal-dependency policies when none are desired', async () => {
    mockNetworkingApi.listNamespacedNetworkPolicy.mockImplementation(
      ({ namespace }: { namespace: string }) =>
        Promise.resolve({
          items:
            namespace === 'sandbox-recipes'
              ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-old' } }]
              : namespace === 'sandbox-ui'
                ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-stale-ui' } }]
                : [],
        })
    )

    const result = await reconciler.reconcile(makeRecipe())

    expect(result.phase).toBe('active')
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      status: 'True',
      reason: 'Reconciled',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-old',
      namespace: 'sandbox-recipes',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-stale-ui',
      namespace: 'sandbox-ui',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-ui',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy.mock.calls[0][0].labelSelector).toContain(
      'clerum.io/policy-type=internal-dependency'
    )
  })

  it('fails closed instead of replacing an existing non-WRC internal-dependency policy', async () => {
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.startsWith('wr-intdep-')) return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            resourceVersion: 'rv-hcc',
            labels: {
              'clerum.io/managed-by': 'host-capability-controller',
              'clerum.io/policy-type': 'binding-allow',
              'clerum.io/recipe': 'test-recipe',
            },
          },
        })
      }
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'OwnershipConflict',
    })
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('keeps a recipe retryable when an internal-dependency policy is terminating', async () => {
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.startsWith('wr-intdep-')) return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            name,
            resourceVersion: 'rv-terminating',
            deletionTimestamp: new Date('2026-09-04T00:00:00Z'),
            labels: {
              'clerum.io/managed-by': 'host-capability-controller',
              'clerum.io/policy-type': 'binding-allow',
              'clerum.io/recipe': 'test-recipe',
            },
          },
        })
      }
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toMatch(/is terminating; retrying after deletion/)
    expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('keeps a recipe retryable when an internal-dependency policy disappears before replace', async () => {
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.startsWith('wr-intdep-')) return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            name,
            resourceVersion: 'rv-before-delete',
            labels: {
              'clerum.io/managed-by': 'workflow-recipes',
              'clerum.io/policy-type': 'internal-dependency',
              'clerum.io/recipe': 'test-recipe',
            },
          },
          spec: { podSelector: {}, policyTypes: ['Ingress'] },
        })
      }
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toMatch(/disappeared during replace/)
    expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
  })

  it.each([{ code: 500 }, new Error('network timeout')])(
    'preserves an active recipe and requeues when internal-dependency reads stay unavailable (%s)',
    async readError => {
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        ({ name }: { name: string }) =>
          name.startsWith('wr-intdep-') ? Promise.reject(readError) : Promise.reject({ code: 404 })
      )

      const result = await reconciler.reconcile(
        makeRecipe({
          status: { phase: 'active', message: 'healthy before API outage', workloads: [] },
          spec: {
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'api:test',
                port: 8080,
                env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
              },
              { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
            ],
          },
        })
      )

      expect(result.phase).toBe('active')
      expect(result.message).toBe('healthy before API outage')
      expect(result.skipStatusPatch).toBe(true)
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    }
  )

  it('keeps a workflow non-terminal when internal-dependency reads stay unavailable', async () => {
    const workflowReconcile = vi.fn()
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name.startsWith('wr-intdep-')
          ? Promise.reject({ code: 500 })
          : Promise.reject({ code: 404 })
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
          steps: [{ id: 'run', run: snippetRun() }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.workflowPhase).toBeUndefined()
    expect(result.message).toBe('Workflow workload infrastructure temporarily unavailable (500)')
    expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('fails closed before workflow execution when a workflow StatefulSet hits a foreign PVC', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: { name: 'workflow-with-db', namespace: 'sandbox-recipes', uid: 'uid-workflow-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
        steps: [{ id: 'run', run: snippetRun() }],
      },
      status: { phase: 'approved' },
    })
    const expectedSts = resolveScopedStatefulSetResourceName(recipe, 'db')
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        name: 'pgdata-' + expectedSts + '-0',
        labels: { 'clerum.io/recipe': 'other-recipe', 'clerum.io/workload': 'db' },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(result.phase).toBe('failed')
    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('belongs to recipe "other-recipe" workload "db"')
  })

  it('materializes internal-dependency policies for workflow-declared workloads before execution', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
          steps: [{ id: 'run', run: snippetRun() }],
        },
      })
    )

    expect(workflowReconcile).toHaveBeenCalled()
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      status: 'True',
      reason: 'Reconciled',
    })
    const internalPolicyNames = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(call => call[0].body.metadata?.name)
      .filter((name: string | undefined) => name?.startsWith('wr-intdep-'))
    expect(internalPolicyNames).toEqual([
      'wr-intdep-egress-test-recipe-api',
      'wr-intdep-ingress-test-recipe-db',
    ])
  })

  it('does not materialize internal-dependency policies for failed non-workflow recipes', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: 'db.sandbox-recipes.svc.cluster.local' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
        status: { phase: 'failed', message: 'terminal spec failure' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('marks stdio transport workloads active after successful HCC delegation', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          contextRef: 'context1',
          workloads: [
            {
              id: 'calculator',
              type: 'deployment',
              image: 'clerum/mock-stdio-mcp-server:test',
              port: 3000,
              transport: { type: 'stdio' },
            },
          ],
        },
      })
    )

    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'calculator',
        phase: 'delegated',
        ready: true,
        message: 'HCC manages Deployment',
      },
    ])
  })

  it('rejects workflow specs above configured WRC_MAX_WORKFLOW_STEPS', async () => {
    const limitedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      maxWorkflowSteps: 2,
    })
    const result = await limitedReconciler.reconcile(
      makeRecipe({
        spec: {
          steps: [
            { id: 's1', run: snippetRun() },
            { id: 's2', run: snippetRun() },
            { id: 's3', run: snippetRun() },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('WRC_MAX_WORKFLOW_STEPS=2')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('enforces configured workload limit before deploying non-workflow recipes', async () => {
    const limitedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      workflowMaxWorkloadsPerRecipe: 1,
    })

    const result = await limitedReconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            { id: 'api', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
          ],
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'failed',
      message: 'spec.workloads must contain at most 1 items',
    })
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('enforces configured UI internal egress limit before deploying non-workflow recipes', async () => {
    const limitedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      workflowMaxWorkloadsPerRecipe: 3,
      workflowUiEgressInternalMaxItems: 1,
    })

    const result = await limitedReconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            { id: 'ui', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            { id: 'api', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            { id: 'cache', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
          ],
          ui: {
            workloadRef: 'ui',
            port: 8080,
            egress: {
              internal: [
                { workloadRef: 'api', port: 8080 },
                { workloadRef: 'cache', port: 8080 },
              ],
            },
          },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'failed',
      message: 'spec.ui.egress.internal must contain at most 1 items',
    })
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('creates Deployment for deployment workload', async () => {
    await reconciler.reconcile(makeRecipe())
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
  })

  it('creates Service for workloads with port (no transport)', async () => {
    await reconciler.reconcile(makeRecipe())
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1)
  })

  it('delegates Service creation for transport workloads to the MCP namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'mcp-server',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'test-recipe-mcp' }),
        }),
      })
    )
  })

  it('uses create-or-replace pattern on 409 (3.11c)', async () => {
    // Read-first race: the Deployment is absent at the gate read, another writer
    // creates it before our POST (409), and the gate is re-entered on the live object.
    mockAppsApi.readNamespacedDeployment
      .mockReset()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValue({ metadata: { resourceVersion: '7' }, status: { readyReplicas: 1 } })
    mockAppsApi.createNamespacedDeployment.mockReset().mockRejectedValueOnce({ code: 409 })
    mockAppsApi.replaceNamespacedDeployment.mockReset().mockResolvedValue({})

    await reconciler.reconcile(makeRecipe())

    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(
      mockAppsApi.replaceNamespacedDeployment.mock.calls[0][0].body.metadata.resourceVersion
    ).toBe('7')
  })

  // ─── Resource Creation ──────────────────────────────────────────

  it('creates resources before workloads (3.11a resources)', async () => {
    const callOrder: string[] = []
    // Record the order, then hand the call to the live store installed by
    // beforeEach, so the created objects exist for the readiness reads.
    const recordThenStore = (fn: ReturnType<typeof vi.fn>, kind: string) => {
      const store = fn.getMockImplementation()
      if (!store) throw new Error(`beforeEach installed no implementation for the ${kind} create`)
      fn.mockImplementation(async (args: unknown) => {
        callOrder.push(kind)
        return store(args)
      })
    }
    recordThenStore(mockCoreApi.createNamespacedSecret, 'secret')
    recordThenStore(mockCoreApi.createNamespacedConfigMap, 'configmap')
    recordThenStore(mockAppsApi.createNamespacedDeployment, 'deployment')

    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest', port: 8080 }],
        resources: [
          { id: 'creds', type: 'secret', data: { key: 'val' } },
          { id: 'cfg', type: 'configmap', data: { k: 'v' } },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
    // Witness: each object was created, so an index of -1 cannot pass the order check.
    expect(callOrder.filter(c => c === 'secret')).toHaveLength(1)
    expect(callOrder.filter(c => c === 'configmap')).toHaveLength(1)
    expect(callOrder).toContain('deployment')
    expect(callOrder.indexOf('secret')).toBeLessThan(callOrder.indexOf('deployment'))
    expect(callOrder.indexOf('configmap')).toBeLessThan(callOrder.indexOf('deployment'))
  })

  it('creates PVC before workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled()
  })

  // ─── Delete Pipeline ──────────────────────────────────────────────

  it('deletes workloads in reverse dependency order on DELETE (3.12a)', async () => {
    const deleteOrder: string[] = []
    mockAppsApi.deleteNamespacedDeployment.mockImplementation(async (args: { name: string }) => {
      deleteOrder.push(args.name)
      return {}
    })

    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'db', type: 'deployment', image: 'pg:15' },
          { id: 'app', type: 'deployment', image: 'app:latest', dependsOn: ['db'] },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    // app depends on db, so app deleted first (reverse order)
    expect(deleteOrder[0]).toBe('app')
    expect(deleteOrder[1]).toBe('db')
  })

  it('reconcileDelete prunes WRC internal-dependency policies across WRC namespaces', async () => {
    mockNetworkingApi.listNamespacedNetworkPolicy.mockImplementation(
      ({ namespace }: { namespace: string }) =>
        Promise.resolve({
          items:
            namespace === 'sandbox-recipes'
              ? [{ metadata: { name: 'wr-intdep-ingress-test-recipe-db' } }]
              : namespace === 'mcp-server'
                ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-mcp-recap' } }]
                : namespace === 'sandbox-ui'
                  ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-ui-drift' } }]
                  : [],
        })
    )
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'mcp-recap',
            type: 'deployment',
            image: 'mcp:test',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
          { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
        ],
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'mcp-server',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-ingress-test-recipe-db',
      namespace: 'sandbox-recipes',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-ui',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-mcp-recap',
      namespace: 'mcp-server',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-ui-drift',
      namespace: 'sandbox-ui',
    })
  })

  it('does NOT delete PVCs on DELETE (Risk 3.12) (3.12b)', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [
          { id: 'data', type: 'pvc', size: '10Gi' },
          { id: 'creds', type: 'secret', data: { k: 'v' } },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockCoreApi.deleteNamespacedSecret).toHaveBeenCalled()
    // PVCs are retained — only Secrets/ConfigMaps are deleted on recipe deletion
  })

  it('does not delete parent-owned resources copied into child WorkflowRecipes', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: { 'clerum.io/parent-recipe': 'parent-recipe' },
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [
          { id: 'creds', type: 'secret', data: { k: 'v' } },
          { id: 'cfg', type: 'configmap', data: { mode: 'test' } },
        ],
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedSecret).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedConfigMap).not.toHaveBeenCalled()
  })

  // ─── Error Handling ───────────────────────────────────────────────

  // ─── Defense-in-depth: namespace allowlist (pre-admission drift) ──

  it('refuses to reconcile recipe in foreign namespace (not in allowlist)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'hostile-recipe', namespace: 'kube-system', uid: 'uid-x' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('kube-system')
    expect(result.message).toContain('allowlist')
    expect(result.skipStatusPatch).toBe(true)
    expect(result.workloadStatuses).toEqual([])
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCustomApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('refuses WorkflowRecipe CRDs outside sandbox-recipes', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'mcp-recipe', namespace: 'mcp-server', uid: 'uid-mcp' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('mcp-server')
    expect(result.message).toContain('allowlist')
    expect(result.skipStatusPatch).toBe(true)
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('allows reconcile in sandbox-recipes namespace (allowlist member)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'sandbox-recipe', namespace: 'sandbox-recipes', uid: 'uid-sb' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
  })

  it('returns failed phase when validation fails (3.15a)', async () => {
    const recipe = makeRecipe({
      spec: { workloads: [] }, // empty workloads
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('at least one workload')
  })

  it('returns failed phase for duplicate workload IDs (3.15b)', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'app', type: 'deployment', image: 'a:1' },
          { id: 'app', type: 'deployment', image: 'a:2' },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('unique')
  })

  it('returns failed phase when a binding references an unknown workload', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-api',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
        bindings: [{ from: 'mcp-api', to: 'missing-db', port: 5432 }],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('missing-db')
  })

  it('returns failed phase when a binding does not connect exactly one transport workload', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
          { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
        ],
        bindings: [{ from: 'app', to: 'db', port: 5432 }],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('exactly one MCP transport workload')
  })

  it('returns failed phase when a binding connects two transport workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-a',
            type: 'deployment',
            image: 'mcp-a:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
          {
            id: 'mcp-b',
            type: 'deployment',
            image: 'mcp-b:latest',
            port: 3001,
            transport: { type: 'streamableHttp' },
          },
        ],
        bindings: [{ from: 'mcp-a', to: 'mcp-b', port: 3001 }],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('exactly one MCP transport workload')
  })

  it('returns failed phase when a workload egress binding uses CIDR notation', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: '0.0.0.0/0', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CIDR')
  })

  it('returns failed phase when a non-transport workload declares public-web egressBindings', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ egressClass: 'public-web' }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('public-web is only supported on MCP transport workloads')
  })

  it('creates workload egress policy for non-transport exact-host egressBindings', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
    })
    const reconcilerWithLookup = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'wl-egress-test-recipe-worker' }),
        }),
      })
    )
  })

  describe('workload egress pre-read infrastructure failures', () => {
    it.each(
      (['before DNS', 'after DNS'] as const).flatMap(stage =>
        [
          { workflow: true, code: 503 },
          { workflow: true, code: 'ECONNRESET' },
          { workflow: false, code: 503 },
          { workflow: false, code: 'ECONNRESET' },
          { workflow: true, code: 403 },
          { workflow: false, code: 403 },
        ].map(scenario => ({ ...scenario, stage }))
      )
    )('classifies $code $stage (workflow=$workflow)', async ({ workflow, code, stage }) => {
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:latest',
              port: 8080,
              egressBindings: [{ dns: 'api.example.com', port: 443 }],
            },
          ],
          ...(workflow ? { steps: [{ id: 'run', run: snippetRun() }] } : {}),
        },
        ...(!workflow
          ? {
              status: {
                phase: 'active' as const,
                message: 'Healthy before read failure',
                workloads: [],
              },
            }
          : {}),
      })
      const lookup = vi.fn(async () => ({
        kind: 'ok' as const,
        ipv4: ['93.184.216.10'],
        ipv6: [],
        ttlSeconds: 300,
      }))
      const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
        fqdnLookup: lookup,
      })
      const workflowReconcile = vi.fn()
      ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = {
        reconcile: workflowReconcile,
        validateWorkflowSpec: () => undefined,
      }
      const failure = { code }
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
        if (name === 'wl-egress-test-recipe-worker') {
          if (stage === 'after DNS' && lookup.mock.calls.length === 0) throw { code: 404 }
          throw failure
        }
        throw { code: 404 }
      })

      const result = await rec.reconcile(recipe)

      expect(lookup).toHaveBeenCalledTimes(stage === 'after DNS' ? 1 : 0)
      if (code === 403) {
        expect(result.phase).toBe('failed')
        expect(result.requeueAfterMs).toBeUndefined()
      } else {
        expect(result.phase).toBe(workflow ? 'degraded' : 'active')
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        if (!workflow) expect(result.skipStatusPatch).toBe(true)
      }
      expect(workflowReconcile).not.toHaveBeenCalled()
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
    })
  })

  describe('reconciliation completion receipt', () => {
    it.each(['success', 'reconcile-throw', 'projection-throw'] as const)(
      'emits completion only after the full pipeline returns (%s)',
      async outcome => {
        const recipe = makeRecipe()
        recipe.metadata.generation = 7
        const previousLevel = process.env.LOG_LEVEL
        process.env.LOG_LEVEL = 'info'
        const receipts: Array<Record<string, unknown>> = []
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
          for (const line of String(chunk).split('\n')) {
            if (!line.startsWith('{')) continue
            const record = JSON.parse(line)
            if (record.msg === 'recipe reconciliation completed') receipts.push(record)
          }
          return true
        }) as typeof process.stdout.write)
        const priv = reconciler as unknown as {
          reconcileInternal: () => Promise<unknown>
          projectPluginWorkloadSdk: () => unknown
        }
        const failure = new Error('pipeline failure')
        const injected =
          outcome === 'reconcile-throw'
            ? vi.spyOn(priv, 'reconcileInternal').mockRejectedValue(failure)
            : outcome === 'projection-throw'
              ? vi.spyOn(priv, 'projectPluginWorkloadSdk').mockImplementation(() => {
                  throw failure
                })
              : undefined
        try {
          if (outcome === 'success') {
            const result = await reconciler.reconcile(recipe)
            expect(result.phase).toBe('active')
            expect(receipts).toEqual([
              expect.objectContaining({
                recipe: 'test-recipe',
                namespace: 'sandbox-recipes',
                uid: 'uid-123',
                generation: 7,
                phase: 'active',
                requeueAfterMs: 0,
              }),
            ])
          } else {
            await expect(reconciler.reconcile(recipe)).rejects.toBe(failure)
            expect(receipts).toEqual([])
          }
        } finally {
          injected?.mockRestore()
          write.mockRestore()
          if (previousLevel === undefined) delete process.env.LOG_LEVEL
          else process.env.LOG_LEVEL = previousLevel
        }
      }
    )
  })

  it('fails non-transport external egress in required mode when cluster enforcement is not confirmed', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
    })
    const unconfirmedReconciler = new WorkflowRecipeReconciler(
      new k8s.KubeConfig(),
      {
        ...loadConfig(),
        networkPolicyEnforcementMode: 'required',
        networkPolicyEnforcementConfirmed: false,
      },
      {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      }
    )

    const result = await unconfirmedReconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'wl-egress-test-recipe-worker' }),
        }),
      })
    )
  })

  it('fails closed when non-transport exact-host egress resolves to a blocked address', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
    })
    const reconcilerWithLookup = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['169.254.169.254'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('resolved to blocked IPv4 address')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'wl-egress-test-recipe-worker' }),
        }),
      })
    )
  })

  it('#513: a lookup that throws fails the recipe without touching the egress policy', async () => {
    // Pins the routing the fqdnResolver gate relies on. `defaultFqdnLookup` now
    // throws rather than dressing an unclassifiable fault as "no A or AAAA
    // records"; that only helps if the throw lands somewhere honest. It must
    // reach the terminal `failed` phase carrying the real code, and it must do
    // so before any write or delete, leaving whatever egress policy is live
    // exactly as it was.
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
    })
    // The throw comes from the real producer, not from a fixture that imitates
    // it (#567 review, R1-M3). A hand-written Error pins only this test's own
    // guess at the message and `cause` shape, so a drift in `defaultFqdnLookup`
    // — different wording, a restructured cause, a change in describeRejection —
    // would leave this green while production routing broke. Mocking node:dns
    // one layer lower makes the producer emit the shape, so the two move
    // together or this test fails.
    resolve4Mock.mockRejectedValueOnce(
      Object.assign(new Error('queryA EBADFAMILY'), { code: 'EBADFAMILY' })
    )
    const reconcilerWithLookup = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: host => defaultFqdnLookup(host),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('EBADFAMILY')
    // Not laundered into the operator-facing no-records wording.
    expect(result.message).not.toContain('no A or AAAA records')
    // And it arrived as a RAW FAULT, not as a classified egress-resolution
    // failure. This is the assertion that distinguishes the two routes: a
    // `kind: 'error'` result travels through egressResolutionError(), which
    // stamps `egress resolution failed` into the message, while a throw bypasses
    // that classification entirely. Without this, restoring the #513 defect —
    // returning an error instead of throwing — leaves the test green, because
    // both routes end in `failed` with the code somewhere in the message.
    expect(result.message).not.toContain('egress resolution failed')
    expect(resolve6Mock).not.toHaveBeenCalled()

    const egressPolicy = expect.objectContaining({
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: 'wl-egress-test-recipe-worker' }),
      }),
    })
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(egressPolicy)
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(egressPolicy)
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'wl-egress-test-recipe-worker' })
    )
  })

  it('#567 remediation: contracts a removed workload binding before a sibling lookup faults', async () => {
    const policyName = 'wl-egress-test-recipe-worker'
    let existing: k8s.V1NetworkPolicy = {
      metadata: {
        name: policyName,
        namespace: 'sandbox-recipes',
        uid: 'uid-workload-egress',
        resourceVersion: '7',
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'test-recipe',
          'clerum.io/workload': 'worker',
        },
        annotations: egressStateAnnotations([
          { fqdn: 'removed.example.com', ip: '93.184.216.10', port: 443 },
          { fqdn: 'current.example.com', ip: '93.184.216.20', port: 443 },
        ]),
      },
      spec: {
        podSelector: {
          matchLabels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/workload': 'worker' },
        },
        policyTypes: ['Egress'],
        egress: ['93.184.216.10/32', '93.184.216.20/32'].map(cidr => ({
          to: [{ ipBlock: { cidr } }],
          ports: [{ port: 443, protocol: 'TCP' }],
        })),
      },
    }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === policyName ? Promise.resolve(existing) : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
      ({ body }: { body: k8s.V1NetworkPolicy }) => {
        existing = {
          ...body,
          metadata: {
            ...body.metadata,
            name: policyName,
            namespace: 'sandbox-recipes',
            uid: 'uid-workload-egress',
            resourceVersion: '8',
          },
        }
        return Promise.resolve(existing)
      }
    )
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => {
        throw Object.assign(new Error('queryA EBADFAMILY'), { code: 'EBADFAMILY' })
      },
    })
    const result = await rec.reconcile(
      makeRecipe({
        spec: {
          contextRef: 'default',
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:latest',
              port: 8080,
              egressBindings: [{ dns: 'current.example.com', port: 443 }],
            },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('EBADFAMILY')
    const replacement = mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      call => call[0]?.name === policyName
    )?.[0].body as k8s.V1NetworkPolicy
    const cidrs = (replacement?.spec?.egress ?? []).flatMap(rule =>
      (rule.to ?? []).map(peer => peer.ipBlock?.cidr)
    )
    if (replacement) {
      expect(cidrs).toEqual(['93.184.216.20/32'])
      expect(JSON.stringify(replacement.metadata?.annotations)).not.toContain('removed.example.com')
    } else {
      // If any hand-built live dimension cannot prove a subset, exact deletion
      // is the safer contraction than retaining the removed binding.
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: policyName, namespace: 'sandbox-recipes' })
      )
    }
  })

  it('#567 remediation: contracts workload authorization before a UI lookup can fail', async () => {
    const policyName = 'wl-egress-test-recipe-worker'
    const ingressPolicyName = 'wl-ingress-test-recipe-worker'
    const events: string[] = []
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === policyName || name === ingressPolicyName
          ? Promise.resolve({
              metadata: {
                name,
                namespace: 'sandbox-recipes',
                uid:
                  name === policyName ? 'uid-stale-workload-egress' : 'uid-stale-workload-ingress',
                resourceVersion: '21',
                labels: {
                  'clerum.io/managed-by': 'workflow-recipes',
                  'clerum.io/recipe': 'test-recipe',
                },
              },
              spec:
                name === policyName
                  ? { podSelector: {}, policyTypes: ['Egress'], egress: [] }
                  : { podSelector: {}, policyTypes: ['Ingress'], ingress: [] },
            } satisfies k8s.V1NetworkPolicy)
          : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(({ name }) => {
      events.push(`${name}-delete`)
      return Promise.resolve({})
    })
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => {
        events.push('ui-lookup')
        return { kind: 'error', error: 'no A records', retryable: false }
      },
    })
    const result = await rec.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            { id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 },
            { id: 'worker', type: 'deployment', image: 'worker:1', port: 3000 },
          ],
          ui: {
            workloadRef: 'frontend',
            port: 8080,
            egress: { external: [{ fqdn: 'broken.example.com', port: 443 }] },
          },
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(events).toEqual([`${policyName}-delete`, `${ingressPolicyName}-delete`, 'ui-lookup'])
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: policyName,
      namespace: 'sandbox-recipes',
      body: {
        preconditions: {
          uid: 'uid-stale-workload-egress',
          resourceVersion: '21',
        },
      },
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: ingressPolicyName,
      namespace: 'sandbox-recipes',
      body: {
        preconditions: {
          uid: 'uid-stale-workload-ingress',
          resourceVersion: '21',
        },
      },
    })
  })

  it('#567 remediation: treats a concurrent 404 contraction delete as already revoked', async () => {
    const policyName = 'wl-egress-test-recipe-worker'
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === policyName
          ? Promise.resolve({
              metadata: {
                name,
                namespace: 'sandbox-recipes',
                uid: 'uid-concurrent-delete',
                resourceVersion: '31',
                labels: {
                  'clerum.io/managed-by': 'workflow-recipes',
                  'clerum.io/recipe': 'test-recipe',
                },
              },
              spec: { podSelector: {}, policyTypes: ['Egress'], egress: [] },
            } satisfies k8s.V1NetworkPolicy)
          : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce({
      code: 404,
      message: 'already gone',
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [{ id: 'worker', type: 'deployment', image: 'worker:1', port: 8080 }],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: policyName,
      namespace: 'sandbox-recipes',
      body: { preconditions: { uid: 'uid-concurrent-delete', resourceVersion: '31' } },
    })
  })

  it('#567 remediation: treats a 404 contraction read-back as a safe concurrent revocation', async () => {
    const policyName = 'wl-egress-test-recipe-worker'
    let replaced = false
    const existing: k8s.V1NetworkPolicy = {
      metadata: {
        name: policyName,
        namespace: 'sandbox-recipes',
        uid: 'uid-readback-race',
        resourceVersion: '41',
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'test-recipe',
          'clerum.io/workload': 'worker',
        },
        annotations: egressStateAnnotations([
          { fqdn: 'removed.example.com', ip: '93.184.216.10', port: 443 },
          { fqdn: 'current.example.com', ip: '93.184.216.20', port: 443 },
        ]),
      },
      spec: {
        podSelector: {
          matchLabels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/workload': 'worker' },
        },
        policyTypes: ['Egress'],
        egress: ['93.184.216.10/32', '93.184.216.20/32'].map(cidr => ({
          to: [{ ipBlock: { cidr } }],
          ports: [{ port: 443, protocol: 'TCP' }],
        })),
      },
    }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (name !== policyName) return Promise.reject({ code: 404 })
        return replaced ? Promise.reject({ code: 404 }) : Promise.resolve(existing)
      }
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(() => {
      replaced = true
      return Promise.resolve({})
    })
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => {
        throw Object.assign(new Error('queryA EBADFAMILY'), { code: 'EBADFAMILY' })
      },
    })
    const result = await rec.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:1',
              port: 8080,
              egressBindings: [{ dns: 'current.example.com', port: 443 }],
            },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('EBADFAMILY')
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
  })

  it('#567 remediation: uses fresh post-replace identity for same-pass revocation', async () => {
    const policyName = 'wl-egress-test-recipe-worker'
    const now = Date.now()
    let live: k8s.V1NetworkPolicy = {
      metadata: {
        name: policyName,
        namespace: 'sandbox-recipes',
        uid: 'uid-workload-egress',
        resourceVersion: '7',
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'test-recipe',
          'clerum.io/workload': 'worker',
        },
        annotations: {
          'clerum.io/egress-fqdn-state': JSON.stringify(
            [
              ['removed.example.com', '93.184.216.10'],
              ['current.example.com', '93.184.216.20'],
            ].map(([fqdn, ip]) => ({
              fqdn,
              ip,
              port: 443,
              protocol: 'TCP',
              expiresAt: now - 60_000,
              lastObservedAt: now - 120_000,
            }))
          ),
          'clerum.io/egress-fqdn-resolved-at': new Date(now - 120_000).toISOString(),
        },
      },
      spec: {
        podSelector: {
          matchLabels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/workload': 'worker' },
        },
        policyTypes: ['Egress'],
        egress: ['93.184.216.10/32', '93.184.216.20/32'].map(cidr => ({
          to: [{ ipBlock: { cidr } }],
          ports: [{ port: 443, protocol: 'TCP' }],
        })),
      },
    }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === policyName ? Promise.resolve(live) : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
      ({ body }: { body: k8s.V1NetworkPolicy }) => {
        live = {
          ...body,
          metadata: {
            ...body.metadata,
            name: policyName,
            namespace: 'sandbox-recipes',
            uid: 'uid-workload-egress',
            resourceVersion: '8',
          },
        }
        return Promise.resolve(live)
      }
    )
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => ({ kind: 'error', error: 'no A records', retryable: false }),
    })
    const result = await rec.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:1',
              port: 8080,
              egressBindings: [{ dns: 'current.example.com', port: 443 }],
            },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: policyName,
      namespace: 'sandbox-recipes',
      body: {
        preconditions: { uid: 'uid-workload-egress', resourceVersion: '8' },
      },
    })
  })

  it.each([
    {
      resolverLabel: 'controller fault',
      resolverResult: 'throw' as const,
      label: 'retryable API outage',
      contractionError: () =>
        Object.assign(new Error('workload re-contraction unavailable'), { code: 503 }),
      expectedPhase: 'active' as const,
      retryable: true,
    },
    {
      resolverLabel: 'controller fault',
      resolverResult: 'throw' as const,
      label: 'non-retryable API access denial',
      contractionError: () =>
        Object.assign(new Error('workload re-contraction access denied'), { code: 403 }),
      expectedPhase: 'failed' as const,
      retryable: false,
    },
    {
      resolverLabel: 'transient DNS result',
      resolverResult: 'transient' as const,
      label: 'retryable API outage',
      contractionError: () =>
        Object.assign(new Error('workload re-contraction unavailable'), { code: 503 }),
      expectedPhase: 'active' as const,
      retryable: true,
    },
    {
      resolverLabel: 'transient DNS result',
      resolverResult: 'transient' as const,
      label: 'non-retryable API access denial',
      contractionError: () =>
        Object.assign(new Error('workload re-contraction access denied'), { code: 403 }),
      expectedPhase: 'failed' as const,
      retryable: false,
    },
  ])(
    '#567 remediation: workload $resolverLabel plus $label preserves fail-closed service semantics',
    async ({ contractionError, expectedPhase, resolverResult, retryable }) => {
      const policyName = 'wl-egress-test-recipe-worker'
      let resolverFault = false
      const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
        fqdnLookup: async () => {
          if (resolverFault) {
            if (resolverResult === 'transient') {
              return { kind: 'error', error: 'ESERVFAIL', retryable: true }
            }
            throw Object.assign(new Error('queryA EBADFAMILY'), { code: 'EBADFAMILY' })
          }
          return { kind: 'ok', ipv4: ['93.184.216.20'], ipv6: [], ttlSeconds: 300 }
        },
      })
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:1',
              port: 8080,
              egressBindings: [{ dns: 'current.example.com', port: 443 }],
            },
          ],
        },
      })
      await rec.reconcile(recipe)
      const written = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => call[0]?.body as k8s.V1NetworkPolicy)
        .find(body => body.metadata?.name === policyName)
      expect(written).toBeDefined()
      const live: k8s.V1NetworkPolicy = {
        ...structuredClone(written!),
        metadata: {
          ...written!.metadata,
          name: policyName,
          namespace: 'sandbox-recipes',
          uid: 'uid-workload-double-fault',
          resourceVersion: '70',
        },
      }
      let targetReads = 0
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        ({ name }: { name: string }) => {
          if (name !== policyName) return Promise.reject({ code: 404 })
          targetReads++
          return targetReads === 1 ? Promise.resolve(live) : Promise.reject(contractionError())
        }
      )
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockClear()
      resolverFault = true

      const result = await rec.reconcile({ ...recipe, status: { phase: 'active' } })

      expect(targetReads).toBe(2)
      expect(result.phase).toBe(expectedPhase)
      if (retryable) {
        expect(result.skipStatusPatch).toBe(true)
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      } else {
        expect(result.skipStatusPatch).not.toBe(true)
        expect(result.message).toContain('workload re-contraction access denied')
      }
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({ name: policyName }),
          }),
        })
      )
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: policyName })
      )
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: policyName })
      )
    }
  )

  it('returns failed phase when a workload egress binding uses wildcard DNS', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: '*.internal.local', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('wildcard')
  })

  it('returns failed phase when a workload egress binding targets internal DNS', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'kubernetes.default.svc', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('public DNS hostname')
  })

  it('returns failed phase when a workload egress binding includes a port in dns', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'api.example.com:443', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('must not include a port')
  })

  it('returns failed phase when a workload egress binding is not lowercase DNS', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'API.example.com', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('lowercase')
  })

  it('returns failed phase when a workload egress binding smuggles a cidr field', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [
              {
                dns: 'api.openai.com',
                port: 443,
                cidr: '10.0.0.0/8',
              } as unknown as NonNullable<
                NonNullable<WorkflowRecipeCRD['spec']['workloads']>[number]['egressBindings']
              >[number],
            ],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('cidr is not allowed')
  })

  it('handles partial failure (some workloads fail) (3.15c)', async () => {
    const storeCreate = mockAppsApi.createNamespacedDeployment.getMockImplementation()!
    mockAppsApi.createNamespacedDeployment
      .mockImplementationOnce(storeCreate)
      .mockRejectedValueOnce(new Error('quota exceeded'))

    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'db', type: 'deployment', image: 'pg:15' },
          { id: 'app', type: 'deployment', image: 'app:latest', dependsOn: ['db'] },
        ],
      },
      status: { phase: 'approved' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.workloadStatuses[0].ready).toBe(true)
    expect(result.workloadStatuses[1].ready).toBe(false)
    expect(result.phase).toBe('degraded')
  })

  it('handles StatefulSet workload type', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'pg', type: 'statefulset', image: 'pg:15', port: 5432 }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockAppsApi.createNamespacedStatefulSet).toHaveBeenCalled()
    // Headless service also created
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalled()
  })

  it('persists scoped workload instances for catalog recipes before materialization', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'catalog-recipe', namespace: 'sandbox-recipes', uid: 'uid-catalog' },
      spec: {
        workloads: [
          { id: 'api', type: 'deployment', image: 'api:latest', port: 8080 },
          { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
        ],
      },
      status: { phase: 'approved' },
    })

    await reconciler.reconcile(recipe)

    const expectedApi = resolveScopedWorkloadResourceName(recipe, 'api')
    const expectedDb = resolveScopedStatefulSetResourceName(recipe, 'db')
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workloadInstances: { api: expectedApi, db: expectedDb },
          },
        },
      }),
      expect.anything()
    )
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(
      expectedApi
    )
    expect(mockAppsApi.createNamespacedStatefulSet.mock.calls[0][0].body.metadata.name).toBe(
      expectedDb
    )
    expect(
      mockCoreApi.createNamespacedService.mock.calls.some(
        ([arg]) => arg.body.metadata.name === expectedApi
      )
    ).toBe(true)
  })

  it('reuses persisted workload instances without overwriting them', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'catalog-recipe', namespace: 'sandbox-recipes', uid: 'uid-catalog' },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
      status: { phase: 'active', workloadInstances: { api: 'stable-api-name' } },
    })

    await reconciler.reconcile(recipe)

    const workloadInstancePatches =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
        ([arg]) => arg.body?.status?.workloadInstances
      )
    expect(workloadInstancePatches).toHaveLength(0)
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(
      'stable-api-name'
    )
  })

  it('does not persist generated workload instances for dry-run previews', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'dry-run-recipe', namespace: 'sandbox-recipes', uid: 'uid-dry-run' },
      spec: {
        dryRun: true,
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    const workloadInstancePatches =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
        ([arg]) => arg.body?.status?.workloadInstances
      )
    expect(result.phase).toBe('candidate')
    expect(workloadInstancePatches).toHaveLength(0)
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('re-scopes raw Deployment names for active catalog recipes (issue #571 migration)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-catalog', namespace: 'sandbox-recipes', uid: 'uid-existing' },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedWorkloadResourceName(recipe, 'api')

    await reconciler.reconcile(recipe)

    // Migration: the legacy raw "api" name is no longer adopted — the workload is
    // re-scoped and the scoped name is persisted in status.workloadInstances.
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workloadInstances: { api: scoped },
          },
        },
      }),
      expect.anything()
    )
    expect(scoped).not.toBe('api')
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(scoped)
    expect(
      mockCoreApi.createNamespacedService.mock.calls.some(
        ([arg]) => arg.body.metadata.name === scoped
      )
    ).toBe(true)
  })

  it('defers legacy raw StatefulSet cleanup until scoped PVC migration is ready on a later reconcile', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'active' },
    })
    const expectedDb = resolveScopedStatefulSetResourceName(recipe, 'db')

    // Raw "db" exists and is owned by this recipe; the scoped workload is not ready
    // yet → cleanup must defer. The raw read carries the clerum.io/recipe ownership
    // label so the owned-probe recognizes it (issue #571 S2). The scoped name goes
    // to the live store, so the StatefulSet WRC writes is the one it reads back.
    const storeRead = mockAppsApi.readNamespacedStatefulSet.getMockImplementation()!
    const ownedRawDb = () => ({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })
    mockAppsApi.readNamespacedStatefulSet.mockImplementation(
      async (args: { name: string; namespace: string }) => {
        if (args.name === 'db') return ownedRawDb()
        const scoped = await storeRead(args)
        return { ...scoped, status: { ...scoped.status, readyReplicas: 0 } }
      }
    )
    // The legacy raw Services are live and owned by this recipe.
    for (const legacy of ['db', 'db-headless']) {
      await mockCoreApi.createNamespacedService({
        namespace: 'sandbox-recipes',
        body: { metadata: { name: legacy, labels: { 'clerum.io/recipe': 'existing-db' } } },
      })
    }
    mockCoreApi.createNamespacedService.mockClear()

    const firstResult = await reconciler.reconcile(recipe)

    expect(firstResult.requeueAfterMs).toBeGreaterThan(0)
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workloadInstances: { db: expectedDb },
          },
        },
      }),
      expect.anything()
    )
    expect(mockAppsApi.createNamespacedStatefulSet.mock.calls[0][0].body.metadata.name).toBe(
      expectedDb
    )
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalled()

    vi.clearAllMocks()

    // Second reconcile: scoped workload now ready, raw "db" still present and owned →
    // teardown fires. The scoped read returns the stored object with its ready status.
    mockAppsApi.readNamespacedStatefulSet.mockImplementation(
      async (args: { name: string; namespace: string }) =>
        args.name === 'db' ? ownedRawDb() : storeRead(args)
    )

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedStatefulSet).toHaveBeenCalledWith({
      name: 'db',
      namespace: 'sandbox-recipes',
    })
    const deletedServices = mockCoreApi.deleteNamespacedService.mock.calls.map(([arg]) => arg.name)
    expect(deletedServices).toEqual(expect.arrayContaining(['db-headless', 'db']))
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('skips legacy raw StatefulSet cleanup deletes once raw runtime resources are gone', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: {
          db: 'existing-db-db-14b8a457',
        },
      },
    })

    mockAppsApi.readNamespacedStatefulSet.mockImplementation(({ name }) => {
      if (name === 'db') return Promise.reject({ code: 404 })
      return Promise.resolve({
        metadata: { resourceVersion: '1' },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      })
    })
    mockCoreApi.readNamespacedService.mockImplementation(({ name }) => {
      if (name === 'db' || name === 'db-headless') return Promise.reject({ code: 404 })
      return Promise.resolve({
        metadata: { resourceVersion: '1' },
        spec: { clusterIP: '10.0.0.1' },
      })
    })

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'db-headless' })
    )
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'db' })
    )
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('defers legacy raw Deployment cleanup until the scoped workload is ready (issue #571)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-api', namespace: 'sandbox-recipes', uid: 'uid-existing-api' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedWorkloadResourceName(recipe, 'api')

    // Scoped workload not ready yet → tearing down the raw "api" must be deferred.
    // The raw Deployment carries this recipe's ownership label so cleanup recognizes
    // it as its own (issue #571 F2). The scoped Deployment does not exist until
    // this reconcile creates it, so its read-first gate read is a 404.
    const notReady = {
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'existing-api' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0 },
    }
    let scopedCreated = false
    mockAppsApi.readNamespacedDeployment.mockImplementation(async ({ name }: { name: string }) => {
      if (name === scoped && !scopedCreated) throw { code: 404 }
      return structuredClone(notReady)
    })
    mockAppsApi.createNamespacedDeployment.mockImplementation(
      async ({ body }: { body: { metadata: { name: string } } }) => {
        if (body.metadata.name === scoped) scopedCreated = true
        return {}
      }
    )

    const firstResult = await reconciler.reconcile(recipe)

    expect(firstResult.requeueAfterMs).toBeGreaterThan(0)
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ body: { status: { workloadInstances: { api: scoped } } } }),
      expect.anything()
    )
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(scoped)
    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('deletes the legacy raw Deployment once the scoped workload is ready (issue #571)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-api', namespace: 'sandbox-recipes', uid: 'uid-existing-api' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedWorkloadResourceName(recipe, 'api')

    // Scoped workload ready and a raw "api" still present (owned by this recipe) →
    // migrate by deleting it (issue #571 F2 ownership-gated).
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'existing-api' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    expect(scoped).not.toBe('api')
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'api',
      namespace: 'sandbox-recipes',
    })
  })

  it('does NOT delete a raw Deployment owned by a different recipe during migration (issue #571 F2)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-api', namespace: 'sandbox-recipes', uid: 'uid-existing-api' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'active' },
    })

    // A raw "api" Deployment exists but is owned by ANOTHER recipe → must be left alone.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'some-other-recipe' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('does NOT re-scope a Deployment that mounts a recipe PVC — avoids RWO deadlock (issue #571 B1)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'stateful-dep', namespace: 'sandbox-recipes', uid: 'uid-stateful-dep' },
      spec: {
        workloads: [
          {
            id: 'api',
            type: 'deployment',
            image: 'api:latest',
            port: 8080,
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
          },
        ],
        resources: [{ id: 'data', type: 'pvc', size: '1Gi' }],
      },
      status: { phase: 'active' },
    })

    // The raw "api" Deployment exists and is owned by this recipe → adopted (not
    // re-scoped) because it mounts a PVC (issue #571 B1 + S1 ownership gate).
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'stateful-dep' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    // PVC-mounting Deployment keeps the raw name (adopted): the live raw object is
    // replaced in place, the scoped Deployment is never created, and no
    // cleanup/deletion is attempted.
    const replacedNames = mockAppsApi.replaceNamespacedDeployment.mock.calls.map(
      ([arg]) => arg.name
    )
    expect(replacedNames).toEqual(['api'])
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(0)
    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('keeps requeueing deferred legacy cleanup when only legacy Services remain', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: {
          db: 'existing-db-db-14b8a457',
        },
      },
    })

    mockAppsApi.readNamespacedStatefulSet.mockImplementation(({ name }) => {
      if (name === 'db') return Promise.reject({ code: 404 })
      return Promise.resolve({
        metadata: { resourceVersion: '1' },
        spec: { replicas: 1 },
        status: { readyReplicas: 0 },
      })
    })
    mockCoreApi.readNamespacedService.mockImplementation(({ name }) => {
      if (name === 'db-headless') {
        return Promise.resolve({
          metadata: { name, resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
          spec: { clusterIP: 'None' },
        })
      }
      return Promise.reject({ code: 404 })
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.requeueAfterMs).toBeGreaterThan(0)
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('continues legacy raw StatefulSet cleanup when only legacy Services remain', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: {
          db: 'existing-db-db-14b8a457',
        },
      },
    })

    // StatefulSet reads use the live store: the raw "db" was never created, so it
    // reads as a 404, and the scoped one WRC creates reads back ready.
    mockCoreApi.readNamespacedService.mockImplementation(({ name }) => {
      if (name === 'db-headless') {
        return Promise.resolve({
          metadata: { name, resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
          spec: { clusterIP: 'None' },
        })
      }
      if (name === 'db') {
        return Promise.resolve({
          metadata: { name, resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
          spec: { clusterIP: '10.0.0.1' },
        })
      }
      return Promise.reject({ code: 404 })
    })

    await reconciler.reconcile(recipe)

    // The raw StatefulSet is already gone (404) → its delete is correctly skipped
    // (ownership-gated, per-resource; issue #571 S2). The lingering owned Services
    // are still torn down.
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    const deletedServices = mockCoreApi.deleteNamespacedService.mock.calls.map(([arg]) => arg.name)
    expect(deletedServices).toEqual(expect.arrayContaining(['db-headless', 'db']))
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('does NOT adopt a raw StatefulSet owned by another recipe — uses scoped name (issue #571 S1)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'sts-recipe', namespace: 'sandbox-recipes', uid: 'uid-sts' },
      spec: { workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 }] },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedStatefulSetResourceName(recipe, 'db')

    // A raw "db" StatefulSet exists but is owned by ANOTHER recipe → never adopted.
    mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    expect(scoped).not.toBe('db')
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ body: { status: { workloadInstances: { db: scoped } } } }),
      expect.anything()
    )
  })

  it('does NOT delete a raw StatefulSet owned by another recipe during cleanup (issue #571 S2)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'sts-recipe', namespace: 'sandbox-recipes', uid: 'uid-sts' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '1Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'active' },
    })

    // Raw "db" StatefulSet + Services exist but owned by ANOTHER recipe → left alone.
    mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })
    mockCoreApi.readNamespacedService.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
      spec: { clusterIP: '10.0.0.1' },
    })

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
  })

  it('does NOT probe legacy raw workloads for a fresh non-legacy-phase recipe (mayHaveLegacyRawWorkloads short-circuit)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'fresh-recipe', namespace: 'sandbox-recipes', uid: 'uid-fresh' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'approved' }, // non-legacy phase → cleanup must short-circuit
    })

    await reconciler.reconcile(recipe)

    // The cleanup short-circuit must skip the legacy-raw ownership probe entirely:
    // the RAW workload name "api" is never read (only the scoped name is, for
    // readiness). Mutating mayHaveLegacyRawWorkloads to `return true` would make
    // this probe fire and fail the assertion.
    const rawDeploymentReads = mockAppsApi.readNamespacedDeployment.mock.calls.filter(
      ([arg]) => arg.name === 'api'
    )
    expect(rawDeploymentReads).toHaveLength(0)
  })

  it('does NOT migrate-probe workloads of a workflow recipe (mayHaveLegacyRawWorkloads short-circuit)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'wf-recipe', namespace: 'sandbox-recipes', uid: 'uid-wf' },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
        steps: [{ id: 'step-1', instruction: 'do something' }],
      },
      status: { phase: 'active' },
    })

    await reconciler.reconcile(recipe).catch(() => undefined)

    // A workflow recipe never had raw-named workloads → no raw-name teardown probe.
    const rawDeploymentReads = mockAppsApi.readNamespacedDeployment.mock.calls.filter(
      ([arg]) => arg.name === 'api'
    )
    expect(rawDeploymentReads).toHaveLength(0)
    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('refuses to mount an existing StatefulSet PVC owned by another recipe', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'leadforge', namespace: 'sandbox-recipes', uid: 'uid-leadforge' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'approved' },
    })
    const expectedSts = resolveScopedStatefulSetResourceName(recipe, 'db')
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        name: 'pgdata-' + expectedSts + '-0',
        labels: { 'clerum.io/recipe': 'recipe-sales-crm', 'clerum.io/workload': 'db' },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(mockCoreApi.readNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: 'pgdata-' + expectedSts + '-0',
      namespace: 'sandbox-recipes',
    })
    expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(result.phase).toBe('degraded')
    expect(result.workloadStatuses).toEqual([
      expect.objectContaining({
        id: 'db',
        phase: 'failed',
        ready: false,
        message: expect.stringContaining('belongs to recipe "recipe-sales-crm" workload "db"'),
      }),
    ])
  })

  it('allows an existing StatefulSet PVC when recipe and workload labels match', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'leadforge', namespace: 'sandbox-recipes', uid: 'uid-leadforge' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'approved' },
    })
    const expectedSts = resolveScopedStatefulSetResourceName(recipe, 'db')
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        name: 'pgdata-' + expectedSts + '-0',
        labels: { 'clerum.io/recipe': 'leadforge', 'clerum.io/workload': 'db' },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(mockAppsApi.createNamespacedStatefulSet).toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedStatefulSet.mock.calls[0][0].body.metadata.name).toBe(
      expectedSts
    )
  })

  it('uses the clamped CronJob runtime name for create and observe paths', async () => {
    const workload: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'recipe-leadforge-app-v1-1-17-4a09ccfe',
        namespace: 'sandbox-recipes',
        uid: 'long-cronjob-uid',
      },
      spec: {
        workloads: [workload],
      },
      status: {
        phase: 'approved',
        workloadInstances: {
          [workload.id]: 'recipe-leadforge-app-v1-1-17-4a-prospector-enrich-cron-22afc990',
        },
      },
    })
    const expectedName = resolveWorkloadRuntimeResourceName(recipe, workload)

    await reconciler.reconcile(recipe)

    expect(expectedName.length).toBeLessThanOrEqual(52)
    expect(mockBatchApi.createNamespacedCronJob).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: expectedName }),
      }),
    })
    expect(mockBatchApi.readNamespacedCronJob).toHaveBeenCalledWith({
      name: expectedName,
      namespace: 'sandbox-recipes',
    })
  })

  it('persists the clamped CronJob workload instance before materialization', async () => {
    const workload: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'recipe-leadforge-app-v1-1-17-4a09ccfe',
        namespace: 'sandbox-recipes',
        uid: 'long-cronjob-uid',
      },
      spec: {
        workloads: [workload],
      },
      status: { phase: 'approved' },
    })

    await reconciler.reconcile(recipe)

    const statusPatchCall = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.find(
      ([arg]) => arg.body?.status?.workloadInstances?.[workload.id]
    )
    expect(statusPatchCall).toBeDefined()
    const persistedName = statusPatchCall![0].body.status.workloadInstances[workload.id]

    expect(persistedName.length).toBeLessThanOrEqual(52)
    expect(mockBatchApi.createNamespacedCronJob).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: persistedName }),
      }),
    })
    expect(mockBatchApi.readNamespacedCronJob).toHaveBeenCalledWith({
      name: persistedName,
      namespace: 'sandbox-recipes',
    })
  })

  it('uses the clamped CronJob runtime name for finalizer cleanup', async () => {
    const workload: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'recipe-leadforge-app-v1-1-17-4a09ccfe',
        namespace: 'sandbox-recipes',
        uid: 'long-cronjob-uid',
      },
      spec: {
        workloads: [workload],
      },
      status: {
        phase: 'degraded',
        workloadInstances: {
          [workload.id]: 'recipe-leadforge-app-v1-1-17-4a-prospector-enrich-cron-22afc990',
        },
      },
    })
    const expectedName = resolveWorkloadRuntimeResourceName(recipe, workload)

    await reconciler.reconcileDelete(recipe)

    expect(expectedName.length).toBeLessThanOrEqual(52)
    expect(mockBatchApi.deleteNamespacedCronJob).toHaveBeenCalledWith({
      name: expectedName,
      namespace: 'sandbox-recipes',
      // Issue #637 — Background so the CronJob's child Jobs/Pods are reaped, not orphaned.
      propagationPolicy: 'Background',
    })
  })

  // ─── Phase 6: MCP Delegation Integration ────────────────────────

  it('R.6.1 — transport workload + contextRef triggers delegation', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    // McpServer CRD ensured via customApi (create OR replace depending on pre-check result)
    const mcpEnsured =
      mockCustomApi.createNamespacedCustomObject.mock.calls.length > 0 ||
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.length > 0
    expect(mcpEnsured).toBe(true)
    // Transport Service created
    const svcCalls = mockCoreApi.createNamespacedService.mock.calls
    expect(svcCalls.length).toBeGreaterThanOrEqual(1)
    // H-04: per-recipe Context CRD created (not shared Context patched)
    const contextCreated = mockCustomApi.createNamespacedCustomObject.mock.calls.some(
      (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
    )
    expect(contextCreated).toBe(true)
  })

  it('does not materialize workloads when the recipe is deleted during network wait', async () => {
    mockCustomApi.getNamespacedCustomObject
      .mockReset()
      .mockResolvedValueOnce({ metadata: { uid: 'uid-123' } })
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 404 })
      // Issue #1349 (B-M1) — the live read that clears revocation entries before
      // the render.
      .mockRejectedValueOnce({ code: 404 })

    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.skipStatusPatch).toBe(true)
    expect(result.message).toContain('Recipe deleted during reconcile')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'sandbox-recipes' })
    )
  })

  it('R.6.2 — transport workload without contextRef delegates using private workflow context', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
    const mcpServerCall =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      )
    expect(mcpServerCall).toBeDefined()
    expect(mcpServerCall![0].body.spec).not.toHaveProperty('contextRef')
    const contextCreate =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      )
    expect(contextCreate).toBeDefined()
    expect((contextCreate![0].body.spec as Record<string, unknown>).contextId).toBe(
      'wf-test-recipe'
    )
    expect(contextCreate![0].body.spec.mcpServers).toContain(mcpServerCall![0].body.metadata.name)
  })

  it('R.6.3 — transport workload without port fails validation', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            transport: { type: 'sse' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('port')
  })

  it('R.6.4 — transport pre-deploy failure degrades (retryable) instead of latching failed', async () => {
    // The pre-deploy McpServer handshake is an eventually-consistent wait on
    // HCC. A failure means HCC has not caught up, NOT that the recipe is
    // broken — so it must degrade + retry, never brick at terminal `failed`.
    mockCustomApi.replaceNamespacedCustomObject.mockRejectedValueOnce(new Error('API unavailable'))
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('Pre-deploy failed for WorkflowRecipe "test-recipe"')
    expect(result.message).toContain('child McpServers')
    expect(result.workloadStatuses).toEqual([])
  })

  it('R.6.4b — a Context that vanishes after a create conflict in pre-deploy degrades the recipe', async () => {
    // GET 404, POST 409, re-read 404: the Context writer raises
    // ResourceVanishedAfterConflictError. The pre-deploy caller wraps every
    // pre-deploy error as retryable, so the recipe degrades (#998 review).
    mockCustomApi.createNamespacedCustomObject.mockImplementation(
      ({ plural }: { plural?: string }) =>
        plural === 'contexts' ? Promise.reject({ code: 409 }) : Promise.resolve({})
    )
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('Pre-deploy failed for WorkflowRecipe "test-recipe"')
    expect(result.message).toContain('Pre-deploy Context allowlist failed')
    expect(result.message).toContain('disappeared after create conflict')
    // Witness: the writer read, created, then re-read the Context.
    const contextReads = mockCustomApi.getNamespacedCustomObject.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
    )
    expect(contextReads).toHaveLength(2)
    expect(result.workloadStatuses).toEqual([])
  })

  it('R.6.5 — reconcileDelete calls delegation cleanup for transport workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    // McpServer CRD deleted
    expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalled()
    // Transport Service deleted
    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalled()
  })

  it('reconcileDelete fails when cross-namespace delegation cleanup cannot verify deletion', async () => {
    mockCustomApi.deleteCollectionNamespacedCustomObject.mockRejectedValueOnce(
      new Error('api down')
    )
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })

    await expect(reconciler.reconcileDelete(recipe)).rejects.toThrow(
      'McpServer label sweep failed: api down'
    )
  })

  // UID identifies the shared ledger. Only a real finalizer may forget it after
  // the last-chance cleanup succeeds; a live teardown must retain that history.
  it.each([false, true])(
    'R5-L2: reconcileDelete identifies finalizer SDK cleanup for workflow=%s',
    async workflow => {
      const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
      const deleteWorkflow = vi.fn().mockResolvedValue(undefined)
      ;(
        reconciler as unknown as {
          workflowReconciler: { cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk }
        }
      ).workflowReconciler = { cleanupPluginWorkloadSdk, reconcileDelete: deleteWorkflow }
      const recipe = makeRecipe({
        metadata: { name: 'test-recipe', namespace: 'sandbox-recipes', uid: 'uid-sdk-delete' },
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          ...(workflow ? { steps: [{ id: 'task', instruction: 'run' }] } : {}),
        },
        status: {
          phase: 'active',
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
        },
      } as Partial<WorkflowRecipeCRD>)

      await reconciler.reconcileDelete(recipe)

      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledTimes(1)
      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
        recipeUid: 'uid-sdk-delete',
        recipeDeleted: true,
        ...(workflow ? { preserveWorkflowRuntime: true } : {}),
      })
    }
  )

  // ─── Phase 8: Namespace Splitting ─────────────────────────────────

  it('R.8.1 — non-MCP workload deploys to sandbox-recipes namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 }],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('sandbox-recipes')
    expect(call.body.metadata.namespace).toBe('sandbox-recipes')
  })

  it('R.8.2 — MCP workload stays in mcp-server namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('mcp-server')
    expect(call.body.metadata.namespace).toBe('mcp-server')
  })

  it('R.8.3 — mixed recipe routes each workload to correct namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const calls = mockAppsApi.createNamespacedDeployment.mock.calls
    // redis (non-MCP) → sandbox-recipes
    const redisName = resolveScopedWorkloadResourceName(recipe, 'redis')
    const redisCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === redisName
    )
    expect(redisCall![0].namespace).toBe('sandbox-recipes')
    // redis-mcp (MCP) → mcp-server
    const mcpName = resolveScopedWorkloadResourceName(recipe, 'redis-mcp')
    const mcpCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === mcpName
    )
    expect(mcpCall![0].namespace).toBe('mcp-server')
  })

  it('R.8.4 — sandbox non-MCP workloads keep same-namespace ownerReferences', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'worker', type: 'deployment', image: 'worker:latest' }],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    // Non-MCP workload goes to sandbox-recipes with the WorkflowRecipe CRD.
    expect(call.namespace).toBe('sandbox-recipes')
    expect(call.body.metadata.ownerReferences).toBeDefined()
    expect(call.body.metadata.ownerReferences[0].name).toBe('test-recipe')
  })

  it('R.8.5 — MCP transport workloads strip ownerReferences in mcp-server', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('mcp-server')
    expect(call.body.metadata.ownerReferences).toBeUndefined()
  })

  it('R.8.6 — Service for non-MCP workload deploys to sandbox-recipes', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
    })
    await reconciler.reconcile(recipe)
    const svcCall = mockCoreApi.createNamespacedService.mock.calls[0][0]
    expect(svcCall.namespace).toBe('sandbox-recipes')
  })

  it('R.8.7 — resource follows workload namespace via volumeMount', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'pg',
            type: 'deployment',
            image: 'pg:15',
            volumeMounts: [{ name: 'pg-data', mountPath: '/var/lib/postgresql/data' }],
          },
        ],
        resources: [{ id: 'pg-data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcile(recipe)
    // PVC should be created in sandbox-recipes (where the non-MCP workload goes)
    const pvcCall = mockCoreApi.createNamespacedPersistentVolumeClaim.mock.calls[0][0]
    expect(pvcCall.namespace).toBe('sandbox-recipes')
  })

  it('R.8.8 — unmounted resource stays in recipe namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'creds', type: 'secret', data: { key: 'val' } }],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
    // Secret not mounted by any workload → stays with the recipe runtime.
    expect(mockCoreApi.createNamespacedSecret).toHaveBeenCalledTimes(1)
    const secretCall = mockCoreApi.createNamespacedSecret.mock.calls[0][0]
    expect(secretCall.namespace).toBe('sandbox-recipes')
  })

  it('R.8.9 — reconcileDelete cleans up from correct namespaces', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    const deleteCalls = mockAppsApi.deleteNamespacedDeployment.mock.calls
    // redis (non-MCP) deleted from sandbox-recipes
    const redisDelete = deleteCalls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === 'redis'
    )
    expect(redisDelete![0].namespace).toBe('sandbox-recipes')
    // redis-mcp (MCP) deleted from mcp-server
    const mcpDelete = deleteCalls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === 'redis-mcp'
    )
    expect(mcpDelete![0].namespace).toBe('mcp-server')
  })

  it('R.8.20 — workload referenced by spec.ui.workloadRef deploys to sandbox-ui', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'frontend:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('sandbox-ui')
    expect(call.body.metadata.namespace).toBe('sandbox-ui')
    // Cross-namespace from the WorkflowRecipe CRD (sandbox-recipes), so
    // ownerReferences must be stripped to satisfy the K8s GC invariant.
    expect(call.body.metadata.ownerReferences).toBeUndefined()
  })

  it('R.8.21 — three-way mixed recipe routes UI / sibling / MCP each to their own ns', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 },
          { id: 'postgres', type: 'deployment', image: 'pg:15', port: 5432 },
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcile(recipe)
    const calls = mockAppsApi.createNamespacedDeployment.mock.calls
    const byName = (name: string) => {
      const runtimeName = resolveScopedWorkloadResourceName(recipe, name)
      return calls.find(
        (c: unknown[]) =>
          (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === runtimeName
      )
    }
    expect(byName('frontend')![0].namespace).toBe('sandbox-ui')
    expect(byName('postgres')![0].namespace).toBe('sandbox-recipes')
    expect(byName('mcp-srv')![0].namespace).toBe('mcp-server')
  })

  it('R.8.22 — Service for the UI workload is created in sandbox-ui', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcile(recipe)
    const svcCall = mockCoreApi.createNamespacedService.mock.calls[0][0]
    expect(svcCall.namespace).toBe('sandbox-ui')
  })

  it('R.8.23 — ui-egress NetworkPolicy is created in sandbox-ui when spec.ui is set', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            internal: [{ workloadRef: 'postgres', port: 5432 }],
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    await reconcilerWithLookup.reconcile(recipe)
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    const npCall = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
      namespace: string
      body: { metadata: { name: string }; spec: { egress: unknown[] } }
    }
    expect(npCall.namespace).toBe('sandbox-ui')
    expect(npCall.body.metadata.name).toBe('ui-egress-test-recipe')
    expect(npCall.body.spec.egress).toHaveLength(2) // internal + external
  })

  // issue #299 — the WRC lane must leave a per-host resolution history.
  //
  // HCC emits `[NetPol] Resolved <fqdn> → [cidrs]` per DNS binding, so its lane
  // replays from retained logs: which addresses a host used, whether its
  // universe is closed, whether it drifts. WRC has had its own resolution path
  // since the same initial commit and simply never got the equivalent record,
  // so `wl-egress-*`/`ui-egress-*` were observable only in the present through
  // the live annotation — and that is the lane where the currently-exposed
  // hosts sit.
  //
  // What these tests pin, and why each matters:
  //   - the STRUCTURE of the record (a substring assert would let a rename of
  //     every field pass while every downstream query broke);
  //   - PER-FQDN attribution on a multi-host policy (a flat union cannot say
  //     which host used which address, which is the only question it is for);
  //   - that the record equals the set the written policy ENFORCES;
  //   - that a declared host resolving to nothing still emits an empty set;
  //   - both lanes, ui and workload;
  //   - and the change gate, with a positive control so "correctly quiet" is
  //     distinguishable from "never ran".
  //
  // The logger is `observability/logger.ts`, which writes one JSON line to
  // stdout and is silent under NODE_ENV=test unless LOG_LEVEL is set — hence
  // the capture helper below rather than a console spy.
  type EgressRecord = Record<string, unknown>
  function captureEgressRecords(): {
    entries: EgressRecord[]
    payloads: () => Array<{ policy: unknown; fqdn: unknown; cidrs: unknown; ports: unknown }>
    restore: () => void
  } {
    const previousLevel = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'info'
    const entries: EgressRecord[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue // vitest's own stdout, not ours
        const parsed = JSON.parse(line) as EgressRecord
        if (parsed.msg === 'resolved external egress set') entries.push(parsed)
      }
      return true
    }) as unknown as typeof process.stdout.write)
    return {
      entries,
      // The payload the record exists to carry, separated from the logger's
      // envelope (ts/level/correlationId/component/...) so a test can pin the
      // four fields a log query keys on without asserting a timestamp.
      payloads: () =>
        entries.map(e => ({ policy: e.policy, fqdn: e.fqdn, cidrs: e.cidrs, ports: e.ports })),
      restore: () => {
        spy.mockRestore()
        if (previousLevel === undefined) delete process.env.LOG_LEVEL
        else process.env.LOG_LEVEL = previousLevel
      },
    }
  }

  function uiRecipeWithExternals(external: Array<{ fqdn: string; port: number }>) {
    return makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080, egress: { external } },
      },
    })
  }

  function createdPolicy(name: string): k8s.V1NetworkPolicy | undefined {
    return mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => (c[0] as { body: k8s.V1NetworkPolicy }).body)
      .find(b => b.metadata?.name === name)
  }

  it('#513: a throwing lookup fails the recipe without touching the ui egress policy', async () => {
    // The workload lane has the same guard; this is the ui lane, which reaches
    // `resolveExternalEgress` through a different call site
    // (`reconcileUiEgressPolicy`) with its own error routing. `defaultFqdnLookup`
    // now throws rather than dressing an unclassifiable fault as "no A or AAAA
    // records", and that only helps if BOTH call sites land somewhere honest:
    // the terminal `failed` phase carrying the real code, reached before any
    // write or delete, so a live `ui-egress-*` policy is left as it was.
    // Driven through the real `defaultFqdnLookup` for the same reason as the
    // workload-lane test above (#567 review, R1-M3): the throw must be the one
    // production emits, not a copy of it maintained by hand in the test.
    resolve4Mock.mockRejectedValueOnce(
      Object.assign(new Error('queryA EBADFAMILY'), { code: 'EBADFAMILY' })
    )
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: host => defaultFqdnLookup(host),
    })

    const result = await rec.reconcile(
      uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }])
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('EBADFAMILY')
    // Not laundered into the operator-facing no-records wording.
    expect(result.message).not.toContain('no A or AAAA records')
    // And it arrived as a RAW FAULT, not as a classified egress-resolution
    // failure. This is the assertion that distinguishes the two routes: a
    // `kind: 'error'` result travels through egressResolutionError(), which
    // stamps `egress resolution failed` into the message, while a throw bypasses
    // that classification entirely. Without this, restoring the #513 defect —
    // returning an error instead of throwing — leaves the test green, because
    // both routes end in `failed` with the code somewhere in the message.
    expect(result.message).not.toContain('egress resolution failed')
    expect(resolve6Mock).not.toHaveBeenCalled()

    expect(createdPolicy('ui-egress-test-recipe')).toBeUndefined()
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'ui-egress-test-recipe' }),
        }),
      })
    )
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ui-egress-test-recipe' })
    )
  })

  it('#567 remediation: contracts a removed UI binding before a sibling lookup faults', async () => {
    const policyName = 'ui-egress-test-recipe'
    const existing: k8s.V1NetworkPolicy = {
      metadata: {
        name: policyName,
        namespace: 'sandbox-ui',
        uid: 'uid-ui-egress',
        resourceVersion: '8',
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'test-recipe',
        },
        annotations: egressStateAnnotations([
          { fqdn: 'removed.example.com', ip: '93.184.216.10', port: 443 },
          { fqdn: 'current.example.com', ip: '93.184.216.20', port: 443 },
        ]),
      },
      spec: {
        podSelector: { matchLabels: { 'clerum.io/sandbox-ui': 'true' } },
        policyTypes: ['Egress'],
        egress: ['93.184.216.10/32', '93.184.216.20/32'].map(cidr => ({
          to: [{ ipBlock: { cidr } }],
          ports: [{ port: 443, protocol: 'TCP' }],
        })),
      },
    }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === policyName ? Promise.resolve(existing) : Promise.reject({ code: 404 })
    )
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => {
        throw Object.assign(new Error('queryA EBADFAMILY'), { code: 'EBADFAMILY' })
      },
    })
    const result = await rec.reconcile(
      uiRecipeWithExternals([{ fqdn: 'current.example.com', port: 443 }])
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('EBADFAMILY')
    const replacement = mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      call => call[0]?.name === policyName
    )?.[0].body as k8s.V1NetworkPolicy
    const cidrs = (replacement?.spec?.egress ?? []).flatMap(rule =>
      (rule.to ?? []).map(peer => peer.ipBlock?.cidr)
    )
    if (replacement) {
      expect(cidrs).toEqual(['93.184.216.20/32'])
      expect(JSON.stringify(replacement.metadata?.annotations)).not.toContain('removed.example.com')
    } else {
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: policyName, namespace: 'sandbox-ui' })
      )
    }
  })

  it('#567 remediation: a transient lookup cannot promote annotation-only UI egress', async () => {
    let transient = false
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () =>
        transient
          ? { kind: 'error', error: 'ESERVFAIL', retryable: true }
          : { kind: 'ok', ipv4: ['93.184.216.20'], ipv6: [], ttlSeconds: 300 },
    })
    const recipe = uiRecipeWithExternals([{ fqdn: 'current.example.com', port: 443 }])
    await rec.reconcile(recipe)
    const written = createdPolicy('ui-egress-test-recipe')!
    let liveWithoutRule: k8s.V1NetworkPolicy = {
      ...written,
      metadata: {
        ...written.metadata,
        uid: 'uid-ui-egress',
        resourceVersion: '10',
      },
      spec: { ...written.spec!, egress: [] },
    }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === 'ui-egress-test-recipe'
          ? Promise.resolve(liveWithoutRule)
          : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
      ({ name, body }: { name: string; body: k8s.V1NetworkPolicy }) => {
        if (name === 'ui-egress-test-recipe') {
          liveWithoutRule = {
            ...body,
            metadata: {
              ...body.metadata,
              name,
              namespace: 'sandbox-ui',
              uid: 'uid-ui-egress',
              resourceVersion: '11',
            },
          }
          return Promise.resolve(liveWithoutRule)
        }
        return Promise.resolve({})
      }
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
    transient = true

    const result = await rec.reconcile(recipe)
    expect(result.phase).toBe('degraded')
    const writtenBodies = [
      ...mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.map(call => call[0]?.body),
      ...mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.map(call => call[0]?.body),
    ].filter(body => body?.metadata?.name === 'ui-egress-test-recipe') as k8s.V1NetworkPolicy[]
    for (const body of writtenBodies) {
      const cidrs = (body.spec?.egress ?? []).flatMap(rule =>
        (rule.to ?? []).map(peer => peer.ipBlock?.cidr)
      )
      expect(cidrs).not.toContain('93.184.216.20/32')
      expect(body.metadata?.annotations?.['clerum.io/egress-fqdn-state']).toBe('[]')
    }
  })

  it.each(['success', 'fault'] as const)(
    '#567 remediation: re-contracts a UI policy widened during DNS %s latency',
    async mode => {
      let secondRound = false
      let live: k8s.V1NetworkPolicy | undefined
      const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
        fqdnLookup: async () => {
          if (secondRound && live) {
            live = structuredClone(live)
            live.spec!.egress!.push({
              to: [{ ipBlock: { cidr: '8.8.8.8/32' } }],
              ports: [{ port: 443, protocol: 'TCP' }],
            })
            if (mode === 'fault') {
              throw Object.assign(new Error('post-list EBADFAMILY'), { code: 'EBADFAMILY' })
            }
          }
          return { kind: 'ok', ipv4: ['93.184.216.20'], ipv6: [], ttlSeconds: 300 }
        },
      })
      const recipe = uiRecipeWithExternals([{ fqdn: 'current.example.com', port: 443 }])
      await rec.reconcile(recipe)
      const written = createdPolicy('ui-egress-test-recipe')!
      live = {
        ...structuredClone(written),
        metadata: {
          ...written.metadata,
          name: 'ui-egress-test-recipe',
          namespace: 'sandbox-ui',
          uid: 'uid-ui-dns-race',
          resourceVersion: '50',
        },
      }
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        ({ name }: { name: string }) =>
          name === 'ui-egress-test-recipe' && live
            ? Promise.resolve(live)
            : Promise.reject({ code: 404 })
      )
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
        ({ body }: { body: k8s.V1NetworkPolicy }) => {
          live = {
            ...body,
            metadata: {
              ...body.metadata,
              name: 'ui-egress-test-recipe',
              namespace: 'sandbox-ui',
              uid: 'uid-ui-dns-race',
              resourceVersion: '51',
            },
          }
          return Promise.resolve(live)
        }
      )
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      secondRound = true

      const result = await rec.reconcile(recipe)

      expect(result.phase).toBe(mode === 'fault' ? 'failed' : 'active')
      const replacements = mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls
        .filter(call => call[0]?.name === 'ui-egress-test-recipe')
        .map(call => call[0]?.body as k8s.V1NetworkPolicy)
      expect(replacements.length).toBeGreaterThan(0)
      for (const replacement of replacements) {
        expect(JSON.stringify(replacement.spec?.egress)).not.toContain('8.8.8.8')
      }
    }
  )

  it.each([
    {
      resolverLabel: 'controller fault',
      resolverResult: 'throw' as const,
      label: 'retryable API outage',
      contractionError: () =>
        Object.assign(new Error('UI re-contraction unavailable'), { code: 503 }),
      expectedPhase: 'active' as const,
      retryable: true,
    },
    {
      resolverLabel: 'controller fault',
      resolverResult: 'throw' as const,
      label: 'non-retryable API access denial',
      contractionError: () =>
        Object.assign(new Error('UI re-contraction access denied'), { code: 403 }),
      expectedPhase: 'failed' as const,
      retryable: false,
    },
    {
      resolverLabel: 'transient DNS result',
      resolverResult: 'transient' as const,
      label: 'retryable API outage',
      contractionError: () =>
        Object.assign(new Error('UI re-contraction unavailable'), { code: 503 }),
      expectedPhase: 'active' as const,
      retryable: true,
    },
    {
      resolverLabel: 'transient DNS result',
      resolverResult: 'transient' as const,
      label: 'non-retryable API access denial',
      contractionError: () =>
        Object.assign(new Error('UI re-contraction access denied'), { code: 403 }),
      expectedPhase: 'failed' as const,
      retryable: false,
    },
  ])(
    '#567 remediation: UI $resolverLabel plus $label preserves fail-closed service semantics',
    async ({ contractionError, expectedPhase, resolverResult, retryable }) => {
      const policyName = 'ui-egress-test-recipe'
      let resolverFault = false
      const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
        fqdnLookup: async () => {
          if (resolverFault) {
            if (resolverResult === 'transient') {
              return { kind: 'error', error: 'ESERVFAIL', retryable: true }
            }
            throw Object.assign(new Error('queryA EBADFAMILY'), { code: 'EBADFAMILY' })
          }
          return { kind: 'ok', ipv4: ['93.184.216.20'], ipv6: [], ttlSeconds: 300 }
        },
      })
      const recipe = uiRecipeWithExternals([{ fqdn: 'current.example.com', port: 443 }])
      await rec.reconcile(recipe)
      const written = createdPolicy(policyName)
      expect(written).toBeDefined()
      const live: k8s.V1NetworkPolicy = {
        ...structuredClone(written!),
        metadata: {
          ...written!.metadata,
          name: policyName,
          namespace: 'sandbox-ui',
          uid: 'uid-ui-double-fault',
          resourceVersion: '80',
        },
      }
      let targetReads = 0
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        ({ name }: { name: string }) => {
          if (name !== policyName) return Promise.reject({ code: 404 })
          targetReads++
          return targetReads === 1 ? Promise.resolve(live) : Promise.reject(contractionError())
        }
      )
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockClear()
      resolverFault = true

      const result = await rec.reconcile({ ...recipe, status: { phase: 'active' } })

      expect(targetReads).toBe(2)
      expect(result.phase).toBe(expectedPhase)
      if (retryable) {
        expect(result.skipStatusPatch).toBe(true)
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      } else {
        expect(result.skipStatusPatch).not.toBe(true)
        expect(result.message).toContain('UI re-contraction access denied')
      }
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({ name: policyName }),
          }),
        })
      )
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: policyName })
      )
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: policyName })
      )
    }
  )

  it('#567 remediation: persists the prior resolved-at when a permanent failure narrows the policy', async () => {
    let permanentFailure = false
    let live: k8s.V1NetworkPolicy | undefined
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () =>
        permanentFailure
          ? { kind: 'error', error: 'no A records', retryable: false }
          : { kind: 'ok', ipv4: ['93.184.216.20'], ipv6: [], ttlSeconds: 30 },
    })
    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 },
          { id: 'backend', type: 'deployment', image: 'backend:1', port: 8080 },
        ],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            internal: [{ workloadRef: 'backend', port: 8080 }],
            external: [{ fqdn: 'api.example.com', port: 443 }],
          },
        },
      },
    })
    await rec.reconcile(recipe)
    const written = createdPolicy('ui-egress-test-recipe')!
    const oldResolvedAt = '2000-01-01T00:00:00.000Z'
    const state = JSON.parse(
      written.metadata!.annotations!['clerum.io/egress-fqdn-state']
    ) as Array<Record<string, unknown>>
    for (const entry of state) entry.expiresAt = Date.now() + 600_000
    live = {
      ...structuredClone(written),
      metadata: {
        ...written.metadata,
        name: 'ui-egress-test-recipe',
        namespace: 'sandbox-ui',
        uid: 'uid-ui-permanent-narrow',
        resourceVersion: '60',
        annotations: {
          ...written.metadata!.annotations,
          'clerum.io/egress-fqdn-state': JSON.stringify(state),
          'clerum.io/egress-fqdn-resolved-at': oldResolvedAt,
        },
      },
    }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === 'ui-egress-test-recipe' && live
          ? Promise.resolve(live)
          : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
      ({ name, body }: { name: string; body: k8s.V1NetworkPolicy }) => {
        if (name === 'ui-egress-test-recipe') {
          live = {
            ...body,
            metadata: {
              ...body.metadata,
              name,
              namespace: 'sandbox-ui',
              uid: 'uid-ui-permanent-narrow',
              resourceVersion: '61',
            },
          }
          return Promise.resolve(live)
        }
        return Promise.resolve({})
      }
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
    permanentFailure = true

    const result = await rec.reconcile(recipe)

    expect(result.phase).toBe('failed')
    const replacement = mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls
      .filter(call => call[0]?.name === 'ui-egress-test-recipe')
      .at(-1)?.[0].body as k8s.V1NetworkPolicy
    expect(replacement.metadata?.annotations?.['clerum.io/egress-fqdn-resolved-at']).toBe(
      oldResolvedAt
    )
    expect(replacement.metadata?.annotations?.['clerum.io/egress-fqdn-state']).toBe('[]')
    expect(JSON.stringify(replacement.spec?.egress)).not.toContain('93.184.216.20')
  })

  it('records the ui lane egress set with the exact enforced cidrs and ports', async () => {
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        // Deliberately chosen so the three candidate orders all differ: input
        // order is 140 then 93; a plain string sort (and the accumulator's own
        // key order) also puts "140" first because it compares '1' to '9'; only
        // an address-wise sort puts 93 first.
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['140.82.112.4', '93.184.216.11'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }]))

      // The whole record, not a substring: field names and value shapes are the
      // contract a log query depends on, so a rename must fail here.
      expect(cap.payloads()).toEqual([
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.11/32', '140.82.112.4/32'], // by address, not lexeme
          ports: [443],
        },
      ])

      // It must go through the service's structured logger, not a bare
      // console.log: the envelope is what makes the record queryable and what
      // gives operators a LOG_LEVEL switch. A regression to console.log emits
      // no JSON line at all and fails above; this pins the envelope's shape.
      expect(cap.entries[0]).toMatchObject({
        level: 'info',
        component: 'wrc',
        recipeName: 'test-recipe',
        msg: 'resolved external egress set',
      })

      // ...and it must equal what the policy actually enforces. This is the
      // property the record exists to have: an audit trail that disagrees with
      // the policy would attest to an allowance that never existed.
      const written = createdPolicy('ui-egress-test-recipe')
      const enforced = (written?.spec?.egress ?? [])
        .flatMap(rule => rule.to ?? [])
        .flatMap(peer => (peer.ipBlock ? [peer.ipBlock.cidr] : []))
        .sort()
      // Compared as content, not order — the record's order is its own readable
      // contract, pinned above; what must match the policy is the SET.
      expect([...(cap.payloads()[0].cidrs as string[])].sort()).toEqual(enforced)
    } finally {
      cap.restore()
    }
  })

  it('attributes each address to its own host on a multi-FQDN policy', async () => {
    // A flat union per policy — the shape this replaced — cannot answer "which
    // addresses did THIS host use", which is the only question the history is
    // for. `egress.external[]` is a list, so multi-host is the normal case.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async (fqdn: string) =>
          fqdn === 'api.github.com'
            ? { kind: 'ok' as const, ipv4: ['140.82.112.4'], ipv6: [], ttlSeconds: 60 }
            : { kind: 'ok' as const, ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 },
      })

      await rec.reconcile(
        uiRecipeWithExternals([
          { fqdn: 'api.stripe.com', port: 443 },
          { fqdn: 'api.github.com', port: 443 },
        ])
      )

      expect(cap.payloads()).toEqual([
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.github.com',
          cidrs: ['140.82.112.4/32'],
          ports: [443],
        },
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.10/32'],
          ports: [443],
        },
      ])
      // Neither host's address leaks into the other's record.
      expect(cap.payloads()[0].cidrs).not.toContain('93.184.216.10/32')
      expect(cap.payloads()[1].cidrs).not.toContain('140.82.112.4/32')
    } finally {
      cap.restore()
    }
  })

  it('keeps a port-only change visible when the address set is identical', async () => {
    // `changed` is defined over (fqdn,ip,port,protocol), so the same host on a
    // second port IS a change and rewrites the policy. Carrying only addresses
    // would render an identical record and hide it.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(
        uiRecipeWithExternals([
          { fqdn: 'api.stripe.com', port: 443 },
          { fqdn: 'api.stripe.com', port: 8443 },
        ])
      )

      expect(cap.payloads()).toEqual([
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.10/32'],
          ports: [443, 8443], // numeric sort, and both ports survive
        },
      ])
    } finally {
      cap.restore()
    }
  })

  it('still records a declared host that resolved to no addresses', async () => {
    // A set collapsing to empty is the most consequential event in the series.
    // Suppressing the record when there is nothing to list would make it
    // indistinguishable from "nothing happened" for a log-based replay.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async (fqdn: string) =>
          fqdn === 'gone.example.com'
            ? { kind: 'ok' as const, ipv4: [], ipv6: [], ttlSeconds: 60 }
            : { kind: 'ok' as const, ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 },
      })

      await rec.reconcile(
        uiRecipeWithExternals([
          { fqdn: 'api.stripe.com', port: 443 },
          { fqdn: 'gone.example.com', port: 443 },
        ])
      )

      const empty = cap.payloads().find(r => r.fqdn === 'gone.example.com')
      expect(empty).toEqual({
        policy: 'ui-egress-test-recipe',
        fqdn: 'gone.example.com',
        cidrs: [],
        ports: [],
      })
    } finally {
      cap.restore()
    }
  })

  it('records the workload lane too, not only the ui lane', async () => {
    // One emitter serves both call sites; without this test, silencing the
    // `wl-egress-*` half would pass the whole suite.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(
        makeRecipe({
          spec: {
            contextRef: 'default',
            workloads: [
              {
                id: 'worker',
                type: 'deployment',
                image: 'worker:latest',
                port: 8080,
                // The workload lane declares hosts as exact-host egressBindings,
                // not ui.egress.external — the reconciler maps b.dns to the
                // accumulator's fqdn.
                egressBindings: [{ dns: 'api.stripe.com', port: 443 }],
              },
            ],
          },
        })
      )

      expect(cap.payloads()).toEqual([
        {
          policy: 'wl-egress-test-recipe-worker',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.10/32'],
          ports: [443],
        },
      ])
    } finally {
      cap.restore()
    }
  })

  it('never records an address the M3 filter kept OUT of the written policy', async () => {
    // The record is taken from the post-filter set, so it cannot attest to an
    // allowance that never existed. Fresh DNS cannot exercise this — the
    // resolver fails a whole host closed if any A record is blocked — so the
    // blocked address arrives the only way it can: rehydrated from the live
    // policy's state annotation, which parseState validates for SYNTAX only.
    const cap = captureEgressRecords()
    try {
      const now = Date.now()
      const rehydrated = [
        // A private address someone put on the annotation. Syntactically valid,
        // still inside its window, and dropped by isBlockedExternalIPv4.
        {
          ip: '10.0.0.5',
          port: 443,
          protocol: 'TCP',
          fqdn: 'api.stripe.com',
          expiresAt: now + 600_000,
          lastObservedAt: now,
        },
        {
          ip: '93.184.216.10',
          port: 443,
          protocol: 'TCP',
          fqdn: 'api.stripe.com',
          expiresAt: now + 600_000,
          lastObservedAt: now,
        },
      ]
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
        metadata: {
          name: 'ui-egress-test-recipe',
          uid: 'uid-ui-egress-test-recipe',
          resourceVersion: '1',
          labels: {
            'clerum.io/managed-by': 'workflow-recipes',
            'clerum.io/recipe': 'test-recipe',
          },
          annotations: { 'clerum.io/egress-fqdn-state': JSON.stringify(rehydrated) },
        },
      })

      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        // A NEW address this round, so the set changed and a record is due.
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.99'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }]))

      expect(cap.payloads()).toHaveLength(1)
      const recorded = cap.payloads()[0].cidrs as string[]
      expect(recorded).not.toContain('10.0.0.5/32')
      // The prior public address existed only in the annotation, not in a live
      // rule. Contraction must not promote it during the next successful round.
      expect(recorded).toEqual(['93.184.216.99/32'])
    } finally {
      cap.restore()
    }
  })

  it('does NOT record a RENEWAL write, which writes with the set unchanged', async () => {
    // The gate is `changed`, not "did we write". A renewal (audit M1) re-persists
    // an aging window with an identical set: the policy IS rewritten and no
    // record is due, because nothing about the resolved set changed. That is the
    // direction the record does NOT run — an entry implies a write, not the
    // converse.
    //
    // ISOLATING renewalDue. The live policy fed back here is the reconciler's OWN
    // first render, with only the state annotation's `expiresAt` rewound. That
    // matters: it makes the rendered spec.egress byte-identical, so
    // `egressWriteNeeded` is FALSE and `changed` is FALSE, leaving renewalDue as
    // the only term of the H4 gate that can still authorise a write. A fixture
    // carrying just `metadata` would leave egressWriteNeeded true and the test
    // would pass without renewalDue ever being the cause.
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      // The SAME address both rounds, so the (fqdn,ip,port,protocol) set is unchanged.
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['93.184.216.10'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })
    const recipe = uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }])

    await rec.reconcile(recipe)
    const rendered = createdPolicy('ui-egress-test-recipe')
    expect(rendered).toBeDefined()

    // Rewind ONLY the persisted expiry, keeping every (fqdn,ip,port,protocol)
    // tuple. renewalDue fires when a surviving entry's persisted expiry is within
    // overlap/2 of now and this round would advance it.
    const persisted = JSON.parse(
      rendered!.metadata!.annotations!['clerum.io/egress-fqdn-state']
    ) as Array<Record<string, unknown>>
    const aging = persisted.map(e => ({ ...e, expiresAt: Date.now() + 30_000 }))
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === 'ui-egress-test-recipe'
          ? Promise.resolve({
              ...rendered,
              metadata: {
                ...rendered!.metadata,
                resourceVersion: '1',
                annotations: {
                  ...rendered!.metadata!.annotations,
                  'clerum.io/egress-fqdn-state': JSON.stringify(aging),
                },
              },
            })
          : Promise.reject({ code: 404 })
    )

    const cap = captureEgressRecords()
    try {
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

      await rec.reconcile(recipe)

      // POSITIVE CONTROL: a write really happened. With the spec identical and the
      // set unchanged, renewalDue is the only term left that could have caused it,
      // so this also proves the no-op gate did NOT short-circuit.
      const wrote =
        mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.length +
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.length
      expect(wrote).toBeGreaterThan(0)
      // ...and no record, because the resolved set did not change.
      expect(cap.payloads()).toHaveLength(0)
    } finally {
      cap.restore()
    }
  })

  it('does NOT re-record when the resolved set is unchanged', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    const recipe = uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }])

    await rec.reconcile(recipe)
    // Feed the first render back as the live policy, exactly as the H-E test
    // below does — no hand-built fixture.
    const created = createdPolicy('ui-egress-test-recipe')
    expect(created).toBeDefined()
    mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      ...created!,
      metadata: {
        ...created!.metadata,
        uid: 'uid-ui-egress-test-recipe',
        resourceVersion: '1',
      },
    })

    const cap = captureEgressRecords()
    try {
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      await rec.reconcile(recipe)

      expect(cap.payloads()).toHaveLength(0)
      expect(
        mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
          call => call[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
        )
      ).toBe(false)
      expect(
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.some(
          call => call[0]?.name === 'ui-egress-test-recipe'
        )
      ).toBe(false)
    } finally {
      cap.restore()
    }
  })

  it('replaces a live ui egress policy whose set changed without a create probe', async () => {
    const policyName = 'ui-egress-test-recipe'
    let address = '93.184.216.10'
    const rec = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: [address], ipv6: [], ttlSeconds: 300 }),
    })
    const recipe = uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }])
    await rec.reconcile(recipe)
    const created = createdPolicy(policyName)
    expect(created).toBeDefined()
    // Stateful live policy: the first render, then whatever each PUT writes.
    let live: k8s.V1NetworkPolicy = {
      ...structuredClone(created!),
      metadata: { ...created!.metadata, uid: 'uid-ui-egress-test-recipe', resourceVersion: '1' },
    }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name === policyName ? Promise.resolve(structuredClone(live)) : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
      ({ name, body }: { name: string; body: k8s.V1NetworkPolicy }) => {
        if (name !== policyName) return Promise.resolve({})
        live = {
          ...structuredClone(body),
          metadata: {
            ...body.metadata,
            uid: 'uid-ui-egress-test-recipe',
            resourceVersion: String(Number(live.metadata!.resourceVersion) + 1),
          },
        }
        return Promise.resolve(structuredClone(live))
      }
    )
    mockNetworkingApi.readNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
    address = '93.184.216.20'

    const result = await rec.reconcile(recipe)

    expect(result.phase).toBe('active')
    // Witness: the caller read the live policy it now hands to the apply.
    expect(
      readsOf(mockNetworkingApi.readNamespacedNetworkPolicy, policyName, 'sandbox-ui')
    ).toBeGreaterThanOrEqual(1)
    expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, policyName)).toBe(0)
    expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, policyName)).toBe(1)
    const cidrs = (live.spec?.egress ?? []).flatMap(rule =>
      (rule.to ?? []).map(peer => peer.ipBlock?.cidr)
    )
    expect(cidrs).toContain('93.184.216.20/32')
  })

  // H-E (audit): a rename of the external FQDN onto the SAME resolved IP/port
  // renders identical spec.egress, so the egress-signature gate alone would no-op
  // and discard the re-attributed state annotation. acc.changed must force the
  // write. This guards the reconciler WIRING of egressStateChanged (the closing
  // Fable cert flagged the gate term as untested). Uses the reconciler's own
  // first-reconcile output as the live policy — no hand-built fixture.
  it('R.8.24 — H-E: renaming the external FQDN onto the same IP re-persists the policy', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    const uiWith = (fqdn: string) =>
      makeRecipe({
        spec: {
          workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
          ui: {
            workloadRef: 'frontend',
            port: 8080,
            egress: { external: [{ fqdn, port: 443 }] },
          },
        },
      })

    // First reconcile authors the live ui-egress policy (IP pinned under old fqdn).
    await rec.reconcile(uiWith('old.example.com'))
    const p1 = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => c[0].body)
      .find(b => b?.metadata?.name === 'ui-egress-test-recipe')
    expect(p1).toBeTruthy()

    // That policy is now live; the next reconcile renames the FQDN onto the SAME IP.
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(
        name === 'ui-egress-test-recipe'
          ? {
              ...p1,
              metadata: {
                ...p1.metadata,
                uid: 'uid-ui-egress-test-recipe',
                resourceVersion: '1',
              },
            }
          : { metadata: { name, resourceVersion: '1' } }
      )
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

    await rec.reconcile(uiWith('new.example.com'))

    const wroteUiEgress =
      mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        c => c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      ) ||
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.some(
        c =>
          c[0]?.name === 'ui-egress-test-recipe' ||
          c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      )
    // Rendered egress is byte-identical (same /32, same port); only acc.changed
    // (old→new attribution) forces this write. Reverting the gate term no-ops it.
    expect(wroteUiEgress).toBe(true)
  })

  // R1-M2 (zach88): an internal-only ui-egress policy (no external[]) must reach
  // the no-op gate on an unchanged reconcile. Before the fix the live-policy read
  // sat inside the externals-only branch, so `existing` stayed null and the policy
  // was rewritten every reconcile (amplified for mixed recipes by the 60s refresh).
  it('R1-M2: an internal-only ui-egress policy is a no-op on the second reconcile', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {})
    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 },
          { id: 'backend', type: 'deployment', image: 'be:1', port: 9090 },
        ],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: { internal: [{ workloadRef: 'backend', port: 9090 }] },
        },
      },
    })
    await rec.reconcile(recipe)
    const p1 = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => c[0].body)
      .find(b => b?.metadata?.name === 'ui-egress-test-recipe')
    expect(p1).toBeTruthy()

    // The policy is now live; a second identical reconcile must NOT rewrite it.
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(
        name === 'ui-egress-test-recipe' ? p1 : { metadata: { name, resourceVersion: '1' } }
      )
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

    await rec.reconcile(recipe)

    const wroteUiEgress =
      mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        c => c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      ) ||
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.some(
        c =>
          c[0]?.name === 'ui-egress-test-recipe' ||
          c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      )
    expect(wroteUiEgress).toBe(false)
  })

  // R1-M3 (zach88): the no-op gate must hold when the LIVE policy is apiserver-
  // shaped — each rule's keys reordered ({ports,to} not {to,ports}) and each
  // port's keys reordered ({protocol,port} not {port,protocol}) — which is
  // exactly what the canonicalize/egressSignature fix motivates but R.8.24
  // (which feeds the builder's own output back verbatim) never exercised. The
  // builder already emits protocol:'TCP' on every port, so this exercises key
  // ORDER only; egressSignature deliberately treats an absent protocol as
  // distinct from 'TCP', a shape that cannot arise for builder-written policies.
  it('R1-M3: external egress is a no-op against an apiserver-normalized live policy', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: { external: [{ fqdn: 'api.example.com', port: 443 }] },
        },
      },
    })
    await rec.reconcile(recipe)
    const p1 = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => c[0].body)
      .find(b => b?.metadata?.name === 'ui-egress-test-recipe')
    expect(p1).toBeTruthy()

    // Reshape p1 the way the apiserver returns it: reorder each rule's keys
    // ({ports,to}) and each port's keys ({protocol,port}). The builder already
    // set protocol:'TCP', so this preserves the value and only changes key
    // order. The state annotation is preserved.
    const live = JSON.parse(JSON.stringify(p1))
    live.spec.egress = (live.spec.egress ?? []).map((rule: Record<string, unknown>) => ({
      ports: ((rule.ports as Array<Record<string, unknown>>) ?? []).map(pt => ({
        protocol: pt.protocol,
        port: pt.port,
      })),
      to: (rule.to as Array<Record<string, unknown>>) ?? [],
    }))

    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(
        name === 'ui-egress-test-recipe' ? live : { metadata: { name, resourceVersion: '1' } }
      )
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

    await rec.reconcile(recipe) // identical resolver output → same set → no-op

    const wrote =
      mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        c => c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      ) ||
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.some(
        c =>
          c[0]?.name === 'ui-egress-test-recipe' ||
          c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      )
    expect(wrote).toBe(false)
  })

  it('fails sandbox UI external egress in required mode when cluster enforcement is not confirmed', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
      },
    })
    const unconfirmedReconciler = new WorkflowRecipeReconciler(
      new k8s.KubeConfig(),
      {
        ...loadConfig(),
        networkPolicyEnforcementMode: 'required',
        networkPolicyEnforcementConfirmed: false,
      },
      {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      }
    )

    const result = await unconfirmedReconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-ui',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'ui-egress-test-recipe' }),
        }),
      })
    )
  })

  it('fails closed when sandbox UI external egress resolves to a blocked address', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['169.254.169.254'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(result.message).toContain('resolved to blocked IPv4 address')
  })

  it('fails workflow deployment before execution when sandbox UI egress cannot be enforced', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
        steps: [{ id: 'render', run: snippetRun() }],
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['169.254.169.254'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconcilerWithLookup as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(result.message).toContain('resolved to blocked IPv4 address')
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockCustomApi.createNamespacedCustomObject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          kind: 'WorkflowRecipe',
          metadata: expect.objectContaining({ name: expect.stringContaining('render') }),
        }),
      })
    )
  })

  it('degrades (does not fail) when sandbox UI external egress hits a transient DNS error', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.anthropic.com', port: 443 }],
          },
        },
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'error',
        error:
          'DNS resolution for "api.anthropic.com" failed (ESERVFAIL) — resolver or upstream unavailable',
        retryable: true,
      }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    // Non-terminal: the periodic reconcile must retry once DNS recovers, so the
    // recipe self-heals instead of bricking at the terminal `failed` phase.
    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(result.message).toContain('ESERVFAIL')
  })

  it('degrades a workflow recipe (without running it) on a transient UI egress DNS error', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.anthropic.com', port: 443 }],
          },
        },
        steps: [{ id: 'render', run: snippetRun() }],
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'error',
        error:
          'DNS resolution for "api.anthropic.com" failed (ETIMEOUT) — resolver or upstream unavailable',
        retryable: true,
      }),
    })
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconcilerWithLookup as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('R.8.24 — no ui-egress NetworkPolicy is created when spec.ui is unset', async () => {
    mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
      metadata: {
        name: 'ui-egress-test-recipe',
        namespace: 'sandbox-ui',
        uid: 'uid-ui-egress-test-recipe',
        resourceVersion: '7',
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'test-recipe',
        },
      },
      spec: { podSelector: {}, policyTypes: ['Egress'], egress: [] },
    })
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:1', port: 8080 }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    // Convergence path: an owned stale policy from a prior reconcile is removed
    // with live identity preconditions.
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ui-egress-test-recipe', namespace: 'sandbox-ui' })
    )
  })

  it('R.8.25 — ui-egress NetworkPolicy is deleted on WorkflowRecipe cleanup', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ui-egress-test-recipe', namespace: 'sandbox-ui' })
    )
  })

  it('deletes workflow transport workloads from mcp-server on WorkflowRecipe finalizer cleanup', async () => {
    const workflowInfraCleanup = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: { reconcileDelete: typeof workflowInfraCleanup }
      }
    ).workflowReconciler = { reconcileDelete: workflowInfraCleanup }

    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'research', instruction: 'run', mcpServers: ['web-search'] }],
        mcpServers: [{ id: 'web-search', endpoint: 'http://web-search.mcp-server.svc/mcp' }],
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'web-search:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: { 'web-search': 'test-recipe-web-search-12345678' },
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(workflowInfraCleanup).toHaveBeenCalledWith(
      'test-recipe',
      'sandbox-recipes',
      recipe.spec,
      recipe.metadata.uid
    )
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'test-recipe-web-search-12345678',
      namespace: 'mcp-server',
    })
    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'test-recipe-web-search-12345678',
      namespace: 'mcp-server',
    })
  })

  it('fences SDK authority before deleting a hybrid workflow recipe', async () => {
    const order: string[] = []
    const cleanupPluginWorkloadSdk = vi.fn(async () => {
      order.push('sdk-revoke-and-cleanup')
    })
    const workflowInfraCleanup = vi.fn(async () => {
      order.push('workflow-cleanup')
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
          reconcileDelete: typeof workflowInfraCleanup
        }
      }
    ).workflowReconciler = { cleanupPluginWorkloadSdk, reconcileDelete: workflowInfraCleanup }

    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['api'] },
      },
      status: {
        phase: 'active',
        pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(order).toEqual(['sdk-revoke-and-cleanup', 'workflow-cleanup'])
    expect(workflowInfraCleanup).toHaveBeenCalledWith(
      'test-recipe',
      'sandbox-recipes',
      recipe.spec,
      recipe.metadata.uid
    )
  })

  it('forwards custom coordinator workflow fields to the workflow reconciler', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const inputContract = {
      type: 'object',
      properties: {
        requestId: { type: 'string', default: 'e2e-custom' },
        approvalThreshold: { type: 'number', default: 1000 },
      },
    }
    const recipe = makeRecipe({
      spec: {
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        inputContract,
        output: { destination: 'pvc', format: 'json', storageSize: '128Mi' },
        steps: [
          { id: 'prepare' },
          { id: 'transform', dependsOn: ['prepare'] },
          { id: 'emit', dependsOn: ['transform'] },
        ],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.reconcile(recipe)

    const forwardedSpec = workflowReconcile.mock.calls[0][3]
    expect(forwardedSpec).toMatchObject({
      coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
      inputContract,
      output: { destination: 'pvc', format: 'json', storageSize: '128Mi' },
    })
    expect(forwardedSpec.steps).toEqual([
      { id: 'prepare' },
      { id: 'transform', dependsOn: ['prepare'] },
      { id: 'emit', dependsOn: ['transform'] },
    ])
    expect(workflowReconcile.mock.calls[0][5]).toEqual({
      requestId: 'e2e-custom',
      approvalThreshold: 1000,
    })
  })

  it('forwards the exact GFS read/write intent to the workflow reconciler', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const gfs: WorkflowRecipeGfsIntentSpec = {
      mounts: [
        {
          drive: 'main',
          target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          scopes: ['gfs.read', 'gfs.write'],
        },
      ],
    }
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'read-write', run: snippetRun() }],
        gfs,
      },
    })

    await reconciler.reconcile(recipe)

    expect(workflowReconcile.mock.calls[0][3].gfs).toEqual(gfs)
  })

  it('does not synthesize GFS intent when the recipe omits it', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'no-gfs', run: snippetRun() }],
      },
    })

    await reconciler.reconcile(recipe)

    expect(workflowReconcile.mock.calls[0][3].gfs).toBeUndefined()
  })

  it('delegates workflow transport workloads without contextRef and waits for ExternalEgressReady', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'clerum/web-search:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
            egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
          },
        ],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    const mcpServerCall =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      )
    expect(mcpServerCall).toBeDefined()
    const mcpSpec = mcpServerCall![0].body.spec as Record<string, unknown>
    expect(mcpSpec).not.toHaveProperty('contextRef')
    expect(mcpSpec.egressBindings).toEqual([{ dns: 'duckduckgo.com', port: 443 }])
    const contextCall =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      )
    expect(contextCall).toBeDefined()
    expect((contextCall![0].body.spec as Record<string, unknown>).contextId).toBe('wf-test-recipe')
    expect(contextCall![0].body.spec.mcpServers).toContain(mcpServerCall![0].body.metadata.name)
    expect(workflowReconcile).toHaveBeenCalled()
  })

  it('fails external-egress workflows in required mode when cluster enforcement is not confirmed', async () => {
    const unconfirmedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      networkPolicyEnforcementMode: 'required',
      networkPolicyEnforcementConfirmed: false,
    })
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      unconfirmedReconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await unconfirmedReconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('forwards transport endpoints using the delegated Service name for StatefulSet transport workloads', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const workload = {
      id: 'web-search-transport-with-a-name-long-enough-to-clamp-statefulset',
      type: 'statefulset' as const,
      image: 'clerum/web-search:test',
      port: 3000,
      transport: { type: 'streamableHttp' as const, path: '/custom-mcp' },
    }
    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'search', mcpServers: [workload.id] }],
        workloads: [workload],
      },
      status: { phase: 'candidate' },
    })
    await reconciler.reconcile(recipe)

    const transportServiceCall = mockCoreApi.createNamespacedService.mock.calls.find(([arg]) => {
      const body = arg.body as { metadata?: { namespace?: string }; spec?: { clusterIP?: string } }
      return body.metadata?.namespace === 'mcp-server' && body.spec?.clusterIP !== 'None'
    })
    expect(transportServiceCall).toBeDefined()
    const serviceName = transportServiceCall![0].body.metadata.name
    const runtimeName = resolveWorkloadRuntimeResourceName(recipe, workload)
    expect(serviceName).toBe(runtimeName)

    const forwardedSpec = workflowReconcile.mock.calls[0][3] as {
      mcpServers?: Array<{ id: string; endpoint: string }>
    }
    expect(forwardedSpec.mcpServers).toContainEqual({
      id: workload.id,
      endpoint: `http://${serviceName}.mcp-server.svc.cluster.local:3000/custom-mcp`,
    })
  })

  // Regression: the WRC controller is level-triggered and watches ONLY the
  // WorkflowRecipe CR, not the Pods it creates. While the inner workflow
  // reconciler is waiting on the output-prepare pod it returns a non-terminal
  // `phase: 'deploying'` result. Without a timer-driven requeue, the
  // output-prepare → mcp-host transition (a Pod change, not a CR change) never
  // re-triggers reconcile: the run wedges at phase=deploying forever and
  // dbRunProcessor keeps logging "orphaned running run reclaimed". The mapped
  // watcher result for a `deploying` workflow phase MUST carry a non-undefined
  // requeueAfterMs so the controller re-reconciles on its own and advances once
  // the output-prepare pod succeeds.
  it('requeues a deploying workflow reconcile waiting on the output-prepare pod', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message:
        'Created workflow output prepare pod "test-recipe-output-prepare"; waiting before starting runtime pods',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(workflowReconcile).toHaveBeenCalled()
    expect(result.phase).toBe('deploying')
    // The fix: a non-terminal `deploying` result must schedule a requeue.
    expect(result.requeueAfterMs).toBeDefined()
    expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
  })

  // Counterpart: a steady-state (`active`) workflow result must NOT requeue —
  // otherwise the fix above would turn into an unconditional hot loop.
  it('does not requeue a steady-state active workflow reconcile', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow running',
      workflowPhase: 'running',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(result.requeueAfterMs).toBeUndefined()
    // active is steady-state ⇒ no fixed-interval requeue either.
    expect(result.requeueFixedInterval).toBeFalsy()
  })

  // §5: a `deploying` PROGRESS requeue must be a FIXED interval (no exponential
  // backoff) — requeueFixedInterval signals the watcher to skip backoff and reset
  // attempts, else the poll cadence degrades toward the 60s cap and slows every
  // deploying sub-phase of the run.
  it('marks a deploying workflow requeue as fixed-interval (no transient backoff)', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Waiting for workflow output prepare pod to complete',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
    // The fix: progress requeues are FIXED-interval, NOT exponential-backoff.
    expect(result.requeueFixedInterval).toBe(true)
  })

  // Terminal `failed` results must not requeue at all — neither timer nor flag.
  it('does not requeue a failed workflow reconcile', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'failed',
      message: 'readiness deadline exceeded',
      workflowPhase: 'failed',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.requeueAfterMs).toBeUndefined()
    expect(result.requeueFixedInterval).toBeFalsy()
  })

  // A pass that reaches WorkflowReconciler.reconcile() (here the first deploy)
  // and leaves a run-lane policy pending a retry requeues on the progress
  // interval, with backoff: nothing bounds how long a deletion or a contention
  // lasts. The passes of a running workflow stop at the short-circuits; those
  // reapply the policies from the published marker (tests below).
  it('requeues on the backoff path when a pass through reconcile() leaves a run-lane policy pending a retry', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow running',
      workflowPhase: 'running',
      networkPolicyRetryPending: true,
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(workflowReconcile).toHaveBeenCalledTimes(1)
    expect(result.phase).toBe('active')
    expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
    expect(result.requeueFixedInterval).toBe(false)
  })

  // An ownership conflict waits for an operator, so it publishes its condition
  // and does not requeue.
  it('does not requeue a run-lane ownership conflict but still publishes it', async () => {
    const conflict = {
      type: 'WorkflowNetworkPolicyOwnership',
      status: 'False' as const,
      reason: 'OwnershipConflict',
      message:
        'NetworkPolicy ownership conflict: test-recipe-coord-to-wrc (owner-reference-mismatch)',
      lastTransitionTime: '2026-09-23T10:00:00.000Z',
    }
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow running',
      workflowPhase: 'running',
      networkPolicyOwnershipConditions: [conflict],
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(workflowReconcile).toHaveBeenCalledTimes(1)
    expect(result.networkPolicyOwnershipConditions).toEqual([conflict])
    expect(result.requeueAfterMs).toBeUndefined()
  })

  // The in-progress and active short-circuits return before reconcile(), so
  // they reapply the run-lane policies themselves while the retry marker is
  // published, and publish only status.conditions: a full status patch would
  // recompute the SDK projection without a bootstrap proof.
  describe('run-lane NetworkPolicy retry from the short-circuits', () => {
    const retryMarker = {
      type: 'WorkflowNetworkPoliciesConverged',
      status: 'False' as const,
      reason: 'RetryPending',
      message:
        'One or more run-lane NetworkPolicies are pending a retry (terminating or contended)',
      lastTransitionTime: '2026-09-24T08:00:00.000Z',
    }
    const unrelatedCondition = {
      type: 'WorkflowOutputPrepareGate',
      status: 'True' as const,
      reason: 'Ready',
      message: 'ready',
      lastTransitionTime: '2026-09-24T07:00:00.000Z',
    }

    function installRunLane(retryRunLaneNetworkPolicies: ReturnType<typeof vi.fn>) {
      const stub = {
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        refreshRuntimeHttpEgressNetworkPolicies: vi
          .fn()
          .mockResolvedValue({ conflicts: [], retryPending: false }),
        retryRunLaneNetworkPolicies,
        // A terminal run's teardown that cannot free its pods is retried (#1349).
        teardownComputePodsForTerminalRun: vi.fn().mockResolvedValue(undefined),
        validateWorkflowSpec: () => undefined,
      }
      ;(reconciler as unknown as { workflowReconciler: typeof stub }).workflowReconciler = stub
      return stub
    }

    function runningRecipe(overrides: {
      phase?: 'active' | 'deploying'
      execPhase?: 'running' | 'completed'
      conditions?: StatusCondition[]
      runId?: string | null
      dryRun?: boolean
      deletionTimestamp?: string
    }): WorkflowRecipeCRD {
      const runId = overrides.runId === undefined ? 'run-42' : overrides.runId
      return makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          ...(runId ? { labels: { 'clerum.io/workflow-run-id': runId } } : {}),
          ...(overrides.deletionTimestamp
            ? { deletionTimestamp: overrides.deletionTimestamp }
            : {}),
        },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'run' }],
          ...(overrides.dryRun ? { dryRun: true } : {}),
        },
        status: {
          phase: overrides.phase ?? 'active',
          message: 'Workflow running',
          workflowExecution: { phase: overrides.execPhase ?? 'running' },
          conditions: overrides.conditions ?? [unrelatedCondition, retryMarker],
        } as WorkflowRecipeCRD['status'],
      })
    }

    // The terminal teardown record (#1349) is its own status patch; it is not a
    // conditions patch, so it is left out here.
    function conditionPatches() {
      return mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls
        .map(call => call[0] as { name: string; body: { status: Record<string, unknown> } })
        .filter(patch => Object.keys(patch.body.status ?? {}).join() !== 'terminalRunTeardown')
    }

    it('reapplies from the active short-circuit and removes the marker with a conditions-only patch once converged', async () => {
      const retry = vi.fn().mockResolvedValue({ conflicts: [], retryPending: false })
      installRunLane(retry)
      const recipe = runningRecipe({})

      const result = await reconciler.reconcile(recipe)

      expect(retry).toHaveBeenCalledTimes(1)
      expect(retry.mock.calls[0][0]).toBe('test-recipe')
      expect(retry.mock.calls[0][1]).toBe('uid-123')
      expect(retry.mock.calls[0][4]).toBe('run-42')
      const patches = conditionPatches()
      expect(patches).toHaveLength(1)
      expect(patches[0].name).toBe('test-recipe')
      expect(Object.keys(patches[0].body.status)).toEqual(['conditions'])
      expect(patches[0].body.status.conditions).toEqual([unrelatedCondition])
      expect(recipe.status?.conditions).toEqual([unrelatedCondition])
      expect(result).toMatchObject({ phase: 'active', skipStatusPatch: true })
      expect(result.requeueAfterMs).toBeUndefined()
    })

    it('reapplies from the in-progress short-circuit and requeues on backoff while still pending', async () => {
      const retry = vi.fn().mockResolvedValue({ conflicts: [], retryPending: true })
      installRunLane(retry)
      const recipe = runningRecipe({ phase: 'deploying' })

      const result = await reconciler.reconcile(recipe)

      expect(retry).toHaveBeenCalledTimes(1)
      // The marker is unchanged, so no patch opens.
      expect(conditionPatches()).toHaveLength(0)
      expect(result.phase).toBe('active')
      expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
      expect(result.requeueFixedInterval).toBe(false)
    })

    it('publishes a changed condition once across two pending passes', async () => {
      const summary = {
        conflicts: [{ policy: 'test-recipe-coord-to-wrc', reason: 'owner-reference-mismatch' }],
        retryPending: true,
      }
      const retry = vi.fn().mockResolvedValue(summary)
      installRunLane(retry)
      const recipe = runningRecipe({})

      await reconciler.reconcile(recipe)
      const second = await reconciler.reconcile(recipe)

      expect(retry).toHaveBeenCalledTimes(2)
      const patches = conditionPatches()
      expect(patches).toHaveLength(1)
      expect(Object.keys(patches[0].body.status)).toEqual(['conditions'])
      const published = patches[0].body.status.conditions as Array<{
        type: string
        reason?: string
        lastTransitionTime?: string
      }>
      expect(published.map(c => c.type).sort()).toEqual([
        'WorkflowNetworkPoliciesConverged',
        'WorkflowNetworkPolicyOwnership',
        'WorkflowOutputPrepareGate',
      ])
      // The marker keeps the time the retry began.
      expect(
        published.find(c => c.type === 'WorkflowNetworkPoliciesConverged')?.lastTransitionTime
      ).toBe(retryMarker.lastTransitionTime)
      expect(second.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
    })

    it('does not reapply without the marker', async () => {
      const retry = vi.fn()
      const stub = installRunLane(retry)
      const recipe = runningRecipe({ conditions: [unrelatedCondition] })

      const result = await reconciler.reconcile(recipe)

      // Witness: the active short-circuit ran.
      expect(stub.ensureMcpHostRuntimeCredentials).toHaveBeenCalledTimes(1)
      expect(retry).not.toHaveBeenCalled()
      expect(conditionPatches()).toHaveLength(0)
      expect(result.requeueAfterMs).toBeUndefined()
    })

    it('keeps the marker and requeues on backoff when the reapply throws', async () => {
      const errorLog = captureLogger('error')
      try {
        const retry = vi.fn().mockRejectedValue(new Error('connect ECONNRESET'))
        installRunLane(retry)
        const recipe = runningRecipe({})

        const result = await reconciler.reconcile(recipe)

        expect(retry).toHaveBeenCalledTimes(1)
        expect(errorLog).toHaveBeenCalledWith(
          'Failed to reapply run-lane NetworkPolicies pending a retry; keeping the marker',
          expect.objectContaining({ name: 'test-recipe' })
        )
        expect(conditionPatches()).toHaveLength(0)
        expect(recipe.status?.conditions).toEqual([unrelatedCondition, retryMarker])
        expect(result.phase).toBe('active')
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(result.requeueFixedInterval).toBe(false)
      } finally {
        errorLog.mockRestore()
      }
    })

    it.each([
      ['the coordinator GFS policy cannot open', { dryRun: true }],
      ['the run awaits a trigger', { phase: 'deploying' as const, runId: null }],
    ])('does not reapply when %s', async (_label, overrides) => {
      const retry = vi.fn()
      const stub = installRunLane(retry)
      const recipe = runningRecipe(overrides)

      await reconciler.reconcile(recipe)

      // Witness: a short-circuit ran.
      expect(stub.ensureMcpHostRuntimeCredentials).toHaveBeenCalledTimes(1)
      expect(retry).not.toHaveBeenCalled()
      expect(conditionPatches()).toHaveLength(0)
    })

    // A deleting recipe stops at the initial check, before any short-circuit.
    it('does not reapply for a recipe being deleted', async () => {
      const retry = vi.fn()
      installRunLane(retry)
      const recipe = runningRecipe({ deletionTimestamp: '2026-09-24T09:00:00Z' })

      const result = await reconciler.reconcile(recipe)

      // Witness: the pass stopped at the initial check.
      expect(result.message).toBe('Recipe deleted during reconcile; skipped initial check')
      expect(retry).not.toHaveBeenCalled()
      expect(conditionPatches()).toHaveLength(0)
    })

    // A finished run no longer needs its policies, so the terminal branch drops
    // the marker without reapplying, and keeps an ownership conflict.
    it('removes the marker from the terminal branch without reapplying', async () => {
      const ownershipConflict = {
        type: 'WorkflowNetworkPolicyOwnership',
        status: 'False' as const,
        reason: 'OwnershipConflict',
        message:
          'NetworkPolicy ownership conflict: test-recipe-coord-to-wrc (owner-reference-mismatch)',
        lastTransitionTime: '2026-09-24T08:00:00.000Z',
      }
      const retry = vi.fn()
      const stub = installRunLane(retry)
      const recipe = runningRecipe({
        execPhase: 'completed',
        conditions: [unrelatedCondition, ownershipConflict, retryMarker],
      })

      const result = await reconciler.reconcile(recipe)

      // Witness: the terminal branch ran.
      expect(stub.ensureMcpHostRuntimeCredentials).toHaveBeenCalledTimes(1)
      expect(retry).not.toHaveBeenCalled()
      const patches = conditionPatches()
      expect(patches).toHaveLength(1)
      expect(Object.keys(patches[0].body.status)).toEqual(['conditions'])
      expect(patches[0].body.status.conditions).toEqual([unrelatedCondition, ownershipConflict])
      expect(recipe.status?.conditions).toEqual([unrelatedCondition, ownershipConflict])
      expect(result.phase).toBe('active')
      expect(result.requeueAfterMs).toBeUndefined()
    })

    // A marker naming both facts: the retry still owes an apply, and a
    // reconcile() prune still owes a DELETE. Built by the production builder,
    // so the fixture cannot drift from what a pass publishes.
    const retryAndPruneMarker = buildNetworkPolicyConvergedCondition(
      { apply: 'pending', prune: 'pending' },
      retryMarker.lastTransitionTime
    )!

    it('R4-L5: the marker naming both facts carries its own reason', () => {
      expect(retryAndPruneMarker.reason).toBe('RetryAndPrunePending')
    })

    it('reapplies from the active short-circuit for a marker that names both facts, and keeps the prune fact', async () => {
      const retry = vi.fn().mockResolvedValue({ conflicts: [], retryPending: false })
      installRunLane(retry)
      const recipe = runningRecipe({ conditions: [unrelatedCondition, retryAndPruneMarker] })

      const result = await reconciler.reconcile(recipe)

      expect(retry).toHaveBeenCalledTimes(1)
      const patches = conditionPatches()
      expect(patches).toHaveLength(1)
      expect(patches[0].body.status.conditions).toEqual([
        unrelatedCondition,
        expect.objectContaining({
          type: 'WorkflowNetworkPoliciesConverged',
          status: 'False',
          reason: 'PrunePending',
          lastTransitionTime: retryMarker.lastTransitionTime,
        }),
      ])
      expect(result.requeueAfterMs).toBeUndefined()
    })

    it('rewrites a marker that names both facts to PrunePending from the terminal branch', async () => {
      const retry = vi.fn()
      const stub = installRunLane(retry)
      const recipe = runningRecipe({
        execPhase: 'completed',
        conditions: [unrelatedCondition, retryAndPruneMarker],
      })

      await reconciler.reconcile(recipe)

      // Witness: the terminal branch ran.
      expect(stub.ensureMcpHostRuntimeCredentials).toHaveBeenCalledTimes(1)
      expect(retry).not.toHaveBeenCalled()
      const patches = conditionPatches()
      expect(patches).toHaveLength(1)
      expect(Object.keys(patches[0].body.status)).toEqual(['conditions'])
      expect(patches[0].body.status.conditions).toEqual([
        unrelatedCondition,
        expect.objectContaining({
          type: 'WorkflowNetworkPoliciesConverged',
          status: 'False',
          reason: 'PrunePending',
          lastTransitionTime: retryMarker.lastTransitionTime,
        }),
      ])
    })

    it('opens no patch from the terminal branch without the marker', async () => {
      const retry = vi.fn()
      const stub = installRunLane(retry)
      const recipe = runningRecipe({ execPhase: 'completed', conditions: [unrelatedCondition] })

      await reconciler.reconcile(recipe)

      // Witness: the terminal branch ran.
      expect(stub.ensureMcpHostRuntimeCredentials).toHaveBeenCalledTimes(1)
      expect(retry).not.toHaveBeenCalled()
      expect(conditionPatches()).toHaveLength(0)
    })
  })

  // §5 priority: a transient ERROR (skipStatusPatch) wins over PROGRESS even when
  // the phase is `deploying`. The error path keeps the TRANSIENT base + backoff
  // (requeueFixedInterval false), so genuine flakiness still backs off; it must
  // NOT be downgraded to the fixed progress interval.
  it('keeps the transient (backoff) requeue path when skipStatusPatch is set, even at phase deploying', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Transient infra blip; retry',
      workflowPhase: 'initializing',
      skipStatusPatch: true,
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.skipStatusPatch).toBe(true)
    expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    // Transient error ⇒ exponential backoff path, NOT the fixed progress path.
    expect(result.requeueFixedInterval).toBe(false)
  })

  // The fixed interval exists for `deploying`, where the controller polls for a
  // Pod it cannot watch.
  // Plugin Workload SDK policy-pending waits for an operator grant instead, which
  // polling cannot advance, so it must requeue on the backoff path.
  it('requeues a workflow awaiting Plugin Workload SDK policy without a fixed interval', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow running',
      workflowPhase: 'running',
      pluginWorkloadSdkPolicyPending: true,
    })
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
      }
    ).config.pluginWorkloadSdkEnabled = true
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['research'] },
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    // Liveness witness: the workflow lane ran and carried policy-pending into a
    // result whose projection publishes PluginWorkloadSdkPolicyPending=True.
    expect(workflowReconcile).toHaveBeenCalledTimes(1)
    expect(result.pluginWorkloadSdkPolicyPending).toBe(true)
    expect(reconciler.projectPluginWorkloadSdk(recipe, result).conditions).toContainEqual(
      expect.objectContaining({
        type: PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
        status: 'True',
      })
    )
    expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
    expect(result.requeueFixedInterval).toBe(false)
  })

  it('degrades (retryable) workflow transport workloads when child McpServer pre-deploy fails', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockCustomApi.replaceNamespacedCustomObject.mockRejectedValueOnce(new Error('api down'))

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('Pre-deploy failed for workflow "test-recipe"')
    expect(result.message).toContain('child McpServers')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('degrades a workflow whose pre-deploy Context vanishes after a create conflict', async () => {
    // Same vanish as R.6.4b, on the workflow deploy path (#998 review).
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockCustomApi.createNamespacedCustomObject.mockImplementation(
      ({ plural }: { plural?: string }) =>
        plural === 'contexts' ? Promise.reject({ code: 409 }) : Promise.resolve({})
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('Pre-deploy failed for workflow "test-recipe"')
    expect(result.message).toContain('Pre-deploy Context allowlist failed')
    expect(result.message).toContain('disappeared after create conflict')
    // Witness: the writer read, created, then re-read the Context.
    const contextReads = mockCustomApi.getNamespacedCustomObject.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
    )
    expect(contextReads).toHaveLength(2)
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('degrades (retryable) workflow transport workloads when final delegation fails', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockCustomApi.replaceNamespacedCustomObject
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('delegation write failed'))

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('MCP delegation failed for workflow "test-recipe"')
    expect(result.message).toContain('persisted child McpServers')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('fails workflow transport workloads with egressBindings when ExternalEgressReady is false', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(
      ({ plural, name }: { plural?: string; name?: string }) => {
        if (plural === 'mcpservers') {
          return Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/recipe': 'test-recipe' },
            },
            status: {
              conditions: [
                {
                  type: 'ExternalEgressReady',
                  status: 'False',
                  message: 'DNS resolution failed for duckduckgo.com',
                },
              ],
            },
          })
        }
        return Promise.resolve({
          metadata: {
            uid: liveWorkflowRecipeUid(name),
            resourceVersion: '1',
            labels: { 'clerum.io/recipe': 'test-recipe' },
          },
          spec: { mcpServers: [] },
        })
      }
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('External egress policy readiness not achieved')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('resolves agentic workload env, command, and args using assigned Service names', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        triggers: { onDemand: { allowedActors: ['user'] } },
        inputContract: {
          properties: {
            db_name: { type: 'string', default: 'clerum' },
          },
        },
        computed: [{ name: 'db_mode', expression: "'readonly'" }],
        workloads: [
          { id: 'postgres', type: 'statefulset', image: 'postgres:16', port: 5432 },
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            env: [
              {
                name: 'DATABASE_URL',
                value: 'postgres://{{postgres:host}}:{{postgres:port}}/{{inputs.db_name}}',
              },
              { name: 'DB_MODE', value: '{{computed.db_mode}}' },
            ],
            command: ['node'],
            args: ['server.js', '--db-host={{postgres:host}}'],
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    const postgresRuntimeName = resolveWorkloadRuntimeResourceName(
      recipe,
      recipe.spec.workloads![0]
    )
    const expectedHost = `${postgresRuntimeName}.sandbox-recipes.svc.cluster.local`
    const deployment = mockAppsApi.createNamespacedDeployment.mock.calls.find(
      ([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'qa-api'
    )?.[0].body
    const container = deployment.spec.template.spec.containers[0]
    expect(container.env).toEqual(
      expect.arrayContaining([
        {
          name: 'DATABASE_URL',
          value: `postgres://${expectedHost}:5432/clerum`,
        },
        { name: 'DB_MODE', value: 'readonly' },
      ])
    )
    expect(container.command).toEqual(['node'])
    expect(container.args).toEqual(['server.js', `--db-host=${expectedHost}`])
    expect(JSON.stringify(deployment)).not.toContain('{{')
    expect(workflowReconcile.mock.calls[0][5]).toMatchObject({
      db_name: 'clerum',
      db_mode: 'readonly',
    })
  })

  it('DENIES and tears down a workload that declares the reserved platform pull secret (Issue #637)', async () => {
    // The orchestrator-level counterpart to the builder tests in platformPullSecret.test.ts.
    // The platform credential is injected, never declared: control-api labels it
    // `managed-by=control-api` only, which is *unlabeled* to the #637 ownership model. So a
    // recipe that names it in imagePullSecrets does NOT get "the declared copy stripped and
    // ours injected" — the whole WORKLOAD is denied here, in the reconciler, and torn down
    // instead of rendered. This is the authoritative gate; the builders only normalize.
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === EVENFIRE_REGISTRY_PULL_SECRET_NAME
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              // Exactly what registryPullSecretService writes — provenance only, no
              // owner-recipe/shared label (labelling it `shared` would open the envSecret
              // exfiltration path, so it must stay denied).
              labels: { 'clerum.io/managed-by': 'control-api' },
            },
            type: 'kubernetes.io/dockerconfigjson',
            data: { '.dockerconfigjson': 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'app',
            type: 'deployment',
            image: 'registry.evenfire.ai/acme/plugin:1.0',
            port: 8080,
            imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME],
          },
        ],
      },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(cond?.message).toContain(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
    expect(r.workloadStatuses[0]).toMatchObject({ id: 'app', phase: 'failed', ready: false })

    // Not rendered — and any prior instance torn down (revocation, not a silent strip).
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
  })

  it('surfaces EnvSecretOwnershipDenied from the WORKFLOW build path (Issue #637)', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    // qa-api's envSecret is owned by ANOTHER recipe → denied. Previously the
    // workflow build path computed the EnvSecretOwnershipDenied condition and
    // dropped it (returned only internalDependencyConditions); now it must reach
    // the reconcile result (and thus patchStatus).
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(cond?.message).toMatch(/not owned by recipe/)
    // The denied workload was never rendered with the foreign credential.
    const qaDeploy = mockAppsApi.createNamespacedDeployment.mock.calls.find(
      ([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'qa-api'
    )
    expect(qaDeploy).toBeUndefined()
  })

  it('fail-closed: degrades + does NOT run the workflow when a denied WORKFLOW workload teardown FAILS (Issue #637, no silent swallow)', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    // qa-creds is owned by ANOTHER recipe → qa-api is denied and must be torn down.
    // Force the teardown to FAIL: previously this was swallowed (.catch(() => undefined))
    // and the workflow proceeded; now it must degrade + requeue (fail-closed).
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    const teardownSpy = vi
      .spyOn(
        reconciler as unknown as { teardownDeniedWorkload: () => Promise<void> },
        'teardownDeniedWorkload'
      )
      .mockRejectedValue(new Error('apiserver 500 during teardown'))

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const r = await reconciler.reconcile(recipe)

    // Fail-closed: the failed teardown degrades the recipe (was a silent swallow that
    // let the workflow run with a possibly-live foreign-credentialed pod). The periodic
    // ownership backstop (workflowNeedsOwnershipBackstop) retries the revocation.
    expect(r.phase).toBe('degraded')
    expect(r.message).toMatch(/teardown of denied workflow workload .* failed/)
    expect(r.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    // The workflow infrastructure reconcile must NOT have run — we degraded first.
    expect(workflowReconcile).not.toHaveBeenCalled()

    teardownSpy.mockRestore()
  })

  it('CRITICAL: a denied WORKFLOW Deployment whose underlying delete fails non-404 degrades (caller 2 real-delete path, Issue #637)', async () => {
    // Caller 2 (deploy-workflow teardown) analog of the deploy-non-workflow CRITICAL test:
    // mock the REAL deleteNamespacedDeployment to fail non-404, NOT spy teardownDeniedWorkload
    // (a spy masks whether the real delete propagates through deleteWorkload→deleteOrThrow→
    // RetryableReconcileError — the exact masking that hid the original safeDelete fail-open).
    // Pre-fix the swallow let the workflow proceed with a live foreign pod; now it degrades.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    // The REAL Deployment delete (the revocation teardown) fails non-404.
    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
      code: 500,
      body: { message: 'apiserver 500' },
    })

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const r = await reconciler.reconcile(recipe)

    // The real delete failure propagated through deleteOrThrow → RetryableReconcileError →
    // degrade; the workflow did NOT proceed with a live foreign-credentialed pod. Reverting
    // throwOnError makes this red (safeDelete swallows → workflow proceeds, phase 'deploying').
    expect(r.phase).toBe('degraded')
    expect(r.message).toMatch(/teardown of denied workflow workload .* failed/)
    expect(r.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    expect(workflowReconcile).not.toHaveBeenCalled()

    // Restore the shared delete mock (the suite clears calls, not mock implementations).
    mockAppsApi.deleteNamespacedDeployment.mockResolvedValue({})
  })

  it('revokes an ACTIVE/running workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // Regression for the active-phase revocation hole: a running workflow's reconcile
    // short-circuits BEFORE the Step 8 ownership gate (to protect the coordinator
    // 409-window). The SecretWatcher fan-out routes through that same short-circuit,
    // so a mid-run re-label was never enforced. The active short-circuit must now run
    // targeted teardown + surface the EnvSecretOwnershipDenied condition WITHOUT
    // redeploying (coordinator untouched). Reverting the enforceActiveWorkflowSecret-
    // Ownership calls makes this test red.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    // qa-creds is now owned by ANOTHER recipe (mid-run revocation).
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // Triggered run → workflowRunId label set → awaitsTriggeredRun=false → the
      // reconcile hits the ACTIVE short-circuit (not the first-deploy path).
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    // 1) The denial is surfaced and written (previously the active short-circuit
    //    returned skipStatusPatch:true with NO condition → silent revocation miss).
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    // 2) The foreign-owned workload was TORN DOWN (the security action), not left running.
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    // 3) The coordinator was NOT re-driven and the workload was NOT redeployed
    //    (the 409-window protection the short-circuit exists for is preserved).
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('revokes an AWAITING-TRIGGER workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // The awaiting-trigger short-circuit (active + awaitsTriggeredRun + no execution)
    // also returns before the Step 8 gate, yet the envSecret workload was already
    // deployed. A mid-life re-label must still be enforced there.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        triggers: { onDemand: { allowedActors: ['user'] } },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // active, NO run-id label, NO workflowExecution → awaiting-trigger short-circuit.
      status: { phase: 'active' },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('revokes a TERMINAL (completed) workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // A terminal workflow that is not run-scoped keeps steady envSecret workloads;
    // a mid-life re-label must be enforced on the terminal short-circuit too. The
    // EnvSecretOwnershipDenied condition + a forced status patch are produced ONLY by
    // the enforcement (the normal terminal return carries neither).
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // run-id label → awaitsTriggeredRun=false; completed execution → wfTerminal.
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'completed' } },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('requeues (NO false "revoked") when a steady workflow Secret ownership cannot be verified — transient read error (Issue #637 fail-closed)', async () => {
    // Fail-closed parity with the deploy path: an `error`-state classification must
    // requeue, NOT silently skip (which would leave a foreign Secret projected with a
    // healthy status). Reverting the `secretOwnership.errored` requeue branch makes
    // this red.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    // qa-creds read FAILS with a non-404 → classifySecretAccess => 'error' => partition errored.
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.reject({ code: 500, body: { message: 'apiserver boom' } })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    // Fail-closed: requeue, and DO NOT claim the credential was revoked.
    expect(r.requeueAfterMs).toBeGreaterThan(0)
    expect(r.skipStatusPatch).toBe(true)
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).not.toBe('True')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('requeues (NO false "revoked") when StatefulSet revocation teardown FAILS (Issue #637 fail-closed)', async () => {
    // If teardown throws (e.g. RBAC 403 / apiserver 5xx on the Pod deletecollection),
    // the foreign credential is still live — the code must NOT report
    // EnvSecretOwnershipDenied=True (a status lie); it must requeue and retry. Reverting
    // the try/catch+requeue (back to `.catch(() => undefined)` + hadDenied:true) makes
    // this red. Also asserts the data-safety guard holds on failure.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    // qa-creds is foreign → denied → teardown attempted.
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    // The StatefulSet Pod deletecollection (the revocation teardown) FAILS with a non-404.
    mockCoreApi.deleteCollectionNamespacedPod.mockRejectedValue({
      code: 500,
      body: { message: 'teardown boom' },
    })

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA workload.' }],
      },
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    // Issue #1349 — the StatefulSet is live (rendered while qa-creds was accessible);
    // revocation tears down only a live StatefulSet, never creates one.
    await mockAppsApi.createNamespacedStatefulSet({
      namespace: 'sandbox-recipes',
      body: buildStatefulSet(
        recipe.spec.workloads![0] as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map([['qa-creds', { state: 'accessible', keys: new Set(['token']) }]])
      ).statefulSet,
    })

    const r = await reconciler.reconcile(recipe)

    // Witness: the revocation teardown reached the Pod delete that failed.
    expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalled()
    // The credential is still live (delete failed) → requeue, NOT a false "revoked".
    expect(r.requeueAfterMs).toBeGreaterThan(0)
    expect(r.skipStatusPatch).toBe(true)
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).not.toBe('True')
    // Data-safety preserved even on failure: the StatefulSet object is never deleted.
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
  })

  it('requeues (NO false "revoked") when a steady DEPLOYMENT revocation teardown delete FAILS non-404 (Issue #637 fail-closed, steady enforcer 3997)', async () => {
    // Mirror of the deploy-path CRITICAL test, but on the STEADY enforcer path: a denied
    // Deployment's REAL delete fails non-404. Before the safeDelete fix the steady enforcer
    // swallowed it and returned hadDenied:true → EnvSecretOwnershipDenied=True (a false
    // "revoked" over a still-live foreign pod). Now deleteOrThrow propagates and the enforcer
    // requeues. Reverting throwOnError on the Deployment teardown makes this red — closing the
    // gap that the StatefulSet-only steady tests above left (they use deleteCollectionNamespacedPod,
    // which already threw pre-fix; the Deployment path went through the swallowing safeDelete).
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    // The Deployment delete (the revocation teardown) FAILS with a non-404.
    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
      code: 500,
      body: { message: 'teardown boom' },
    })

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA workload.' }],
      },
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    // The credential is still live (delete failed) → requeue, NOT a false "revoked".
    expect(r.requeueAfterMs).toBeGreaterThan(0)
    expect(r.skipStatusPatch).toBe(true)
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).not.toBe('True')

    // Restore the shared delete mock: the suite clears call history but not mock
    // implementations, so this failure injection would otherwise leak into the next
    // test (which relies on deleteNamespacedDeployment succeeding).
    mockAppsApi.deleteNamespacedDeployment.mockResolvedValue({})
  })

  it('revokes an IN-PROGRESS (deploying+running) workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // The in-progress short-circuit (phase 'deploying'/'failed' + a running execution
    // that is NOT initializing/recovering) is a DISTINCT branch from the active
    // short-circuit and must enforce revocation too. Reverting the
    // revokeOrRequeueSteadyWorkflow call on the in-progress branch makes this red.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // phase 'deploying' + execution 'running' (not initializing/recovering) → the
      // in-progress short-circuit (NOT the active branch, NOT the full deploy path).
      status: { phase: 'deploying', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    // The coordinator was NOT re-driven (in-progress short-circuit, not the deploy path).
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('fails workflow reconciliation before workload deploy when a template is unresolved', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          workloads: [
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'qa-api:test',
              args: ['--db-host={{postgres:host}}'],
            },
          ],
          steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('spec.workloads[0].args[0]')
    expect(result.message).toContain('postgres:host')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('fails classic reconciliation with the same actionable template error format', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'qa-api:test',
              args: ['--db-host={{postgres:host}}'],
            },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toBe(
      'spec.workloads[0].args[0]: Unresolved template reference: "postgres:host"'
    )
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
  })

  it('repairs workflow mcpHost runtime credentials before skipping completed active workflows', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          teardownComputePodsForTerminalRun: typeof teardownComputePodsForTerminalRun
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = {
      ensureMcpHostRuntimeCredentials,
      teardownComputePodsForTerminalRun,
      validateWorkflowSpec: () => undefined,
    }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: { phase: 'completed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: true,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'parent-recipe',
      'uid-child'
    )
    expect(mockVerifyWorkflowRunProvenance).toHaveBeenCalledWith({
      runId: 'run-child',
      parentNamespace: 'sandbox-recipes',
      parentName: 'parent-recipe',
      childNamespace: 'sandbox-recipes',
      childName: 'child-run',
    })
    // Terminal run-scoped workflow → compute pods are freed.
    expect(teardownComputePodsForTerminalRun).toHaveBeenCalledWith('child-run')
  })

  describe('Secret revocation recorded once per denied Secret version (issue #1349)', () => {
    type InnerStub = {
      ensureMcpHostRuntimeCredentials: ReturnType<typeof vi.fn>
      ensureCoordinatorRuntimeCredentials: ReturnType<typeof vi.fn>
      teardownComputePodsForTerminalRun: ReturnType<typeof vi.fn>
      reconcile: ReturnType<typeof vi.fn>
      validateWorkflowSpec: () => undefined
    }

    afterEach(() => {
      mockCustomApi.patchNamespacedCustomObjectStatus
        .mockReset()
        .mockImplementation(echoPatchedStatus)
      mockAppsApi.deleteNamespacedDeployment.mockReset().mockResolvedValue({})
    })

    function stubInner(
      result: Record<string, unknown> = {
        phase: 'active',
        message: 'Workflow running',
        workflowPhase: 'running',
      }
    ): InnerStub {
      const stub: InnerStub = {
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        ensureCoordinatorRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        teardownComputePodsForTerminalRun: vi.fn().mockResolvedValue(undefined),
        reconcile: vi.fn().mockResolvedValue(result),
        validateWorkflowSpec: () => undefined,
      }
      ;(reconciler as unknown as { workflowReconciler: InnerStub }).workflowReconciler = stub
      return stub
    }

    /** Every named Secret is foreign (denied) at the given resourceVersion; others 404. */
    function denySecrets(versions: Record<string, string>): void {
      mockCoreApi.readNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => {
        const resourceVersion = versions[name]
        if (resourceVersion === undefined) throw { code: 404 }
        return {
          metadata: { resourceVersion, labels: { 'clerum.io/owner-recipe': 'some-other-recipe' } },
          data: { token: 'eA==' },
        }
      })
    }

    function deniedDeployment(id: string, secretName: string): WorkloadDef {
      return {
        id,
        type: 'deployment',
        image: `${id}:test`,
        port: 8080,
        envSecret: { name: secretName, keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
      } as WorkloadDef
    }

    function runChild(
      workloads: WorkloadDef[],
      status: Record<string, unknown> | undefined
    ): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          labels: { 'clerum.io/workflow-run-id': 'run-123' },
        },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads,
          steps: [{ id: 'run-qa', instruction: 'Validate the QA workload.' }],
        },
        ...(status ? { status: status as unknown as WorkflowRecipeCRD['status'] } : {}),
      })
    }

    /** Deletes of the Deployment of one workload (`<recipe>-<id>-<hash>`). */
    function deploymentDeletes(workloadId: string): number {
      return mockAppsApi.deleteNamespacedDeployment.mock.calls.filter(([arg]) =>
        String(arg.name).includes(`-${workloadId}-`)
      ).length
    }

    function revocationPatches(): Array<Record<string, string>> {
      return mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls
        .map(([arg]) => arg.body?.status?.secretOwnershipRevocations)
        .filter((entry): entry is Record<string, string> => entry !== undefined)
    }

    function deniedCondition(result: { secretOwnershipConditions?: StatusCondition[] }) {
      return (result.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )?.status
    }

    it('T2.2 the active short-circuit revokes a denied workload once per denied Secret version', async () => {
      const inner = stubInner()
      denySecrets({ 'qa-creds': '7' })
      const store = installRecipeStore(
        runChild([deniedDeployment('qa-api', 'qa-creds')], {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        })
      )

      const first = await reconciler.reconcile(store.current())

      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(deniedCondition(first)).toBe('True')
      expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toMatch(
        /^sha256:[0-9a-f]{64}$/
      )
      const secretReads = mockCoreApi.readNamespacedSecret.mock.calls.length
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()

      const second = await reconciler.reconcile(store.current())

      // Witness: pass 2 classified the Secret again.
      expect(mockCoreApi.readNamespacedSecret.mock.calls.length).toBeGreaterThan(secretReads)
      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(revocationPatches()).toHaveLength(0)
      expect(second.phase).toBe(first.phase)
      expect(second.message).toBe(first.message)
      expect(deniedCondition(second)).toBe('True')
      expect(second.requeueAfterMs).toBeUndefined()
      expect(inner.reconcile).not.toHaveBeenCalled()
    })

    it('T2.3 the first deploy of a run child revokes a denied workload once and still renders the others', async () => {
      const inner = stubInner()
      denySecrets({ 'qa-creds': '7' })
      const okWorkload = { id: 'ok-api', type: 'deployment', image: 'ok:test' } as WorkloadDef
      const store = installRecipeStore(
        runChild([deniedDeployment('qa-api', 'qa-creds'), okWorkload], { phase: 'candidate' })
      )
      const okRenders = () =>
        [
          ...mockAppsApi.createNamespacedDeployment.mock.calls,
          ...mockAppsApi.replaceNamespacedDeployment.mock.calls,
        ].filter(([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'ok-api').length

      await reconciler.reconcile(store.current())

      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(okRenders()).toBe(1)
      expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toMatch(/^sha256:/)
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()

      await reconciler.reconcile(store.current())

      // Witness: pass 2 went through the deploy path and the inner reconcile again.
      expect(inner.reconcile).toHaveBeenCalledTimes(2)
      expect(okRenders()).toBeGreaterThanOrEqual(1)
      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(revocationPatches()).toHaveLength(0)
    })

    it('T2.4 the non-workflow revocation round revokes a denied workload once per denied Secret version', async () => {
      denySecrets({ 'qa-creds': '7' })
      const store = installRecipeStore(
        makeRecipe({ spec: { workloads: [deniedDeployment('qa-api', 'qa-creds')] } })
      )

      const first = await reconciler.reconcile(store.current())

      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(first.phase).toBe('degraded')
      expect(deniedCondition(first)).toBe('True')
      expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toMatch(/^sha256:/)
      const secretReads = mockCoreApi.readNamespacedSecret.mock.calls.length
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()

      const second = await reconciler.reconcile(store.current())

      expect(mockCoreApi.readNamespacedSecret.mock.calls.length).toBeGreaterThan(secretReads)
      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(revocationPatches()).toHaveLength(0)
      expect(second.phase).toBe('degraded')
      expect(deniedCondition(second)).toBe('True')
      expect(second.requeueAfterMs).toBeUndefined()
    })

    // Row (c) — a deploy pass revokes every denied workload before it delegates or
    // renders anything, and a failed revocation does not stop the others. Each
    // pass is driven as the watcher drives it.
    describe('row (c): a failed revocation does not stop the other denied workloads', () => {
      type RecipeStore = ReturnType<typeof installRecipeStore>

      const DEPLOYING = {
        phase: 'deploying',
        message: 'Workflow infrastructure created',
        workflowPhase: 'initializing',
      }

      /** Secret name -> owner label and resourceVersion; other Secrets 404. */
      function secrets(entries: Record<string, { owner: string; rv: string }>): void {
        mockCoreApi.readNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => {
          const entry = entries[name]
          if (entry === undefined) throw { code: 404 }
          return {
            metadata: {
              resourceVersion: entry.rv,
              labels: { 'clerum.io/owner-recipe': entry.owner },
            },
            data: { token: 'eA==' },
          }
        })
      }
      const owned = (...names: string[]) =>
        Object.fromEntries(names.map(name => [name, { owner: 'test-recipe', rv: '5' }]))
      const denied = (...names: string[]) =>
        Object.fromEntries(names.map(name => [name, { owner: 'some-other-recipe', rv: '6' }]))

      const db = (overrides: Record<string, unknown> = {}): WorkloadDef =>
        ({
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          port: 5432,
          envSecret: { name: 'db-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          ...overrides,
        }) as WorkloadDef
      const after = (workload: WorkloadDef, dependsOn: string[]): WorkloadDef =>
        ({ ...workload, dependsOn }) as WorkloadDef

      /** Deployment creates and replaces of one workload. */
      const deploymentWrites = (workloadId: string) =>
        [
          ...mockAppsApi.createNamespacedDeployment.mock.calls,
          ...mockAppsApi.replaceNamespacedDeployment.mock.calls,
        ].filter(([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === workloadId)
          .length
      const statefulSetReadsOf = (name: string) =>
        mockAppsApi.readNamespacedStatefulSet.mock.calls.filter(([arg]) => arg.name === name).length
      const secretReads = () => mockCoreApi.readNamespacedSecret.mock.calls.length
      const storedCondition = (store: RecipeStore, type: string) =>
        store.current().status?.conditions?.find(c => c.type === type)
      const revocations = (store: RecipeStore) =>
        store.current().status?.secretOwnershipRevocations ?? {}

      /** One watcher pass: reconcile the stored recipe, then publish its result. */
      async function pass(store: RecipeStore, recipe: WorkflowRecipeCRD = store.current()) {
        const result = await reconciler.reconcile(recipe)
        const patched = await publishAsWatcher(recipe, result)
        return { result, patched }
      }

      /**
       * Passes 1 and 2 with every Secret owned: `db` and `qa-api` (after `db`) are
       * created with their credentials, and between the passes the stored `db`
       * StatefulSet is given another `serviceName`, an immutable drift. The
       * spec-hash gate skips `db` on pass 2, so the drift is not noticed yet.
       */
      async function setUpLiveRun(qaSecret: Record<string, { owner: string; rv: string }>) {
        const inner = stubInner(DEPLOYING)
        secrets({ ...owned('db-creds'), ...qaSecret })
        const store = installRecipeStore(
          runChild([db(), after(deniedDeployment('qa-api', 'qa-creds'), ['db'])], {
            phase: 'candidate',
          })
        )

        const first = await pass(store)
        expect(first.result.phase).toBe('deploying')
        expect(inner.reconcile).toHaveBeenCalledTimes(1)
        const dbBody = mockAppsApi.createNamespacedStatefulSet.mock.calls
          .map(([arg]) => arg.body)
          .find(body => body?.metadata?.labels?.['clerum.io/workload'] === 'db')
        const qaBody = mockAppsApi.createNamespacedDeployment.mock.calls
          .map(([arg]) => arg.body)
          .find(body => body?.metadata?.labels?.['clerum.io/workload'] === 'qa-api')
        expect(JSON.stringify(dbBody.spec.template)).toContain('db-creds')
        expect(JSON.stringify(qaBody.spec.template)).toContain('qa-creds')
        const dbName = dbBody.metadata.name as string
        const namespace = 'sandbox-recipes'
        const readDb = async () =>
          (await mockAppsApi.readNamespacedStatefulSet({
            name: dbName,
            namespace,
          })) as k8s.V1StatefulSet
        const setServiceName = async (serviceName: string) => {
          const live = await readDb()
          live.spec!.serviceName = serviceName
          await mockAppsApi.replaceNamespacedStatefulSet({ name: dbName, namespace, body: live })
        }
        const serviceName = (await readDb()).spec!.serviceName!
        await setServiceName('renamed-by-hand')

        const second = await pass(store)
        expect(second.result.phase).toBe('deploying')
        expect(inner.reconcile).toHaveBeenCalledTimes(2)

        mockAppsApi.patchNamespacedStatefulSet.mockClear()
        mockAppsApi.deleteNamespacedDeployment.mockClear()
        mockCoreApi.deleteCollectionNamespacedPod.mockClear()
        return {
          inner,
          store,
          dbName,
          readDb,
          restoreServiceName: () => setServiceName(serviceName),
        }
      }

      it('T-ROWC-1: a denied StatefulSet with immutable drift does not keep a later denied Deployment live', async () => {
        const { inner, store, dbName, readDb, restoreServiceName } = await setUpLiveRun(
          owned('qa-creds')
        )
        const qaWritesAtDenial = deploymentWrites('qa-api')
        secrets(denied('db-creds', 'qa-creds'))

        // Pass 3: qa-api is torn down although db's revocation fails first.
        const dbReadsBefore3 = statefulSetReadsOf(dbName)
        const secretReadsBefore3 = secretReads()
        const third = await pass(store)

        expect(secretReads()).toBeGreaterThan(secretReadsBefore3)
        expect(statefulSetReadsOf(dbName)).toBeGreaterThan(dbReadsBefore3)
        expect(deploymentDeletes('qa-api')).toBe(1)
        expect(revocations(store)['qa-api']).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(revocations(store)).not.toHaveProperty('db')
        expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
        expect(mockCoreApi.deleteCollectionNamespacedPod).not.toHaveBeenCalled()
        expect(JSON.stringify((await readDb()).spec!.template)).toContain('db-creds')
        expect(third.result.phase).toBe('degraded')
        expect(third.result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(third.result.message).toMatch(
          /^Issue #637: teardown of denied workflow workload "db" failed; requeueing to retry revocation: ImmutableStatefulSetDrift: /
        )
        expect(third.result.message).not.toContain('"qa-api"')
        expect(third.patched).toBe(true)
        const deniedAfter3 = storedCondition(store, 'EnvSecretOwnershipDenied')
        expect(deniedAfter3?.status).toBe('True')
        expect(deniedAfter3?.message).toContain('workload "db"')
        expect(deniedAfter3?.message).toContain('workload "qa-api"')
        const driftAfter3 = storedCondition(store, 'StatefulSetImmutableDrift')
        expect(driftAfter3?.status).toBe('True')
        expect(driftAfter3?.message).toContain('spec.serviceName')
        expect(inner.reconcile).toHaveBeenCalledTimes(2)

        // Pass 4: the same failure; nothing is torn down or recorded again.
        mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
        const dbReadsBefore4 = statefulSetReadsOf(dbName)
        const secretReadsBefore4 = secretReads()
        const fourth = await pass(store)

        expect(secretReads()).toBeGreaterThan(secretReadsBefore4)
        expect(statefulSetReadsOf(dbName)).toBeGreaterThan(dbReadsBefore4)
        expect(deniedCondition(fourth.result)).toBe('True')
        expect(fourth.result.workloadConditions?.map(c => c.type)).toEqual([
          'StatefulSetImmutableDrift',
        ])
        expect(fourth.patched).toBe(false)
        expect(deploymentDeletes('qa-api')).toBe(1)
        expect(revocationPatches()).toHaveLength(0)

        // Pass 5: the drift is gone, so db is revoked and the run is rendered again.
        await restoreServiceName()
        const fifth = await pass(store)

        expect(inner.reconcile).toHaveBeenCalledTimes(3)
        expect(fifth.result.phase).toBe('deploying')
        expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(1)
        expect(revocations(store)['db']).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(deploymentWrites('qa-api')).toBe(qaWritesAtDenial)
        expect(storedCondition(store, 'StatefulSetImmutableDrift')).toBeUndefined()
        expect(storedCondition(store, 'EnvSecretOwnershipDenied')?.status).toBe('True')
      })

      it('T-ROWC-2: every denied workload is torn down although others fail, and each failure is named', async () => {
        const inner = stubInner(DEPLOYING)
        const ids = ['a-api', 'b-api', 'c-api']
        const creds = ids.map(id => `${id}-creds`)
        secrets(owned(...creds))
        const store = installRecipeStore(
          runChild(
            [
              deniedDeployment('a-api', 'a-api-creds'),
              after(deniedDeployment('b-api', 'b-api-creds'), ['a-api']),
              deniedDeployment('c-api', 'c-api-creds'),
            ],
            { phase: 'candidate' }
          )
        )
        await pass(store)
        expect(ids.map(deploymentWrites)).toEqual([1, 1, 1])
        expect(inner.reconcile).toHaveBeenCalledTimes(1)

        secrets(denied(...creds))
        mockAppsApi.deleteNamespacedDeployment.mockImplementation(
          async ({ name }: { name: string }) => {
            if (name.includes('-a-api-') || name.includes('-c-api-')) {
              throw Object.assign(new Error('apiserver 500'), { code: 500 })
            }
            return {}
          }
        )
        const secretReadsBefore = secretReads()
        const failing = await pass(store)

        expect(secretReads()).toBeGreaterThan(secretReadsBefore)
        expect(ids.map(deploymentDeletes)).toEqual([1, 1, 1])
        expect(Object.keys(revocations(store))).toEqual(['b-api'])
        expect(failing.result.phase).toBe('degraded')
        expect(failing.result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(failing.result.message).toBe(
          'Issue #637: teardown of denied workflow workload "a-api" failed; requeueing to retry revocation: apiserver 500' +
            ' | ' +
            'Issue #637: teardown of denied workflow workload "c-api" failed; requeueing to retry revocation: apiserver 500'
        )
        expect(failing.result.workloadConditions).toEqual([])
        expect(failing.patched).toBe(true)
        const deniedStored = storedCondition(store, 'EnvSecretOwnershipDenied')
        expect(deniedStored?.status).toBe('True')
        for (const id of ids) expect(deniedStored?.message).toContain(`workload "${id}"`)
        expect(inner.reconcile).toHaveBeenCalledTimes(1)

        // The deletes succeed again: only the two failed workloads are torn down.
        mockAppsApi.deleteNamespacedDeployment.mockImplementation(async () => ({}))
        const healed = await pass(store)

        expect(ids.map(deploymentDeletes)).toEqual([2, 1, 2])
        expect(Object.keys(revocations(store)).sort()).toEqual(ids)
        expect(inner.reconcile).toHaveBeenCalledTimes(2)
        expect(healed.result.phase).toBe('deploying')
        expect(ids.map(deploymentWrites)).toEqual([1, 1, 1])
      })

      it('T-ROWC-3: a denied workload is torn down before MCP pre-deploy fails', async () => {
        const inner = stubInner(DEPLOYING)
        denySecrets({ 'qa-creds': '7' })
        mockCustomApi.replaceNamespacedCustomObject.mockRejectedValueOnce(new Error('api down'))
        const recipe = runChild(
          [
            deniedDeployment('qa-api', 'qa-creds'),
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            } as WorkloadDef,
          ],
          { phase: 'candidate' }
        )
        recipe.spec.steps = [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }]
        const store = installRecipeStore(recipe)

        const { result } = await pass(store)

        // Witness: pre-deploy was attempted and failed.
        expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalled()
        expect(result.phase).toBe('degraded')
        expect(result.message).toContain('Pre-deploy failed for workflow "test-recipe"')
        expect(deploymentDeletes('qa-api')).toBe(1)
        expect(revocations(store)['qa-api']).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(inner.reconcile).not.toHaveBeenCalled()
      })

      it('T-ROWC-4: a StatefulSet that is not denied and fails to render does not keep a later denied Deployment live', async () => {
        const { inner, store, dbName } = await setUpLiveRun(owned('qa-creds'))
        secrets({ ...owned('db-creds'), ...denied('qa-creds') })
        // The spec changes, so the spec-hash gate does not skip db and its drift is seen.
        const edited = store.current()
        edited.spec.workloads = [
          db({ image: 'postgres:17' }),
          after(deniedDeployment('qa-api', 'qa-creds'), ['db']),
        ]
        const dbReadsBefore = statefulSetReadsOf(dbName)

        const { result } = await pass(store, edited)

        expect(statefulSetReadsOf(dbName)).toBeGreaterThan(dbReadsBefore)
        expect(deploymentDeletes('qa-api')).toBe(1)
        expect(revocations(store)['qa-api']).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(result.phase).toBe('failed')
        expect(result.workflowPhase).toBe('failed')
        expect(result.workloadConditions).toEqual([
          expect.objectContaining({
            type: 'StatefulSetImmutableDrift',
            status: 'True',
            message: expect.stringContaining('spec.serviceName'),
          }),
        ])
        expect(inner.reconcile).toHaveBeenCalledTimes(2)
      })

      // The non-workflow pass revokes the denied workloads right after the verdict
      // too, before MCP pre-deploy, the readiness wait and the stale check. A
      // failed revocation does not end that pass: it continues and requeues.
      describe('non-workflow pass', () => {
        const webSearch = {
          id: 'web-search',
          type: 'deployment',
          image: 'clerum/web-search:test',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
        } as WorkloadDef
        const transportRecipe = () =>
          makeRecipe({
            spec: {
              contextRef: 'default',
              workloads: [deniedDeployment('qa-api', 'qa-creds'), webSearch],
            },
          })
        const preDeployCalls = () => mockCustomApi.replaceNamespacedCustomObject.mock.calls.length
        const mcpServerWrites = () =>
          [
            ...mockCustomApi.createNamespacedCustomObject.mock.calls,
            ...mockCustomApi.replaceNamespacedCustomObject.mock.calls,
          ].filter(([arg]) => arg?.plural === 'mcpservers').length

        afterEach(() => {
          mockCustomApi.replaceNamespacedCustomObject.mockReset().mockResolvedValue({})
        })

        it('T-ROWC-NW-1: a denied workload is torn down although MCP pre-deploy fails on every pass', async () => {
          denySecrets({ 'qa-creds': '7' })
          mockCustomApi.replaceNamespacedCustomObject.mockRejectedValue(
            new Error('API unavailable')
          )
          const store = installRecipeStore(transportRecipe())

          // Pass 1: pre-deploy fails after the revocation.
          const first = await pass(store)

          expect(preDeployCalls()).toBeGreaterThan(0)
          expect(first.result.phase).toBe('degraded')
          expect(first.result.message).toContain(
            'Pre-deploy failed for WorkflowRecipe "test-recipe"'
          )
          expect(deploymentDeletes('qa-api')).toBe(1)
          expect(revocations(store)['qa-api']).toMatch(/^sha256:[0-9a-f]{64}$/)

          // Pass 2: pre-deploy fails again; nothing is torn down or recorded again.
          mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
          const preDeployBefore2 = preDeployCalls()
          const secretReadsBefore2 = secretReads()
          const second = await pass(store)

          expect(preDeployCalls()).toBeGreaterThan(preDeployBefore2)
          expect(secretReads()).toBeGreaterThan(secretReadsBefore2)
          expect(second.result.message).toContain(
            'Pre-deploy failed for WorkflowRecipe "test-recipe"'
          )
          expect(deploymentDeletes('qa-api')).toBe(1)
          expect(revocationPatches()).toHaveLength(0)

          // Pass 3: pre-deploy succeeds; the denied workload is skipped, the
          // transport workload is rendered.
          mockCustomApi.replaceNamespacedCustomObject.mockResolvedValue({})
          const preDeployBefore3 = preDeployCalls()
          const third = await pass(store)

          expect(preDeployCalls()).toBeGreaterThan(preDeployBefore3)
          expect(deploymentWrites('web-search')).toBeGreaterThan(0)
          expect(third.result.workloadStatuses).toContainEqual(
            expect.objectContaining({
              id: 'qa-api',
              phase: 'failed',
              message: expect.stringMatching(/^EnvSecretOwnershipDenied: /),
            })
          )
          expect(deniedCondition(third.result)).toBe('True')
          expect(deploymentDeletes('qa-api')).toBe(1)
          expect(deploymentWrites('qa-api')).toBe(0)
        })

        it('T-ROWC-NW-2: a denied workload is torn down although the readiness wait fails', async () => {
          denySecrets({ 'qa-creds': '7' })
          const readinessWait = vi
            .spyOn(
              reconciler as unknown as {
                waitForTransportNetworkReadiness: (...args: unknown[]) => Promise<void>
              },
              'waitForTransportNetworkReadiness'
            )
            .mockRejectedValue(new Error('network isolation was never confirmed'))
          const store = installRecipeStore(transportRecipe())

          const { result } = await pass(store)
          const readinessWaits = readinessWait.mock.calls.length
          readinessWait.mockRestore()

          // Witness: pre-deploy succeeded and the pass reached the wait.
          expect(readinessWaits).toBe(1)
          expect(deploymentDeletes('qa-api')).toBe(1)
          expect(revocations(store)['qa-api']).toMatch(/^sha256:[0-9a-f]{64}$/)
          expect(result.phase).toBe('failed')
          expect(store.current().status?.phase).toBe('failed')
        })

        it('T-ROWC-NW-3: a denied workload is torn down although the recipe is deleting at the stale check', async () => {
          denySecrets({ 'qa-creds': '7' })
          let recipeReads = 0
          let deletingReads = 0
          // The recipe is answered as deleting once the McpServers were
          // pre-deployed, so only the stale check after pre-deploy sees it; the
          // first check of the pass and the record-clear read get the live recipe.
          const store = installRecipeStore(transportRecipe(), {
            onGet: stored => {
              recipeReads += 1
              if (mcpServerWrites() === 0) return undefined
              deletingReads += 1
              return {
                ...stored,
                metadata: { ...stored.metadata, deletionTimestamp: '2026-11-17T00:00:00Z' },
              }
            },
          })

          const { result } = await pass(store)

          expect(recipeReads).toBeGreaterThanOrEqual(2)
          expect(deletingReads).toBe(1)
          expect(mcpServerWrites()).toBeGreaterThan(0)
          expect(result.message).toBe(
            'Recipe deleted during reconcile; skipped post-network materialization'
          )
          expect(result.skipStatusPatch).toBe(true)
          expect(deploymentDeletes('qa-api')).toBe(1)
          expect(revocations(store)['qa-api']).toMatch(/^sha256:[0-9a-f]{64}$/)
        })

        it('T-ROWC-NW-4: a failed revocation does not stop the others and the pass continues and requeues', async () => {
          denySecrets({ 'db-creds': '7', 'qa-creds': '7' })
          const okWorkload = { id: 'ok-api', type: 'deployment', image: 'ok:test' } as WorkloadDef
          const recipe = deniedStatefulSetRecipe('non-workflow deploy', [
            db(),
            deniedDeployment('qa-api', 'qa-creds'),
            okWorkload,
          ])
          const name = await storeCredentialedStatefulSet(recipe)
          const namespace = recipe.metadata.namespace
          const drifted = (await mockAppsApi.readNamespacedStatefulSet({
            name,
            namespace,
          })) as k8s.V1StatefulSet
          drifted.spec!.serviceName = 'renamed-by-hand'
          await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: drifted })
          const store = installRecipeStore(recipe)
          const dbReadsBefore = statefulSetReadsOf(name)
          const errorLog = captureLogger('error')

          const { result } = await pass(store)
          const errors = errorLog.mock.calls.map(([message, context]) => [
            message,
            (context as { err?: Error } | undefined)?.err?.name,
          ])
          errorLog.mockRestore()

          // Witness: db was read and its revocation was refused for the drift.
          expect(statefulSetReadsOf(name)).toBeGreaterThan(dbReadsBefore)
          expect(errors).toContainEqual([
            'Teardown of denied workload failed; will requeue',
            'ImmutableStatefulSetDriftError',
          ])
          expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
          expect(mockCoreApi.deleteCollectionNamespacedPod).not.toHaveBeenCalled()
          expect(deploymentDeletes('qa-api')).toBe(1)
          expect(revocations(store)['qa-api']).toMatch(/^sha256:[0-9a-f]{64}$/)
          expect(revocations(store)).not.toHaveProperty('db')
          expect(deploymentWrites('ok-api')).toBe(1)
          expect(result.workloadStatuses?.map(status => status.id).sort()).toEqual([
            'db',
            'ok-api',
            'qa-api',
          ])
          expect(result.phase).toBe('degraded')
          expect(deniedCondition(result)).toBe('True')
          expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        })
      })
    })

    // R1-M1 — a denied StatefulSet is kept, and after its revocation is recorded
    // it keeps following the spec through the spec-hash gate: no second Pod
    // delete, no record write. The three callers of the revocation round
    // (revokeDeniedWorkloads), which calls teardownDeniedWorkload.
    const DENIED_CALLERS = ['non-workflow deploy', 'workflow deploy', 'steady enforcer'] as const
    type DeniedCaller = (typeof DENIED_CALLERS)[number]

    const dbStatefulSet = (overrides: Record<string, unknown> = {}): WorkloadDef =>
      ({
        id: 'db',
        type: 'statefulset',
        image: 'postgres:16',
        port: 5432,
        envSecret: { name: 'db-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
        ...overrides,
      }) as WorkloadDef

    /** A recipe whose workloads reach teardownDeniedWorkload through `caller`. */
    function deniedStatefulSetRecipe(
      caller: DeniedCaller,
      workloads: WorkloadDef[]
    ): WorkflowRecipeCRD {
      // The instance name assigned when the StatefulSet was first deployed.
      const workloadInstances = { db: 'test-recipe-db-live' }
      if (caller === 'non-workflow deploy') {
        return makeRecipe({
          spec: { workloads },
          status: { workloadInstances } as unknown as WorkflowRecipeCRD['status'],
        })
      }
      return runChild(
        workloads,
        caller === 'workflow deploy'
          ? { phase: 'candidate', workloadInstances }
          : { phase: 'active', workflowExecution: { phase: 'running' }, workloadInstances }
      )
    }

    /** Stores `db` as it was rendered while db-creds was accessible; returns its name. */
    async function storeCredentialedStatefulSet(
      recipe: WorkflowRecipeCRD,
      namespace: string = recipe.metadata.namespace
    ): Promise<string> {
      const statefulSet = buildStatefulSet(
        recipe.spec.workloads!.find(w => w.id === 'db') as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map([['db-creds', { state: 'accessible', keys: new Set(['token']) }]])
      ).statefulSet
      expect(JSON.stringify(statefulSet.spec?.template)).toContain('db-creds')
      statefulSet.metadata!.namespace = namespace
      await mockAppsApi.createNamespacedStatefulSet({ namespace, body: statefulSet })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()
      mockCoreApi.deleteCollectionNamespacedPod.mockClear()
      return statefulSet.metadata!.name!
    }

    const statefulSetWrites = () => ({
      patches: mockAppsApi.patchNamespacedStatefulSet.mock.calls.length,
      creates: mockAppsApi.createNamespacedStatefulSet.mock.calls.length,
      podDeletes: mockCoreApi.deleteCollectionNamespacedPod.mock.calls.length,
    })
    const statefulSetReads = (name: string) =>
      mockAppsApi.readNamespacedStatefulSet.mock.calls.filter(([arg]) => arg.name === name).length
    const storedConditionOf = (store: { current: () => WorkflowRecipeCRD }, type: string) =>
      store.current().status?.conditions?.find(c => c.type === type)

    /**
     * R2-L1 — `name` is deleted right after its next read, as by an operator
     * between the revocation's read and its write. From then on the API server
     * answers a read or a JSON Patch of it with 404, and a create is accepted
     * (recorded; the object counts as present again).
     */
    function deleteStatefulSetAfterNextRead(name: string): void {
      const storeRead = mockAppsApi.readNamespacedStatefulSet.getMockImplementation()!
      const storePatch = mockAppsApi.patchNamespacedStatefulSet.getMockImplementation()!
      const storeCreate = mockAppsApi.createNamespacedStatefulSet.getMockImplementation()!
      let deleted = false
      let readSinceArmed = false
      mockAppsApi.readNamespacedStatefulSet.mockImplementation(async (arg: { name: string }) => {
        if (arg.name !== name) return storeRead(arg)
        if (deleted) throw { code: 404 }
        const answer = await storeRead(arg)
        if (!readSinceArmed) {
          readSinceArmed = true
          deleted = true
        }
        return answer
      })
      mockAppsApi.patchNamespacedStatefulSet.mockImplementation(async (arg: { name: string }) => {
        if (arg.name === name && deleted) throw { code: 404 }
        return storePatch(arg)
      })
      mockAppsApi.createNamespacedStatefulSet.mockImplementation(
        async (arg: { body: { metadata: { name: string } } }) => {
          if (arg.body.metadata.name !== name || !deleted) return storeCreate(arg)
          deleted = false
          return {}
        }
      )
    }

    /** The name of `db`'s headless Service, as buildStatefulSet renders it. */
    function headlessServiceNameOf(recipe: WorkflowRecipeCRD): string {
      return buildStatefulSet(
        recipe.spec.workloads!.find(w => w.id === 'db') as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map()
      ).headlessService.metadata!.name!
    }

    /**
     * Issue #1518 — the first revocation of `db` meets immutable drift: its stored
     * StatefulSet was given another `serviceName` outside WRC. Runs one pass as the
     * watcher does (reconcile, then publish). Witnesses: the pass read the
     * StatefulSet, and the teardown failure was logged with the drift error.
     */
    async function firstRevocationMeetsDrift(caller: DeniedCaller) {
      const inner = caller === 'non-workflow deploy' ? undefined : stubInner()
      denySecrets({ 'db-creds': '7' })
      const recipe = deniedStatefulSetRecipe(caller, [dbStatefulSet()])
      const name = await storeCredentialedStatefulSet(recipe)
      const namespace = recipe.metadata.namespace
      const readLive = async () =>
        (await mockAppsApi.readNamespacedStatefulSet({ name, namespace })) as k8s.V1StatefulSet
      const setServiceName = async (serviceName: string) => {
        const live = await readLive()
        live.spec!.serviceName = serviceName
        await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: live })
      }
      const serviceName = (await readLive()).spec!.serviceName!
      await setServiceName('renamed-by-hand')
      const store = installRecipeStore(recipe)
      const errorLog = captureLogger('error')
      const readsBefore = statefulSetReads(name)

      const before = store.current()
      const result = await reconciler.reconcile(before)
      const failureErrors = errorLog.mock.calls
        .map(([, context]) => (context as { err?: Error } | undefined)?.err?.name)
        .filter(errorName => errorName === 'ImmutableStatefulSetDriftError').length
      errorLog.mockRestore()
      const patched = await publishAsWatcher(before, result)

      expect(statefulSetReads(name)).toBeGreaterThan(readsBefore)
      expect(failureErrors).toBe(1)
      return {
        store,
        name,
        result,
        patched,
        innerCalls: () => inner?.reconcile.mock.calls.length ?? 0,
        restoreServiceName: () => setServiceName(serviceName),
      }
    }

    for (const caller of DENIED_CALLERS) {
      it(`T-R3-M1-1 (${caller}): a StatefulSet revoked for a denial takes a later spec edit through the hash gate, with no Pod delete and no record write`, async () => {
        const inner = caller === 'non-workflow deploy' ? undefined : stubInner()
        denySecrets({ 'db-creds': '7' })
        const recipe = deniedStatefulSetRecipe(caller, [dbStatefulSet()])
        const name = await storeCredentialedStatefulSet(recipe)
        const namespace = recipe.metadata.namespace
        const store = installRecipeStore(recipe)
        const stored = async () =>
          (await mockAppsApi.readNamespacedStatefulSet({ name, namespace })) as k8s.V1StatefulSet
        const edited = () => {
          const next = store.current()
          next.spec.workloads = [dbStatefulSet({ image: 'postgres:17' })]
          next.spec.security = { ...next.spec.security, isolationLevel: 'strict' } as never
          return next
        }

        // Pass 1 revokes: one credential-free patch, one Pod delete, one record.
        await reconciler.reconcile(store.current())
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
        const digest = store.current().status?.secretOwnershipRevocations?.['db']
        expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(JSON.stringify((await stored()).spec!.template)).not.toContain('db-creds')
        mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()

        // Pass 2, same spec. Witness: the pass read the revoked StatefulSet, once
        // (R2-L1: the update uses the object the revocation read).
        const readsBeforePass2 = statefulSetReads(name)
        await reconciler.reconcile(store.current())
        expect(statefulSetReads(name)).toBe(readsBeforePass2 + 1)
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })

        // Pass 3, image and isolation level edited: one more patch, still
        // credential-free, and the Pods are left to the StatefulSet controller.
        await reconciler.reconcile(edited())
        expect(statefulSetWrites()).toEqual({ patches: 2, creates: 0, podDeletes: 1 })
        const afterEdit = await stored()
        expect(afterEdit.spec!.template.spec!.containers[0].image).toBe('postgres:17')
        expect(afterEdit.spec!.template.spec!.securityContext).toEqual(
          expect.objectContaining({ runAsUser: 65534 })
        )
        expect(JSON.stringify(afterEdit.spec!.template)).not.toContain('db-creds')

        // Pass 4, the edited spec again: nothing is written. Witness: the pass
        // read the StatefulSet, once.
        const readsBeforePass4 = statefulSetReads(name)
        await reconciler.reconcile(edited())
        expect(statefulSetReads(name)).toBe(readsBeforePass4 + 1)
        expect(statefulSetWrites()).toEqual({ patches: 2, creates: 0, podDeletes: 1 })
        expect(revocationPatches()).toHaveLength(0)
        expect(store.current().status?.secretOwnershipRevocations?.['db']).toBe(digest)
        if (caller === 'steady enforcer') expect(inner!.reconcile).not.toHaveBeenCalled()

        // Pass 5, the StatefulSet is gone: a revoked workload is not created.
        const storeRead = mockAppsApi.readNamespacedStatefulSet.getMockImplementation()!
        mockAppsApi.readNamespacedStatefulSet.mockImplementation(async (arg: { name: string }) => {
          if (arg.name === name) throw { code: 404 }
          return storeRead(arg)
        })
        const readsBeforePass5 = statefulSetReads(name)
        await reconciler.reconcile(edited())
        expect(statefulSetReads(name)).toBeGreaterThan(readsBeforePass5)
        expect(statefulSetWrites()).toEqual({ patches: 2, creates: 0, podDeletes: 1 })
      })

      it(`T-L1-1 (${caller}): a StatefulSet deleted after the first revocation read it is not created again, and its revocation is recorded on the next pass`, async () => {
        if (caller !== 'non-workflow deploy') stubInner()
        denySecrets({ 'db-creds': '7' })
        const recipe = deniedStatefulSetRecipe(caller, [dbStatefulSet()])
        const name = await storeCredentialedStatefulSet(recipe)
        const store = installRecipeStore(recipe)
        deleteStatefulSetAfterNextRead(name)
        const errorLog = captureLogger('error')
        const readsBefore = statefulSetReads(name)

        const result = await reconciler.reconcile(store.current())
        const errors = errorLog.mock.calls.map(([message, context]) => [
          message,
          (context as { err?: { code?: number } } | undefined)?.err?.code,
        ])
        errorLog.mockRestore()

        // Witness: the revocation sent its patch to the deleted object and the
        // caller logged the 404 as a failed teardown.
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 0 })
        expect(errors).toContainEqual([
          caller === 'non-workflow deploy'
            ? 'Teardown of denied workload failed; will requeue'
            : 'Denied workload teardown failed; requeueing',
          404,
        ])
        expect(statefulSetReads(name)).toBe(readsBefore + 1)
        if (caller === 'workflow deploy') {
          expect(result.phase).toBe('degraded')
          expect(result.message).toMatch(
            /^Issue #637: teardown of denied workflow workload "db" failed; requeueing to retry revocation: /
          )
        }
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(store.current().status?.secretOwnershipRevocations ?? {}).not.toHaveProperty('db')

        // Pass 2 reads the StatefulSet as absent and records the revocation.
        const readsBeforePass2 = statefulSetReads(name)
        await reconciler.reconcile(store.current())
        expect(statefulSetReads(name)).toBe(readsBeforePass2 + 1)
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 0 })
        expect(store.current().status?.secretOwnershipRevocations?.['db']).toMatch(
          /^sha256:[0-9a-f]{64}$/
        )
      })

      it(`T-L1-2 (${caller}): a revoked StatefulSet deleted after the read is not created again when its spec hash is unchanged`, async () => {
        if (caller !== 'non-workflow deploy') stubInner()
        denySecrets({ 'db-creds': '7' })
        const recipe = deniedStatefulSetRecipe(caller, [dbStatefulSet()])
        const name = await storeCredentialedStatefulSet(recipe)
        const namespace = recipe.metadata.namespace
        const headlessName = headlessServiceNameOf(recipe)
        const store = installRecipeStore(recipe)

        // Pass 1 revokes and records the current digest.
        const pass1Recipe = store.current()
        const pass1 = await reconciler.reconcile(pass1Recipe)
        if (caller !== 'workflow deploy') await publishAsWatcher(pass1Recipe, pass1)
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
        const digest = store.current().status?.secretOwnershipRevocations?.['db']
        expect(digest).toMatch(/^sha256:/)

        deleteStatefulSetAfterNextRead(name)
        const infoLog = captureLogger('info')
        const readsBefore = statefulSetReads(name)
        const headlessReadsBefore = readsOf(
          mockCoreApi.readNamespacedService,
          headlessName,
          namespace
        )

        const result = await reconciler.reconcile(store.current())
        const hashSkips = infoLog.mock.calls.filter(
          ([message, context]) =>
            message === 'StatefulSet spec hash unchanged; skipping update' &&
            (context as { name?: string } | undefined)?.name === name
        ).length
        infoLog.mockRestore()

        // Witness: the update was prepared (headless Service read) and the hash
        // gate decided on the object the revocation read.
        expect(readsOf(mockCoreApi.readNamespacedService, headlessName, namespace)).toBe(
          headlessReadsBefore + 1
        )
        expect(hashSkips).toBe(1)
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
        expect(statefulSetReads(name)).toBe(readsBefore + 1)
        expect(result.requeueAfterMs).toBeUndefined()
        expect(store.current().status?.secretOwnershipRevocations?.['db']).toBe(digest)
      })

      it(`T-L1-3 (${caller}): a steady revoked StatefulSet is read once per pass`, async () => {
        if (caller !== 'non-workflow deploy') stubInner()
        denySecrets({ 'db-creds': '7' })
        const recipe = deniedStatefulSetRecipe(caller, [dbStatefulSet()])
        const name = await storeCredentialedStatefulSet(recipe)
        const store = installRecipeStore(recipe)

        const pass1Recipe = store.current()
        const pass1 = await reconciler.reconcile(pass1Recipe)
        if (caller !== 'workflow deploy') await publishAsWatcher(pass1Recipe, pass1)
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })

        for (const pass of [2, 3]) {
          const readsBefore = statefulSetReads(name)
          await reconciler.reconcile(store.current())
          expect(statefulSetReads(name), `pass ${pass}`).toBe(readsBefore + 1)
        }
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
      })

      it(`T-1518-2 / T-R3-M1-2 (${caller}): a failed update of a revoked StatefulSet is retried, neither deletes its Pods nor writes a record, and publishes the drift`, async () => {
        const inner = caller === 'non-workflow deploy' ? undefined : stubInner()
        denySecrets({ 'db-creds': '7' })
        // ok-api is ordered after db.
        const okWorkload = {
          id: 'ok-api',
          type: 'deployment',
          image: 'ok:test',
          dependsOn: ['db'],
        } as WorkloadDef
        const recipe = deniedStatefulSetRecipe(caller, [dbStatefulSet(), okWorkload])
        const name = await storeCredentialedStatefulSet(recipe)
        const namespace = recipe.metadata.namespace
        const store = installRecipeStore(recipe)
        const stored = async () =>
          (await mockAppsApi.readNamespacedStatefulSet({ name, namespace })) as k8s.V1StatefulSet

        // Pass 1 revokes. The workflow deploy pass is not published, so the stored
        // phase stays `candidate` and pass 2 enters the deploy path again.
        const pass1Recipe = store.current()
        const pass1 = await reconciler.reconcile(pass1Recipe)
        if (caller !== 'workflow deploy') await publishAsWatcher(pass1Recipe, pass1)
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
        const digest = store.current().status?.secretOwnershipRevocations?.['db']
        expect(digest).toMatch(/^sha256:/)
        const innerCallsAfterRevoke = inner?.reconcile.mock.calls.length ?? 0
        mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()

        // The stored StatefulSet drifts on an immutable field, and the spec changes.
        const drifted = await stored()
        drifted.spec!.serviceName = 'renamed-by-hand'
        await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: drifted })
        const edited = store.current()
        edited.spec.workloads = [dbStatefulSet({ image: 'postgres:17' }), okWorkload]
        const errorLog = captureLogger('error')

        const result = await reconciler.reconcile(edited)
        const errors = errorLog.mock.calls.map(([message, context]) => [
          message,
          (context as { err?: Error } | undefined)?.err?.name,
        ])
        errorLog.mockRestore()

        // Witness: the update was attempted and refused for the immutable drift.
        if (caller === 'non-workflow deploy') {
          expect(errors).toContainEqual([
            'Update of a revoked StatefulSet failed; will requeue',
            'ImmutableStatefulSetDriftError',
          ])
          expect(result.phase).toBe('degraded')
          expect(deniedCondition(result)).toBe('True')
        } else if (caller === 'workflow deploy') {
          expect(result.message).toMatch(
            /^Issue #1349: update of revoked workflow StatefulSet "db" failed; requeueing: ImmutableStatefulSetDrift: /
          )
          expect(result.phase).toBe('degraded')
          // The deploy pass stops at the StatefulSet, as it does for a StatefulSet
          // that is not denied: the inner reconcile is not reached.
          expect(inner!.reconcile.mock.calls.length).toBe(innerCallsAfterRevoke)
        } else {
          expect(errors).toContainEqual([
            'Update of a revoked StatefulSet failed; requeueing',
            'ImmutableStatefulSetDriftError',
          ])
          expect(result.message).toBe(
            'EnvSecretOwnershipDenied: update of revoked StatefulSet failed for db ' +
              '(StatefulSet immutable drift: db) — requeuing'
          )
          expect(result.skipStatusPatch).toBeUndefined()
        }
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
        expect((await stored()).spec!.template.spec!.containers[0].image).toBe('postgres:16')
        expect(revocationPatches()).toHaveLength(0)
        expect(store.current().status?.secretOwnershipRevocations?.['db']).toBe(digest)

        // Issue #1518 — the pass is published with the denial and the drift.
        expect(await publishAsWatcher(edited, result)).toBe(true)
        const drift = storedConditionOf(store, 'StatefulSetImmutableDrift')
        expect(drift?.status).toBe('True')
        expect(drift?.message).toContain('spec.serviceName')
        expect(storedConditionOf(store, 'EnvSecretOwnershipDenied')?.status).toBe('True')
      })

      it(`T-1518-1 (${caller}): a first revocation that meets immutable drift publishes the drift and the denial once`, async () => {
        vi.useFakeTimers()
        onTestFinished(() => {
          vi.useRealTimers()
        })
        vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'))
        const run = await firstRevocationMeetsDrift(caller)

        expect(run.patched).toBe(true)
        const drift = storedConditionOf(run.store, 'StatefulSetImmutableDrift')
        expect(drift?.status).toBe('True')
        expect(drift?.message).toContain('spec.serviceName')
        expect(drift?.message).toContain('The stored spec hash is not the desired one')
        expect(storedConditionOf(run.store, 'EnvSecretOwnershipDenied')?.status).toBe('True')
        expect(run.result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(statefulSetWrites()).toEqual({ patches: 0, creates: 0, podDeletes: 0 })
        expect(run.store.current().status?.secretOwnershipRevocations?.['db']).toBeUndefined()
        expect(revocationPatches()).toHaveLength(0)
        if (caller === 'workflow deploy') {
          expect(run.result.message).toMatch(
            /^Issue #637: teardown of denied workflow workload "db" failed; requeueing to retry revocation: ImmutableStatefulSetDrift: /
          )
          expect(run.innerCalls()).toBe(0)
        } else if (caller === 'steady enforcer') {
          expect(run.result.message).toBe(
            'EnvSecretOwnershipDenied: teardown failed for db (StatefulSet immutable drift: db) — requeuing'
          )
          expect(run.result.skipStatusPatch).toBeUndefined()
        } else {
          expect(run.result.phase).toBe('degraded')
        }

        // A second pass over the same drift does not patch the status. Witness:
        // the pass read the StatefulSet again and still carries the condition, with
        // a later lastTransitionTime.
        vi.setSystemTime(new Date('2026-11-17T10:01:00.000Z'))
        const readsBeforePass2 = statefulSetReads(run.name)
        const pass2Recipe = run.store.current()
        const pass2 = await reconciler.reconcile(pass2Recipe)
        expect(statefulSetReads(run.name)).toBeGreaterThan(readsBeforePass2)
        const pass2Drift = pass2.workloadConditions?.find(
          c => c.type === 'StatefulSetImmutableDrift'
        )
        expect(pass2Drift?.message).toBe(drift?.message)
        expect(pass2Drift?.lastTransitionTime).not.toBe(drift?.lastTransitionTime)
        expect(await publishAsWatcher(pass2Recipe, pass2)).toBe(false)
        expect(statefulSetWrites()).toEqual({ patches: 0, creates: 0, podDeletes: 0 })
      })

      it(`T-1518-8 (${caller}): once the drift is resolved the revocation is applied and the drift condition is cleared`, async () => {
        const run = await firstRevocationMeetsDrift(caller)
        // Witness: the drift condition was stored by the blocked pass.
        expect(storedConditionOf(run.store, 'StatefulSetImmutableDrift')?.status).toBe('True')
        const innerCallsBefore = run.innerCalls()

        await run.restoreServiceName()
        const recipe = run.store.current()
        const result = await reconciler.reconcile(recipe)

        expect(await publishAsWatcher(recipe, result)).toBe(true)
        expect(storedConditionOf(run.store, 'StatefulSetImmutableDrift')).toBeUndefined()
        expect(storedConditionOf(run.store, 'EnvSecretOwnershipDenied')?.status).toBe('True')
        expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
        expect(run.store.current().status?.secretOwnershipRevocations?.['db']).toMatch(
          /^sha256:[0-9a-f]{64}$/
        )
        if (caller === 'workflow deploy') {
          // The pass left the degraded state and reached the inner reconcile.
          expect(run.innerCalls()).toBeGreaterThan(innerCallsBefore)
        }
      })
    }

    it('T-1518-9: the status refresh drops both conditions and the forced reconcile writes them back (inherited, filed)', async () => {
      const run = await firstRevocationMeetsDrift('non-workflow deploy')
      // Witness: the blocked pass stored both conditions.
      expect(storedConditionOf(run.store, 'StatefulSetImmutableDrift')?.status).toBe('True')
      expect(storedConditionOf(run.store, 'EnvSecretOwnershipDenied')?.status).toBe('True')

      // The 30-second refresh as the watcher runs it (refreshWorkloadStatusOnly).
      const refreshed = run.store.current()
      const observed = await reconciler.observeCurrentWorkloadStatus(refreshed)
      expect(await publishAsWatcher(refreshed, observed)).toBe(true)
      expect(storedConditionOf(run.store, 'StatefulSetImmutableDrift')).toBeUndefined()
      expect(storedConditionOf(run.store, 'EnvSecretOwnershipDenied')).toBeUndefined()

      // The forced reconcile that follows writes both back.
      const forced = run.store.current()
      const result = await reconciler.reconcile(forced)
      expect(await publishAsWatcher(forced, result)).toBe(true)
      expect(storedConditionOf(run.store, 'StatefulSetImmutableDrift')?.status).toBe('True')
      expect(storedConditionOf(run.store, 'EnvSecretOwnershipDenied')?.status).toBe('True')
    })

    it('T-1518-7: the steady enforcer defers a failed teardown without immutable drift and publishes nothing', async () => {
      stubInner()
      denySecrets({ 'qa-creds': '7' })
      const store = installRecipeStore(
        runChild([deniedDeployment('qa-api', 'qa-creds')], {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        })
      )
      mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
        code: 500,
        message: 'apiserver boom',
      })
      const errorLog = captureLogger('error')

      const recipe = store.current()
      const result = await reconciler.reconcile(recipe)
      const failureLogs = errorLog.mock.calls.filter(
        ([message]) => message === 'Denied workload teardown failed; requeueing'
      ).length
      errorLog.mockRestore()

      // Witness: the teardown ran and failed.
      expect(deploymentDeletes('qa-api')).toBeGreaterThan(0)
      expect(failureLogs).toBe(1)
      expect(result.message).toBe(
        'EnvSecretOwnershipDenied recheck deferred: teardown failed for qa-api — requeuing'
      )
      expect(result.skipStatusPatch).toBe(true)
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(result.workloadConditions).toBeUndefined()
      expect(result.secretOwnershipConditions).toBeUndefined()
      expect(await publishAsWatcher(recipe, result)).toBe(false)
    })

    it('T-1518-6 / T-R3-M1-4: the steady enforcer names a failed teardown and a failed update of a revoked StatefulSet separately and publishes the drift', async () => {
      stubInner()
      denySecrets({ 'db-creds': '7', 'qa-creds': '7' })
      const workloads = (image: string) => [
        dbStatefulSet({ image }),
        deniedDeployment('qa-api', 'qa-creds'),
      ]
      const recipe = deniedStatefulSetRecipe('steady enforcer', workloads('postgres:16'))
      const name = await storeCredentialedStatefulSet(recipe)
      const namespace = recipe.metadata.namespace
      const store = installRecipeStore(recipe)

      const pass1Recipe = store.current()
      await publishAsWatcher(pass1Recipe, await reconciler.reconcile(pass1Recipe))
      // Witness: both workloads were revoked and recorded.
      expect(Object.keys(store.current().status?.secretOwnershipRevocations ?? {}).sort()).toEqual([
        'db',
        'qa-api',
      ])

      // qa-creds is denied under a new version and the Deployment delete fails;
      // db stays revoked, its StatefulSet drifted and its spec changed.
      denySecrets({ 'db-creds': '7', 'qa-creds': '8' })
      mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
        code: 500,
        message: 'apiserver boom',
      })
      const drifted = (await mockAppsApi.readNamespacedStatefulSet({
        name,
        namespace,
      })) as k8s.V1StatefulSet
      drifted.spec!.serviceName = 'renamed-by-hand'
      await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: drifted })
      const edited = store.current()
      edited.spec.workloads = workloads('postgres:17')

      const result = await reconciler.reconcile(edited)

      expect(result.message).toBe(
        'EnvSecretOwnershipDenied: teardown failed for qa-api; ' +
          'update of revoked StatefulSet failed for db (StatefulSet immutable drift: db) — requeuing'
      )
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(await publishAsWatcher(edited, result)).toBe(true)
      const drift = storedConditionOf(store, 'StatefulSetImmutableDrift')
      expect(drift?.status).toBe('True')
      expect(drift?.message).toContain('spec.serviceName')
      expect(storedConditionOf(store, 'EnvSecretOwnershipDenied')?.status).toBe('True')
    })

    it('T-R3-M1-3: a revoked transport StatefulSet is updated without deleting its McpServer delegation again', async () => {
      denySecrets({ 'db-creds': '7' })
      const transportDb = (overrides: Record<string, unknown> = {}) =>
        dbStatefulSet({ transport: { type: 'streamableHttp', path: '/mcp' }, ...overrides })
      const recipe = deniedStatefulSetRecipe('non-workflow deploy', [transportDb()])
      // A transport workload runs in the controller's own namespace.
      const name = await storeCredentialedStatefulSet(recipe, 'mcp-server')
      mockCustomApi.deleteNamespacedCustomObject.mockClear()
      const store = installRecipeStore(recipe)
      const delegationDeletes = () =>
        mockCustomApi.deleteNamespacedCustomObject.mock.calls.filter(
          ([arg]) => (arg as { plural?: string }).plural === 'mcpservers'
        ).length

      await reconciler.reconcile(store.current())
      // Witness: the revocation removed the delegation once.
      expect(delegationDeletes()).toBe(1)
      expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })

      const edited = store.current()
      edited.spec.workloads = [transportDb({ image: 'postgres:17' })]
      await reconciler.reconcile(edited)

      // Witness: the pass updated the revoked StatefulSet.
      expect(statefulSetWrites()).toEqual({ patches: 2, creates: 0, podDeletes: 1 })
      expect(statefulSetReads(name)).toBeGreaterThan(0)
      expect(delegationDeletes()).toBe(1)
    })

    it('T-1530-4: a denied StatefulSet whose claim template size is stored in canonical form is revoked (issue #1530)', async () => {
      denySecrets({ 'db-creds': '7' })
      const recipe = deniedStatefulSetRecipe('non-workflow deploy', [
        dbStatefulSet({
          volumeClaimTemplates: [{ name: 'data', size: '1024Mi', accessMode: 'ReadWriteOnce' }],
        }),
      ])
      const name = await storeCredentialedStatefulSet(recipe)
      const namespace = recipe.metadata.namespace
      const stored = async () =>
        (await mockAppsApi.readNamespacedStatefulSet({ name, namespace })) as k8s.V1StatefulSet
      // The API server stores 1024Mi as 1Gi.
      const live = await stored()
      live.spec!.volumeClaimTemplates![0].spec!.resources!.requests!.storage = '1Gi'
      await mockAppsApi.replaceNamespacedStatefulSet({ name, namespace, body: live })
      const store = installRecipeStore(recipe)

      const result = await reconciler.reconcile(store.current())

      expect(statefulSetWrites()).toEqual({ patches: 1, creates: 0, podDeletes: 1 })
      expect(JSON.stringify((await stored()).spec!.template)).not.toContain('db-creds')
      expect(store.current().status?.secretOwnershipRevocations?.['db']).toMatch(/^sha256:/)
      expect(result.requeueAfterMs).toBeUndefined()
    })

    /** A Deployment that declares volumeClaimTemplates; only a StatefulSet turns them into PVCs. */
    function deniedDeploymentWithClaims(id: string, secretName: string): WorkloadDef {
      return {
        ...deniedDeployment(id, secretName),
        volumeClaimTemplates: [{ name: 'data', size: '1Gi' }],
      } as unknown as WorkloadDef
    }

    it('T-P2-1 the non-workflow revocation round deletes a denied Deployment that declares volumeClaimTemplates', async () => {
      mockCoreApi.readNamespacedSecret.mockImplementation(async () => ({
        metadata: { resourceVersion: '5', labels: { 'clerum.io/owner-recipe': 'test-recipe' } },
        data: { token: 'eA==' },
      }))
      const store = installRecipeStore(
        makeRecipe({ spec: { workloads: [deniedDeploymentWithClaims('vct-api', 'qa-creds')] } })
      )
      const renders = () =>
        [
          ...mockAppsApi.createNamespacedDeployment.mock.calls,
          ...mockAppsApi.replaceNamespacedDeployment.mock.calls,
        ].filter(([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'vct-api')

      await reconciler.reconcile(store.current())

      // Pass 0 rendered the Deployment with the Secret reference.
      expect(renders()).toHaveLength(1)
      expect(
        JSON.stringify(renders()[0][0].body?.spec?.template?.spec?.containers?.[0]?.env)
      ).toContain('"secretKeyRef":{"name":"qa-creds","key":"token"}')
      expect(deploymentDeletes('vct-api')).toBe(0)

      denySecrets({ 'qa-creds': '7' })
      mockCoreApi.deleteNamespacedPersistentVolumeClaim.mockClear()
      const denied = await reconciler.reconcile(store.current())

      // Witness: the Deployment delete was sent.
      expect(deploymentDeletes('vct-api')).toBe(1)
      expect(denied.phase).toBe('degraded')
      expect(deniedCondition(denied)).toBe('True')
      expect(store.current().status?.secretOwnershipRevocations?.['vct-api']).toMatch(
        /^sha256:[0-9a-f]{64}$/
      )
      expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    })

    it('T-P2-2 the steady enforcer deletes a denied Deployment that declares volumeClaimTemplates', async () => {
      const inner = stubInner()
      denySecrets({ 'qa-creds': '7' })
      const store = installRecipeStore(
        runChild([deniedDeploymentWithClaims('vct-api', 'qa-creds')], {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        })
      )

      const result = await reconciler.reconcile(store.current())

      // Witness: the pass classified the Secret.
      expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalled()
      expect(deploymentDeletes('vct-api')).toBe(1)
      expect(deniedCondition(result)).toBe('True')
      expect(store.current().status?.secretOwnershipRevocations?.['vct-api']).toMatch(
        /^sha256:[0-9a-f]{64}$/
      )
      expect(inner.reconcile).not.toHaveBeenCalled()
    })

    it('T2.6 a denied StatefulSet that was never deployed is not created, and its revocation is recorded', async () => {
      denySecrets({ 'db-creds': '7' })
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'db',
              type: 'statefulset',
              image: 'postgres:16',
              port: 5432,
              envSecret: {
                name: 'db-creds',
                keys: [{ secretKey: 'db-password', envVar: 'POSTGRES_PASSWORD' }],
              },
            } as WorkloadDef,
          ],
        },
      })
      const store = installRecipeStore(recipe)

      const result = await reconciler.reconcile(store.current())

      expect(
        mockAppsApi.readNamespacedStatefulSet.mock.calls.some(([arg]) =>
          String(arg.name).includes('-db')
        )
      ).toBe(true)
      expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(
        mockCoreApi.createNamespacedService.mock.calls.filter(([arg]) =>
          String(arg.body?.metadata?.name).endsWith('-headless')
        )
      ).toHaveLength(0)
      expect(mockCoreApi.deleteCollectionNamespacedPod).not.toHaveBeenCalled()
      expect(result.workloadStatuses.find(w => w.id === 'db')).toMatchObject({
        phase: 'failed',
        message: expect.stringContaining('EnvSecretOwnershipDenied'),
      })
      expect(store.current().status?.secretOwnershipRevocations?.db).toMatch(/^sha256:/)
    })

    it('T2.7 a Secret denied again under a new resourceVersion is revoked again and its entry changes', async () => {
      const inner = stubInner()
      const digestAt = (resourceVersion: string) =>
        deniedSecretRevocationDigest(
          ['qa-creds'],
          new Map([
            ['qa-creds', { state: 'denied', versions: [`sandbox-recipes/${resourceVersion}`] }],
          ])
        )
      const store = installRecipeStore(
        runChild([deniedDeployment('qa-api', 'qa-creds')], {
          phase: 'active',
          workflowExecution: { phase: 'running' },
          secretOwnershipRevocations: { 'qa-api': digestAt('6') },
        })
      )

      // The stored entry matches the denial still in force: nothing to do.
      denySecrets({ 'qa-creds': '6' })
      await reconciler.reconcile(store.current())
      expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalled()
      expect(deploymentDeletes('qa-api')).toBe(0)

      // The Secret was written while still foreign: a new denial, a new round.
      denySecrets({ 'qa-creds': '7' })
      await reconciler.reconcile(store.current())

      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toBe(digestAt('7'))
      expect(digestAt('7')).not.toBe(digestAt('6'))
      expect(inner.reconcile).not.toHaveBeenCalled()
    })

    it('T2.10 a revocation record the API server rejects keeps the deploy result and requeues', async () => {
      const inner = stubInner()
      denySecrets({ 'qa-creds': '7' })
      const store = installRecipeStore(
        runChild([deniedDeployment('qa-api', 'qa-creds')], { phase: 'candidate' })
      )
      const storePatch = mockCustomApi.patchNamespacedCustomObjectStatus.getMockImplementation()!
      let rejected = 0
      mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(async args => {
        if (args.body?.status?.secretOwnershipRevocations && rejected === 0) {
          rejected += 1
          throw { code: 500, message: 'apiserver boom' }
        }
        return storePatch(args)
      })

      const first = await reconciler.reconcile(store.current())

      expect(rejected).toBe(1)
      expect(first.phase).toBe('active')
      expect(first.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(inner.reconcile).toHaveBeenCalledTimes(1)
      expect(store.current().status?.secretOwnershipRevocations).toBeUndefined()
      expect(deploymentDeletes('qa-api')).toBe(1)

      const second = await reconciler.reconcile(store.current())

      expect(deploymentDeletes('qa-api')).toBe(2)
      expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toMatch(/^sha256:/)
      expect(second.requeueAfterMs).toBeUndefined()
    })

    it('T2.11 a partial teardown failure records only the workload that was revoked', async () => {
      stubInner()
      denySecrets({ 'a-creds': '7', 'b-creds': '7' })
      const store = installRecipeStore(
        runChild([deniedDeployment('a-api', 'a-creds'), deniedDeployment('b-api', 'b-creds')], {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        })
      )
      let failB = true
      mockAppsApi.deleteNamespacedDeployment.mockImplementation(async ({ name }) => {
        if (String(name).includes('-b-api-') && failB) throw { code: 403, message: 'forbidden' }
        return {}
      })

      const first = await reconciler.reconcile(store.current())

      expect(first.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(first.skipStatusPatch).toBe(true)
      expect(deploymentDeletes('a-api')).toBe(1)
      expect(deploymentDeletes('b-api')).toBe(1)
      expect(Object.keys(store.current().status?.secretOwnershipRevocations ?? {})).toEqual([
        'a-api',
      ])

      failB = false
      const second = await reconciler.reconcile(store.current())

      expect(deploymentDeletes('a-api')).toBe(1)
      expect(deploymentDeletes('b-api')).toBe(2)
      expect(Object.keys(store.current().status?.secretOwnershipRevocations ?? {}).sort()).toEqual([
        'a-api',
        'b-api',
      ])
      expect(deniedCondition(second)).toBe('True')
    })

    it('T2.12 a revocation record the API server pruned (older CRD) is not reported as stored', async () => {
      stubInner()
      denySecrets({ 'qa-creds': '7' })
      const store = installRecipeStore(
        runChild([deniedDeployment('qa-api', 'qa-creds')], {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        }),
        { prune: ['secretOwnershipRevocations'] }
      )
      const errorLog = captureLogger('error')
      const recipe = store.current()

      const result = await reconciler.reconcile(recipe)
      errorLog.mockRestore()

      expect(revocationPatches()).toEqual([{ 'qa-api': expect.stringMatching(/^sha256:/) }])
      const notStored = errorLog.mock.calls.find(
        ([message]) => message === 'Run status record was not stored; requeueing'
      )
      expect(notStored).toBeDefined()
      expect(String((notStored![1] as { err: Error }).err.message)).toContain(
        'workflowrecipes.clerum.io'
      )
      expect(recipe.status?.secretOwnershipRevocations).toBeUndefined()
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(deploymentDeletes('qa-api')).toBe(1)
      // Issue #1349 (B-L2) — the workload was revoked, so the denial is published.
      expect(deniedCondition(result)).toBe('True')
      expect(result.skipStatusPatch).not.toBe(true)
      expect(result.message).toBe(
        'EnvSecretOwnershipDenied: foreign Secret ref revoked on steady workflow'
      )

      await reconciler.reconcile(store.current())

      expect(deploymentDeletes('qa-api')).toBe(2)
    })

    it('T-BL2-2 a revocation record rejected once still publishes the denial, then is stored', async () => {
      stubInner()
      denySecrets({ 'qa-creds': '7' })
      const store = installRecipeStore(
        runChild([deniedDeployment('qa-api', 'qa-creds')], {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        })
      )
      const storePatch = mockCustomApi.patchNamespacedCustomObjectStatus.getMockImplementation()!
      let rejectedRecords = 0
      mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(
        async (arg: { body?: { status?: { secretOwnershipRevocations?: object } } }) => {
          if (rejectedRecords === 0 && arg.body?.status?.secretOwnershipRevocations) {
            rejectedRecords += 1
            throw { code: 500, message: 'apiserver boom' }
          }
          return storePatch(arg)
        }
      )
      const errorLog = captureLogger('error')

      const first = await reconciler.reconcile(store.current())
      errorLog.mockRestore()

      // Witness: the record write was attempted and the workload was deleted.
      expect(rejectedRecords).toBe(1)
      expect(deploymentDeletes('qa-api')).toBe(1)
      expect(deniedCondition(first)).toBe('True')
      expect(first.skipStatusPatch).not.toBe(true)
      expect(first.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(store.current().status?.secretOwnershipRevocations).toBeUndefined()

      const second = await reconciler.reconcile(store.current())

      expect(deploymentDeletes('qa-api')).toBe(2)
      expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toMatch(
        /^sha256:[0-9a-f]{64}$/
      )
      expect(second.requeueAfterMs).toBeUndefined()
      expect(deniedCondition(second)).toBe('True')
    })

    /**
     * Issue #1349 (B-M1) — Secrets by name: `foreign` ones are labeled for another
     * recipe (denied), `owned` ones for test-recipe (accessible); others 404.
     */
    function classifySecrets(
      foreign: Record<string, string>,
      owned: Record<string, string> = {}
    ): void {
      mockCoreApi.readNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => {
        const owner =
          foreign[name] !== undefined
            ? 'some-other-recipe'
            : owned[name] !== undefined
              ? 'test-recipe'
              : undefined
        if (owner === undefined) throw { code: 404 }
        return {
          metadata: {
            resourceVersion: foreign[name] ?? owned[name],
            labels: { 'clerum.io/owner-recipe': owner },
          },
          data: { token: 'eA==' },
        }
      })
    }

    /** Create/replace requests that render the Deployment of `workloadId`. */
    function deploymentRenders(workloadId: string): number {
      return [
        ...mockAppsApi.createNamespacedDeployment.mock.calls,
        ...mockAppsApi.replaceNamespacedDeployment.mock.calls,
      ].filter(([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === workloadId).length
    }

    /** Status patches that remove revocation entries (a `null` member). */
    function revocationRemovals(): Array<Record<string, string | null>> {
      return revocationPatches().filter(entry =>
        Object.values(entry).some(value => value === null)
      ) as Array<Record<string, string | null>>
    }

    /**
     * Reads the stored revocation entry of `workloadId` inside the first request
     * of `mocks` that `matches` accepts, i.e. at the moment that write is sent.
     * The wrapped implementations are restored when the test ends.
     */
    function entryAtFirstWrite(
      store: { current: () => WorkflowRecipeCRD },
      workloadId: string,
      mocks: Array<ReturnType<typeof vi.fn>>,
      matches: (arg: Record<string, unknown>) => boolean
    ): () => { entry: string | undefined } | undefined {
      let captured: { entry: string | undefined } | undefined
      for (const mock of mocks) {
        const original = mock.getMockImplementation()
        expect(original).toBeDefined()
        mock.mockImplementation(async (arg: Record<string, unknown>, ...rest: unknown[]) => {
          if (captured === undefined && matches(arg)) {
            captured = { entry: store.current().status?.secretOwnershipRevocations?.[workloadId] }
          }
          return original!(arg, ...rest)
        })
        onTestFinished(() => {
          mock.mockImplementation(original!)
        })
      }
      return () => captured
    }

    const rendersWorkload = (workloadId: string) => (arg: Record<string, unknown>) =>
      (arg.body as { metadata?: { labels?: Record<string, string> } } | undefined)?.metadata
        ?.labels?.['clerum.io/workload'] === workloadId

    const writesMcpServer = (arg: Record<string, unknown>) => arg.plural === 'mcpservers'

    /** Seeds a stored revocation entry, as an earlier denial pass would have. */
    function withRevocations(
      recipe: WorkflowRecipeCRD,
      entries: Record<string, string>
    ): WorkflowRecipeCRD {
      recipe.status = {
        ...(recipe.status ?? {}),
        secretOwnershipRevocations: entries,
      } as WorkflowRecipeCRD['status']
      return recipe
    }

    const STORED_DIGEST = `sha256:${'a'.repeat(64)}`

    for (const path of ['non-workflow', 'workflow'] as const) {
      const recipeFor = (workloads: WorkloadDef[]) =>
        path === 'workflow'
          ? runChild(workloads, { phase: 'candidate' })
          : makeRecipe({ spec: { workloads } })

      it(`T-BM1-${path === 'workflow' ? '2' : '1'} the ${path} deploy path removes a revocation entry before it renders the workload again (spec A→B→A)`, async () => {
        const inner = path === 'workflow' ? stubInner() : undefined
        classifySecrets({ 'qa-creds': '7' }, { 'own-creds': '9' })
        const store = installRecipeStore(recipeFor([deniedDeployment('qa-api', 'qa-creds')]))
        const entryAtRender = entryAtFirstWrite(
          store,
          'qa-api',
          [mockAppsApi.createNamespacedDeployment, mockAppsApi.replaceNamespacedDeployment],
          rendersWorkload('qa-api')
        )

        // Pass 1: denied → torn down and recorded.
        await reconciler.reconcile(store.current())

        expect(deploymentDeletes('qa-api')).toBe(1)
        const firstDigest = store.current().status?.secretOwnershipRevocations?.['qa-api']
        expect(firstDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

        // Pass 2: the spec points the workload at its own Secret → rendered.
        const pass2 = store.current()
        pass2.spec.workloads![0] = deniedDeployment('qa-api', 'own-creds')
        await reconciler.reconcile(pass2)

        // Witness: pass 2 rendered qa-api.
        expect(deploymentRenders('qa-api')).toBeGreaterThanOrEqual(1)
        expect(entryAtRender()).toEqual({ entry: undefined })
        expect(revocationRemovals()).toEqual([{ 'qa-api': null }])
        expect(store.current().status?.secretOwnershipRevocations).not.toHaveProperty('qa-api')

        // Pass 3: back to the foreign Secret at the same resourceVersion.
        const pass3 = store.current()
        pass3.spec.workloads![0] = deniedDeployment('qa-api', 'qa-creds')
        const third = await reconciler.reconcile(pass3)

        expect(deploymentDeletes('qa-api')).toBe(2)
        expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toBe(firstDigest)
        expect(deniedCondition(third)).toBe('True')
        if (inner) expect(inner.reconcile).toHaveBeenCalledTimes(3)
      })

      it(`T-BM1-3 the ${path} deploy path removes a transport workload's revocation entry before its McpServer is written`, async () => {
        if (path === 'workflow') stubInner()
        const transportWorkload = {
          ...deniedDeployment('mcp-api', 'mcp-creds'),
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
        } as WorkloadDef
        classifySecrets({ 'mcp-creds': '7' })
        const store = installRecipeStore(recipeFor([transportWorkload]))

        // Pass 1: denied → revoked and recorded.
        await reconciler.reconcile(store.current())
        expect(store.current().status?.secretOwnershipRevocations?.['mcp-api']).toMatch(/^sha256:/)

        // Pass 2: the Secret is now owned by the recipe → delegated again.
        classifySecrets({}, { 'mcp-creds': '8' })
        mockCustomApi.createNamespacedCustomObject.mockClear()
        mockCustomApi.replaceNamespacedCustomObject.mockClear()
        const entryAtMcpServerWrite = entryAtFirstWrite(
          store,
          'mcp-api',
          [mockCustomApi.createNamespacedCustomObject, mockCustomApi.replaceNamespacedCustomObject],
          writesMcpServer
        )

        await reconciler.reconcile(store.current())

        // Witness: the McpServer write happened.
        expect(entryAtMcpServerWrite()).toEqual({ entry: undefined })
        expect(store.current().status?.secretOwnershipRevocations).not.toHaveProperty('mcp-api')
      })

      it(`T-BM1-4 the ${path} deploy path renders nothing and requeues when the entry cannot be removed`, async () => {
        const inner = path === 'workflow' ? stubInner() : undefined
        classifySecrets({}, { 'own-creds': '9' })
        const store = installRecipeStore(
          withRevocations(recipeFor([deniedDeployment('qa-api', 'own-creds')]), {
            'qa-api': STORED_DIGEST,
          })
        )
        const storePatch = mockCustomApi.patchNamespacedCustomObjectStatus.getMockImplementation()!
        let rejectedRemovals = 0
        mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(
          async (arg: { body?: { status?: { secretOwnershipRevocations?: object } } }) => {
            const entries = arg.body?.status?.secretOwnershipRevocations
            if (
              rejectedRemovals === 0 &&
              entries &&
              Object.values(entries).some(value => value === null)
            ) {
              rejectedRemovals += 1
              throw { code: 500, message: 'apiserver boom' }
            }
            return storePatch(arg)
          }
        )

        const failed = await reconciler.reconcile(store.current())

        // Witness: the removal was attempted once and the pass classified the Secret.
        expect(rejectedRemovals).toBe(1)
        expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalled()
        expect(failed.phase).toBe('degraded')
        expect(failed.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(deploymentRenders('qa-api')).toBe(0)
        expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toBe(STORED_DIGEST)
        if (inner) expect(inner.reconcile).not.toHaveBeenCalled()

        await reconciler.reconcile(store.current())

        expect(store.current().status?.secretOwnershipRevocations).not.toHaveProperty('qa-api')
        expect(deploymentRenders('qa-api')).toBeGreaterThanOrEqual(1)
      })
    }

    it('T-BM1-5 the entry is removed when only the live object holds it', async () => {
      classifySecrets({}, { 'own-creds': '9' })
      const store = installRecipeStore(
        withRevocations(
          makeRecipe({ spec: { workloads: [deniedDeployment('qa-api', 'qa-creds')] } }),
          {
            'qa-api': STORED_DIGEST,
          }
        )
      )
      // The object the pass runs on was read before the entry was stored.
      const stale = store.current()
      delete stale.status!.secretOwnershipRevocations
      stale.spec.workloads![0] = deniedDeployment('qa-api', 'own-creds')

      await reconciler.reconcile(stale)

      // Witness: the workload was rendered.
      expect(deploymentRenders('qa-api')).toBeGreaterThanOrEqual(1)
      expect(store.current().status?.secretOwnershipRevocations).not.toHaveProperty('qa-api')
    })

    it('T-BM1-6 a pass with no stale entry reads the live recipe once more and writes no revocation record', async () => {
      classifySecrets({}, { 'own-creds': '9' })
      const store = installRecipeStore(
        makeRecipe({ spec: { workloads: [deniedDeployment('qa-api', 'own-creds')] } })
      )
      const recipeGets = () =>
        mockCustomApi.getNamespacedCustomObject.mock.calls.filter(
          ([arg]) => arg.plural === 'workflowrecipes' && arg.name === 'test-recipe'
        ).length
      // Pass 1 creates the Deployment; pass 2 reads it back and finds it current.
      const deploymentReads = () =>
        mockAppsApi.readNamespacedDeployment.mock.calls.filter(([arg]) =>
          String(arg.name).includes('-qa-api-')
        ).length
      // Before the clear existed (c5efc1e91) this fixture sent two recipe GETs per
      // pass; the clear adds its one live read.
      const recipeGetsPerPassBeforeTheClear = 2

      for (const pass of [1, 2]) {
        const getsBefore = recipeGets()
        const readsBefore = deploymentReads()

        await reconciler.reconcile(store.current())

        // Witness: the pass reached the workload's render and made the clear's
        // live read.
        expect(deploymentReads(), `pass ${pass}`).toBeGreaterThan(readsBefore)
        expect(recipeGets() - getsBefore, `pass ${pass}`).toBe(recipeGetsPerPassBeforeTheClear + 1)
      }
      expect(deploymentRenders('qa-api')).toBe(1)
      expect(revocationPatches()).toHaveLength(0)
    })

    it('T-BM1-7 a denied sibling keeps its entry while the re-rendered workload loses its own', async () => {
      classifySecrets({ 'a-creds': '7', 'b-creds': '5' })
      const store = installRecipeStore(
        makeRecipe({
          spec: {
            workloads: [deniedDeployment('api-a', 'a-creds'), deniedDeployment('api-b', 'b-creds')],
          },
        })
      )

      await reconciler.reconcile(store.current())

      expect(deploymentDeletes('api-a')).toBe(1)
      expect(deploymentDeletes('api-b')).toBe(1)
      const entryA = store.current().status?.secretOwnershipRevocations?.['api-a']
      expect(entryA).toMatch(/^sha256:/)
      expect(store.current().status?.secretOwnershipRevocations?.['api-b']).toMatch(/^sha256:/)

      // b-creds now belongs to the recipe; a-creds is still foreign at the same version.
      classifySecrets({ 'a-creds': '7' }, { 'b-creds': '6' })
      const secretReads = mockCoreApi.readNamespacedSecret.mock.calls.length

      await reconciler.reconcile(store.current())

      // Witness: pass 2 classified the Secrets and rendered api-b.
      expect(mockCoreApi.readNamespacedSecret.mock.calls.length).toBeGreaterThan(secretReads)
      expect(deploymentRenders('api-b')).toBeGreaterThanOrEqual(1)
      expect(store.current().status?.secretOwnershipRevocations?.['api-a']).toBe(entryA)
      expect(store.current().status?.secretOwnershipRevocations).not.toHaveProperty('api-b')
      const secretReadsBeforePass3 = mockCoreApi.readNamespacedSecret.mock.calls.length

      const third = await reconciler.reconcile(store.current())

      // Witness: pass 3 classified the Secrets again and published the denial.
      expect(mockCoreApi.readNamespacedSecret.mock.calls.length).toBeGreaterThan(
        secretReadsBeforePass3
      )
      expect(deniedCondition(third)).toBe('True')
      expect(deploymentDeletes('api-a')).toBe(1)
    })

    /** True once the pass has read `secretName` to classify it. */
    const secretWasRead = (secretName: string) =>
      mockCoreApi.readNamespacedSecret.mock.calls.some(([arg]) => arg.name === secretName)

    for (const path of ['non-workflow', 'workflow'] as const) {
      it(`T-R2-${path === 'workflow' ? '2' : '1'} the ${path} deploy path renders nothing and requeues when the live read of the revocation clear fails`, async () => {
        const inner = path === 'workflow' ? stubInner() : undefined
        classifySecrets({}, { 'own-creds': '9' })
        const workloads = [deniedDeployment('qa-api', 'own-creds')]
        const readError = { code: 503, message: 'apiserver unavailable' }
        let failedReads = 0
        let readsAfterClassification = 0
        const store = installRecipeStore(
          withRevocations(
            path === 'workflow'
              ? runChild(workloads, { phase: 'candidate' })
              : makeRecipe({ spec: { workloads } }),
            { 'qa-api': STORED_DIGEST }
          ),
          {
            // The clear's live read is the first recipe read after the pass
            // classified the Secret; that read fails once.
            onGet: () => {
              if (!secretWasRead('own-creds')) return undefined
              readsAfterClassification += 1
              if (failedReads === 0) {
                failedReads += 1
                throw readError
              }
              return undefined
            },
          }
        )

        const failed = await reconciler.reconcile(store.current())

        // Witness: the read after the classification failed once.
        expect(failedReads).toBe(1)
        expect(failed.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
        expect(deploymentRenders('qa-api')).toBe(0)
        expect(revocationRemovals()).toHaveLength(0)
        expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toBe(STORED_DIGEST)
        if (inner) expect(inner.reconcile).not.toHaveBeenCalled()

        // Pass 2 (healthy): the clear's read is the first recipe read after the
        // Secret classification, so its removal patch follows exactly one such read.
        mockCoreApi.readNamespacedSecret.mockClear()
        readsAfterClassification = 0
        let readsAtRemovalPatch: number | undefined
        const storePatch = mockCustomApi.patchNamespacedCustomObjectStatus.getMockImplementation()!
        mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(
          async (arg: { body?: { status?: { secretOwnershipRevocations?: object } } }) => {
            const entries = arg.body?.status?.secretOwnershipRevocations
            if (entries && Object.values(entries).some(value => value === null)) {
              readsAtRemovalPatch ??= readsAfterClassification
            }
            return storePatch(arg)
          }
        )

        await reconciler.reconcile(store.current())

        expect(readsAtRemovalPatch).toBe(1)
        expect(store.current().status?.secretOwnershipRevocations).not.toHaveProperty('qa-api')
        expect(deploymentRenders('qa-api')).toBeGreaterThanOrEqual(1)
      })
    }

    for (const row of [
      {
        id: 'T-R2-4',
        state: 'was replaced under the same name (another uid)',
        answer: (stored: WorkflowRecipeCRD) => {
          stored.metadata.uid = 'uid-of-the-replacement'
          return stored
        },
      },
      {
        id: 'T-R2-5',
        state: 'is being deleted',
        answer: (stored: WorkflowRecipeCRD) => {
          stored.metadata.deletionTimestamp = '2026-11-16T10:00:00.000Z'
          return stored
        },
      },
    ]) {
      it(`${row.id} the revocation clear removes nothing when the live recipe ${row.state}`, async () => {
        classifySecrets({}, { 'own-creds': '9' })
        let answered = 0
        const store = installRecipeStore(
          withRevocations(
            makeRecipe({ spec: { workloads: [deniedDeployment('qa-api', 'own-creds')] } }),
            { 'qa-api': STORED_DIGEST }
          ),
          {
            // From the Secret classification on, the API server answers with the
            // other object: the clear's read and the liveness check after it.
            onGet: stored => {
              if (!secretWasRead('own-creds')) return undefined
              answered += 1
              return row.answer(stored)
            },
          }
        )
        const passObject = store.current()

        const result = await reconciler.reconcile(passObject)

        // Witness: the clear's read and the later liveness check got that answer,
        // and the pass stopped at that check.
        expect(answered).toBeGreaterThanOrEqual(2)
        expect(result.message).toContain('Recipe deleted during reconcile')
        expect(revocationRemovals()).toHaveLength(0)
        expect(store.current().status?.secretOwnershipRevocations?.['qa-api']).toBe(STORED_DIGEST)
        expect(passObject.status?.secretOwnershipRevocations?.['qa-api']).toBe(STORED_DIGEST)
        expect(deploymentRenders('qa-api')).toBe(0)
      })
    }

    it('T-R2-6 the object the pass ran on loses the entry the clear removed from the store', async () => {
      classifySecrets({}, { 'own-creds': '9' })
      const store = installRecipeStore(
        withRevocations(
          makeRecipe({ spec: { workloads: [deniedDeployment('qa-api', 'own-creds')] } }),
          { 'qa-api': STORED_DIGEST }
        )
      )
      const passObject = store.current()
      expect(passObject.status?.secretOwnershipRevocations?.['qa-api']).toBe(STORED_DIGEST)

      await reconciler.reconcile(passObject)

      // Witness: the stored entry was removed and the workload rendered.
      expect(revocationRemovals()).toEqual([{ 'qa-api': null }])
      expect(deploymentRenders('qa-api')).toBeGreaterThanOrEqual(1)
      expect(passObject.status?.secretOwnershipRevocations).not.toHaveProperty('qa-api')
    })

    it('T-R2-7 the object the pass ran on loses a stale entry when the store holds none, and no patch is sent', async () => {
      classifySecrets({}, { 'own-creds': '9' })
      const store = installRecipeStore(
        makeRecipe({ spec: { workloads: [deniedDeployment('qa-api', 'own-creds')] } })
      )
      // The object the pass runs on still carries an entry the store no longer has.
      const passObject = withRevocations(store.current(), { 'qa-api': STORED_DIGEST })

      await reconciler.reconcile(passObject)

      // Witness: the workload was rendered, so the clear ran before it.
      expect(deploymentRenders('qa-api')).toBeGreaterThanOrEqual(1)
      expect(revocationPatches()).toHaveLength(0)
      expect(passObject.status?.secretOwnershipRevocations).not.toHaveProperty('qa-api')
    })
  })

  describe('terminal-run compute teardown (CPU-starvation fix)', () => {
    type TeardownStub = {
      ensureMcpHostRuntimeCredentials: ReturnType<typeof vi.fn>
      ensureCoordinatorRuntimeCredentials: ReturnType<typeof vi.fn>
      teardownComputePodsForTerminalRun: ReturnType<typeof vi.fn>
      reconcile: ReturnType<typeof vi.fn>
      validateWorkflowSpec: () => undefined
    }

    afterEach(() => {
      mockCustomApi.patchNamespacedCustomObjectStatus
        .mockReset()
        .mockImplementation(echoPatchedStatus)
    })

    function stubWorkflowReconciler(): TeardownStub {
      const stub: TeardownStub = {
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        ensureCoordinatorRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        teardownComputePodsForTerminalRun: vi.fn().mockResolvedValue(undefined),
        // Long-lived (non-run-scoped) recipes fall through to the inner
        // reconcile; stub it so the fall-through path does not crash.
        reconcile: vi.fn().mockResolvedValue({
          phase: 'active',
          message: 'Workflow infrastructure created',
          workflowPhase: 'completed',
        }),
        validateWorkflowSpec: () => undefined,
      }
      ;(reconciler as unknown as { workflowReconciler: TeardownStub }).workflowReconciler = stub
      return stub
    }

    function makeTerminalRunRecipe(
      overrides: {
        name?: string
        phase?: 'completed' | 'failed' | 'cancelled'
        runScoped?: boolean
        transport?: boolean
        // A PVC-backed stateful transport workload — the over-delete guard
        // must SKIP it (never delete a StatefulSet / its PVC).
        statefulTransport?: boolean
      } = {}
    ): WorkflowRecipeCRD {
      const name = overrides.name ?? 'wf-run-123'
      const runScoped = overrides.runScoped ?? true
      const phase = overrides.phase ?? 'completed'
      const labels: Record<string, string> = {
        'clerum.io/parent-recipe': 'parent-recipe',
      }
      if (runScoped) labels['clerum.io/workflow-run-id'] = 'run-123'
      const workloads: WorkloadDef[] = []
      const workloadInstances: Record<string, string> = {}
      if (overrides.transport) {
        workloads.push({
          id: 'web-search',
          type: 'deployment',
          image: 'web-search:latest',
          transport: { type: 'streamableHttp', path: '/mcp' },
        })
        // Pin the run-scoped resolved name so the Deployment delete is
        // deterministic (resolveWorkloadResourceName status fast-path).
        workloadInstances['web-search'] = `${name}-web-search-run`
      }
      if (overrides.statefulTransport) {
        workloads.push({
          id: 'stateful-mcp',
          type: 'statefulset',
          image: 'stateful-mcp:latest',
          transport: { type: 'streamableHttp', path: '/mcp' },
          volumeClaimTemplates: [
            { name: 'data', storageClass: 'standard', accessMode: 'ReadWriteOnce', size: '1Gi' },
          ],
        } as WorkloadDef)
        workloadInstances['stateful-mcp'] = `${name}-stateful-mcp-run`
      }
      return makeRecipe({
        metadata: {
          name,
          namespace: 'sandbox-recipes',
          uid: `uid-${name}`,
          labels,
          ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
        },
        spec: {
          ...(workloads.length ? { workloads } : {}),
          steps: [{ id: 'research', instruction: 'run' }],
        },
        status: {
          phase: phase === 'completed' ? 'active' : 'failed',
          message: `Workflow ${phase}`,
          ...(Object.keys(workloadInstances).length ? { workloadInstances } : {}),
          workflowExecution: { phase },
        } as WorkflowRecipeCRD['status'],
      })
    }

    it('frees compute pods for a terminal run-scoped workflow', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-completed', phase: 'completed' })

      await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-completed')
    })

    it('frees compute pods for a terminal FAILED run too', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-failed', phase: 'failed' })

      await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-failed')
    })

    it('frees compute pods for a terminal CANCELLED run too', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-cancelled', phase: 'cancelled' })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-cancelled')
      expect(stub.reconcile).not.toHaveBeenCalled()
    })

    it('deletes the cross-namespace transport McpServer CRD AND its WRC-owned Deployment on terminal', async () => {
      const stub = stubWorkflowReconciler()
      mockCustomApi.deleteNamespacedCustomObject.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      const recipe = makeTerminalRunRecipe({
        name: 'wf-run-transport',
        phase: 'completed',
        transport: true,
      })

      await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-transport')
      // (a) McpServer CRD deleted by recipe scope (delegation cleanup).
      expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'mcpservers' })
      )
      // (b) CRITICAL: the WRC-owned (managed:false) Deployment is HTTP transport
      // → NOT HCC-GC'd → must be deleted directly, or the ~100m pod leaks. Assert
      // the run-scoped Deployment delete happened in the mcp-server namespace.
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wf-run-transport-web-search-run',
          namespace: 'mcp-server',
        })
      )
    })

    it('still deletes terminal transport resources when workflow reconciler is unavailable', async () => {
      ;(reconciler as unknown as { workflowReconciler?: undefined }).workflowReconciler = undefined
      mockCustomApi.deleteNamespacedCustomObject.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      const recipe = makeTerminalRunRecipe({
        name: 'wf-run-transport-no-wfr',
        phase: 'failed',
        transport: true,
      })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'mcpservers' })
      )
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wf-run-transport-no-wfr-web-search-run',
          namespace: 'mcp-server',
        })
      )
      // Issue #1349 — the compute pods were not deleted, so nothing is recorded
      // and the pass asks for a retry.
      expect(result.requeueAfterMs).toBe(5_000)
      expect(
        mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
          ([arg]) => arg.body?.status?.terminalRunTeardown !== undefined
        )
      ).toHaveLength(0)
      expect(recipe.status?.terminalRunTeardown).toBeUndefined()
    })

    it('over-delete guard: a stateful transport workload is NEVER deleted (no StatefulSet, no PVC delete)', async () => {
      stubWorkflowReconciler()
      mockAppsApi.deleteNamespacedStatefulSet.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      mockCoreApi.deleteNamespacedPersistentVolumeClaim.mockClear()
      const recipe = makeTerminalRunRecipe({
        name: 'wf-run-stateful',
        phase: 'completed',
        statefulTransport: true,
      })

      await reconciler.reconcile(recipe)

      // The stateful transport workload (PVC-backed) must be skipped entirely.
      expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      // And it must NOT be deleted as a Deployment either.
      expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'wf-run-stateful-stateful-mcp-run' })
      )
    })

    it('does NOT tear down a non-run-scoped (long-lived) recipe', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({
        name: 'long-lived',
        phase: 'completed',
        runScoped: false,
      })

      // A snippet-only workflow needs no mcp-host, so a long-lived one does not
      // await a triggered run and reaches the terminal branch.
      recipe.spec.steps = [{ id: 'render', run: snippetRun() }]

      const result = await reconciler.reconcile(recipe)

      // Witness: the terminal result was returned.
      expect(result).toMatchObject({ phase: 'active', message: 'Workflow completed' })
      expect(stub.reconcile).not.toHaveBeenCalled()
      expect(stub.teardownComputePodsForTerminalRun).not.toHaveBeenCalled()
      expect(
        mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
          ([arg]) => arg.body?.status?.terminalRunTeardown !== undefined
        )
      ).toHaveLength(0)
      expect(recipe.status?.terminalRunTeardown).toBeUndefined()
    })

    it('is best-effort: a teardown failure does not block the terminal status result', async () => {
      const stub = stubWorkflowReconciler()
      stub.teardownComputePodsForTerminalRun.mockRejectedValueOnce(new Error('K8s API blip'))
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-flaky', phase: 'completed' })

      const result = await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-flaky')
      // The terminal phase still resolves — artifacts/CR are preserved regardless.
      expect(result.phase).toBe('active')
    })

    it('re-running a terminal reconcile stays idempotent (teardown recorded once, never recreates)', async () => {
      const stub = stubWorkflowReconciler()
      const store = installRecipeStore(
        makeTerminalRunRecipe({ name: 'wf-run-idem', phase: 'completed', transport: true })
      )
      const mcpServerDeletes = () =>
        mockCustomApi.deleteNamespacedCustomObject.mock.calls.filter(
          ([arg]) => arg.plural === 'mcpservers'
        ).length

      await reconciler.reconcile(store.current())

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledTimes(1)
      expect(mcpServerDeletes()).toBeGreaterThan(0)
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'wf-run-idem-web-search-run', namespace: 'mcp-server' })
      )
      expect(store.current().status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      const afterPass1 = {
        delegation: mcpServerDeletes(),
        deployments: mockAppsApi.deleteNamespacedDeployment.mock.calls.length,
      }

      const result = await reconciler.reconcile(store.current())

      // Witness: pass 2 ran the terminal block (credentials refreshed again).
      expect(stub.ensureCoordinatorRuntimeCredentials).toHaveBeenCalledTimes(2)
      expect(result.requeueAfterMs).toBeUndefined()
      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledTimes(1)
      expect(mcpServerDeletes()).toBe(afterPass1.delegation)
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(afterPass1.deployments)
      // Inner reconcile (which creates/recreates pods) is never invoked on the terminal path.
      expect(stub.reconcile).not.toHaveBeenCalled()
    })

    it('a failed teardown step records nothing, requeues, and the next pass repeats it', async () => {
      const stub = stubWorkflowReconciler()
      stub.teardownComputePodsForTerminalRun.mockRejectedValueOnce(new Error('K8s API blip'))
      mockAppsApi.deleteNamespacedDeployment.mockRejectedValueOnce({ code: 500, message: 'boom' })
      const store = installRecipeStore(
        makeTerminalRunRecipe({ name: 'wf-run-retry', phase: 'completed', transport: true })
      )

      const first = await reconciler.reconcile(store.current())

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledTimes(1)
      expect(first.phase).toBe('active')
      expect(first.requeueAfterMs).toBe(5_000)
      expect(store.current().status?.terminalRunTeardown).toBeUndefined()

      const second = await reconciler.reconcile(store.current())

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledTimes(2)
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(2)
      expect(store.current().status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      expect(second.requeueAfterMs).toBeUndefined()
    })

    it('a record the API server pruned (older CRD) is not reported as stored', async () => {
      const stub = stubWorkflowReconciler()
      const store = installRecipeStore(
        makeTerminalRunRecipe({ name: 'wf-run-pruned', phase: 'completed' }),
        { prune: ['terminalRunTeardown'] }
      )
      const errorLog = captureLogger('error')
      const recipe = store.current()

      const result = await reconciler.reconcile(recipe)
      errorLog.mockRestore()

      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { status: { terminalRunTeardown: { completedAt: expect.any(String) } } },
        }),
        expect.anything()
      )
      const notStored = errorLog.mock.calls.find(
        ([message]) => message === 'Run status record was not stored; requeueing'
      )
      expect(notStored).toBeDefined()
      expect(String((notStored![1] as { err: Error }).err.message)).toContain(
        'workflowrecipes.clerum.io'
      )
      expect(recipe.status?.terminalRunTeardown).toBeUndefined()
      expect(result.requeueAfterMs).toBe(5_000)

      await reconciler.reconcile(store.current())

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledTimes(2)
    })

    it('clears the record (and its fact) before a latched run is deployed again', async () => {
      const stub = stubWorkflowReconciler()
      const latched = makeTerminalRunRecipe({ name: 'wf-run-latched', phase: 'failed' })
      latched.status = {
        ...latched.status,
        phase: 'failed',
        message: 'Workflow failed',
        workflowExecution: {
          phase: 'failed',
          message:
            'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
        },
        terminalRunTeardown: {
          completedAt: '2026-11-12T10:00:00.000Z',
          noSecretBearingWorkloads: true,
        },
      } as WorkflowRecipeCRD['status']
      const store = installRecipeStore(latched)
      let storedAtInnerReconcile: unknown = 'not-called'
      stub.reconcile.mockImplementation(async () => {
        storedAtInnerReconcile = store.current().status?.terminalRunTeardown
        return {
          phase: 'deploying',
          message: 'Workflow infrastructure recreated',
          workflowPhase: 'recovering',
        }
      })
      const recipe = store.current()

      await reconciler.reconcile(recipe)

      expect(stub.reconcile).toHaveBeenCalledTimes(1)
      expect(storedAtInnerReconcile).toBeUndefined()
      expect(recipe.status?.terminalRunTeardown).toBeUndefined()
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({ body: { status: { terminalRunTeardown: null } } }),
        expect.anything()
      )
      expect(stub.teardownComputePodsForTerminalRun).not.toHaveBeenCalled()
      // T4.5 — the fact went with the record: the stored object carries neither,
      // so the ownership backstop selects the re-deployed run again. (The fixture
      // has no workload; the predicate reads the stored status with one that
      // names a Secret.)
      expect(store.current().status?.terminalRunTeardown).toBeUndefined()
      expect(
        workflowNeedsOwnershipBackstop({
          ...store.current(),
          spec: { ...store.current().spec, workloads: [secretBearingApi('app-creds')] },
        })
      ).toBe(true)
    })

    it('clears the stored record when the pass runs on an object read before the run turned terminal', async () => {
      const stub = stubWorkflowReconciler()
      const recorded = makeTerminalRunRecipe({ name: 'wf-run-stale', phase: 'failed' })
      recorded.status = {
        ...recorded.status,
        terminalRunTeardown: {
          completedAt: '2026-11-12T10:00:00.000Z',
          noSecretBearingWorkloads: true,
        },
      } as WorkflowRecipeCRD['status']
      const store = installRecipeStore(recorded)
      // The object a queued pass runs on: captured while the run was still
      // initializing, so it carries no record. Only the live object has one.
      const stale = makeTerminalRunRecipe({ name: 'wf-run-stale', phase: 'failed' })
      stale.status = {
        ...stale.status,
        phase: 'deploying',
        message: 'Workflow initializing',
        workflowExecution: { phase: 'initializing' },
      } as WorkflowRecipeCRD['status']
      expect(stale.status?.terminalRunTeardown).toBeUndefined()
      expect(stale.metadata.uid).toBe(store.current().metadata.uid)
      let storedAtInnerReconcile: unknown = 'not-called'
      stub.reconcile.mockImplementation(async () => {
        storedAtInnerReconcile = store.current().status?.terminalRunTeardown
        return {
          phase: 'deploying',
          message: 'Workflow infrastructure recreated',
          workflowPhase: 'initializing',
        }
      })

      await reconciler.reconcile(stale)

      // Witness: the deploy path was entered.
      expect(stub.reconcile).toHaveBeenCalledTimes(1)
      expect(storedAtInnerReconcile).toBeUndefined()
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({ body: { status: { terminalRunTeardown: null } } }),
        expect.anything()
      )
      expect(store.current().status?.terminalRunTeardown).toBeUndefined()
      expect(stub.teardownComputePodsForTerminalRun).not.toHaveBeenCalled()
    })

    it('T-R2-3 a deploy pass creates nothing and rejects when the live read of the terminal record clear fails', async () => {
      const stub = stubWorkflowReconciler()
      const recorded = makeTerminalRunRecipe({ name: 'wf-run-read-fails', phase: 'failed' })
      recorded.status = {
        ...recorded.status,
        terminalRunTeardown: {
          completedAt: '2026-11-12T10:00:00.000Z',
          noSecretBearingWorkloads: true,
        },
      } as WorkflowRecipeCRD['status']
      const readError = { code: 503, message: 'apiserver unavailable' }
      let unavailable = true
      let readsInPass = 0
      let failedReads = 0
      const store = installRecipeStore(recorded, {
        // The API server stops answering after the pass's first recipe read (its
        // initial liveness check).
        onGet: () => {
          readsInPass += 1
          if (unavailable && readsInPass > 1) {
            failedReads += 1
            throw readError
          }
          return undefined
        },
      })
      // Captured while the run was still initializing: only the live object has
      // the record.
      const stale = makeTerminalRunRecipe({ name: 'wf-run-read-fails', phase: 'failed' })
      stale.status = {
        ...stale.status,
        phase: 'deploying',
        message: 'Workflow initializing',
        workflowExecution: { phase: 'initializing' },
      } as WorkflowRecipeCRD['status']
      const clearPatches = () =>
        mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
          ([arg]) => arg.body?.status?.terminalRunTeardown === null
        ).length
      let storedAtInnerReconcile: unknown = 'not-called'
      stub.reconcile.mockImplementation(async () => {
        storedAtInnerReconcile = store.current().status?.terminalRunTeardown
        return {
          phase: 'deploying',
          message: 'Workflow infrastructure recreated',
          workflowPhase: 'initializing',
        }
      })

      await expect(reconciler.reconcile(stale)).rejects.toBe(readError)

      // Witness: one read failed, the second of the pass.
      expect(failedReads).toBe(1)
      expect(stub.reconcile).not.toHaveBeenCalled()
      expect(clearPatches()).toBe(0)
      expect(store.current().status?.terminalRunTeardown?.completedAt).toBe(
        '2026-11-12T10:00:00.000Z'
      )

      // The API server answers again. The second recipe read of a pass is the
      // clear's: it is the last one before the clear's patch.
      unavailable = false
      readsInPass = 0
      let readsAtClearPatch: number | undefined
      const storePatch = mockCustomApi.patchNamespacedCustomObjectStatus.getMockImplementation()!
      mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(
        async (arg: { body?: { status?: { terminalRunTeardown?: unknown } } }) => {
          if (arg.body?.status?.terminalRunTeardown === null) readsAtClearPatch ??= readsInPass
          return storePatch(arg)
        }
      )

      await reconciler.reconcile(stale)

      expect(readsAtClearPatch).toBe(2)
      expect(stub.reconcile).toHaveBeenCalledTimes(1)
      expect(storedAtInnerReconcile).toBeUndefined()
    })

    it('T-R2-3b a deploy pass creates nothing and rejects when the terminal record clear cannot be patched', async () => {
      const stub = stubWorkflowReconciler()
      const recorded = makeTerminalRunRecipe({ name: 'wf-run-patch-fails', phase: 'failed' })
      recorded.status = {
        ...recorded.status,
        terminalRunTeardown: {
          completedAt: '2026-11-12T10:00:00.000Z',
          noSecretBearingWorkloads: true,
        },
      } as WorkflowRecipeCRD['status']
      const store = installRecipeStore(recorded)
      const patchError = { code: 500, message: 'apiserver boom' }
      const storePatch = mockCustomApi.patchNamespacedCustomObjectStatus.getMockImplementation()!
      let rejectedClears = 0
      mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(
        async (arg: { body?: { status?: { terminalRunTeardown?: unknown } } }) => {
          if (rejectedClears === 0 && arg.body?.status?.terminalRunTeardown === null) {
            rejectedClears += 1
            throw patchError
          }
          return storePatch(arg)
        }
      )
      const stale = makeTerminalRunRecipe({ name: 'wf-run-patch-fails', phase: 'failed' })
      stale.status = {
        ...stale.status,
        phase: 'deploying',
        message: 'Workflow initializing',
        workflowExecution: { phase: 'initializing' },
      } as WorkflowRecipeCRD['status']

      await expect(reconciler.reconcile(stale)).rejects.toBe(patchError)

      // Witness: the clear's patch was sent once and rejected.
      expect(rejectedClears).toBe(1)
      expect(stub.reconcile).not.toHaveBeenCalled()
      expect(store.current().status?.terminalRunTeardown?.completedAt).toBe(
        '2026-11-12T10:00:00.000Z'
      )

      await reconciler.reconcile(stale)

      expect(store.current().status?.terminalRunTeardown).toBeUndefined()
      expect(stub.reconcile).toHaveBeenCalledTimes(1)
    })

    for (const row of [
      {
        state: 'was replaced under the same name (another uid)',
        answer: (stored: WorkflowRecipeCRD) => {
          stored.metadata.uid = 'uid-of-the-replacement'
          return stored
        },
      },
      {
        state: 'is being deleted',
        answer: (stored: WorkflowRecipeCRD) => {
          stored.metadata.deletionTimestamp = '2026-11-16T10:00:00.000Z'
          return stored
        },
      },
    ]) {
      it(`T-R2-3c the terminal record clear removes nothing when the live recipe ${row.state}`, async () => {
        stubWorkflowReconciler()
        const latched = makeTerminalRunRecipe({ name: 'wf-run-latched-other', phase: 'failed' })
        latched.status = {
          ...latched.status,
          phase: 'failed',
          message: 'Workflow failed',
          workflowExecution: {
            phase: 'failed',
            message:
              'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
          },
          terminalRunTeardown: {
            completedAt: '2026-11-12T10:00:00.000Z',
            noSecretBearingWorkloads: true,
          },
        } as WorkflowRecipeCRD['status']
        let readsInPass = 0
        let otherAnswers = 0
        const store = installRecipeStore(latched, {
          // The pass's first recipe read sees the run; every later read sees the
          // other object.
          onGet: stored => {
            readsInPass += 1
            if (readsInPass === 1) return undefined
            otherAnswers += 1
            return row.answer(stored)
          },
        })
        const clearPatches = () =>
          mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
            ([arg]) => arg.body?.status?.terminalRunTeardown === null
          ).length
        // The pass object carries the record, as a latched run does.
        const passObject = store.current()

        await reconciler.reconcile(passObject)

        // Witness: two recipe reads, the pass's first one and the clear's own
        // read, which got the other object. The exact count also pins that no
        // recipe read follows the clear.
        expect(readsInPass).toBe(2)
        expect(otherAnswers).toBe(1)
        expect(clearPatches()).toBe(0)
        expect(store.current().status?.terminalRunTeardown?.completedAt).toBe(
          '2026-11-12T10:00:00.000Z'
        )
      })
    }

    /** A non-transport Deployment that reads `secretName` (kept by the terminal teardown). */
    function secretBearingApi(secretName: string): WorkloadDef {
      return {
        id: 'api',
        type: 'deployment',
        image: 'clerum/api:test',
        envSecret: { name: secretName, keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
      }
    }

    /** A terminal run child whose only workload reads `app-creds`, labeled for `owner`. */
    function secretBearingTerminalRun(name: string, owner: string): WorkflowRecipeCRD {
      const recipe = makeTerminalRunRecipe({ name, phase: 'completed' })
      recipe.spec.workloads = [secretBearingApi('app-creds')]
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '7', labels: { 'clerum.io/owner-recipe': owner } },
        data: { token: 'eA==' },
      })
      return recipe
    }

    it('T4.1 noSecretBearingWorkloadsRemain: true only when every Secret-bearing workload is denied and not a StatefulSet, or torn down (issue #1349)', () => {
      const transport = { type: 'streamableHttp', path: '/mcp' } as WorkloadDef['transport']
      const withWorkloads = (workloads: WorkloadDef[]) => {
        const recipe = makeTerminalRunRecipe({ name: 'wf-run-fact' })
        recipe.spec.workloads = workloads
        return recipe
      }
      const plain: WorkloadDef = { id: 'plain', type: 'deployment', image: 'clerum/plain:test' }
      const api = secretBearingApi('app-creds')
      const pullOnly: WorkloadDef = {
        id: 'pull',
        type: 'deployment',
        image: 'clerum/pull:test',
        imagePullSecrets: ['registry-creds'],
      }

      // All Secret-bearing workloads denied (a workload with no Secret does not count).
      expect(
        noSecretBearingWorkloadsRemain(
          withWorkloads([api, pullOnly, plain]),
          new Set(['api', 'pull'])
        )
      ).toBe(true)
      // One accessible (or missing: not denied) Deployment that the teardown keeps.
      expect(noSecretBearingWorkloadsRemain(withWorkloads([api, pullOnly]), new Set(['api']))).toBe(
        false
      )
      // An accessible transport Deployment is deleted by the terminal teardown.
      expect(
        noSecretBearingWorkloadsRemain(withWorkloads([{ ...api, transport }]), new Set())
      ).toBe(true)
      // A transport StatefulSet is never deleted there (#558).
      expect(
        noSecretBearingWorkloadsRemain(
          withWorkloads([{ ...api, type: 'statefulset', transport }]),
          new Set()
        )
      ).toBe(false)
      // Nor is a transport Deployment that declares volumeClaimTemplates: the
      // terminal teardown keeps it, although only a StatefulSet turns them into PVCs.
      expect(
        noSecretBearingWorkloadsRemain(
          withWorkloads([
            {
              ...api,
              transport,
              volumeClaimTemplates: [
                {
                  name: 'data',
                  storageClass: 'standard',
                  accessMode: 'ReadWriteOnce',
                  size: '1Gi',
                },
              ],
            } as WorkloadDef,
          ]),
          new Set()
        )
      ).toBe(false)
      // Issue #1349 (B-L1) — a denied workload counts only when the denial
      // teardown deletes it. A denied StatefulSet is kept and re-rendered with
      // its accessible refs, transport or not.
      expect(
        noSecretBearingWorkloadsRemain(
          withWorkloads([{ ...api, type: 'statefulset' } as WorkloadDef]),
          new Set(['api'])
        )
      ).toBe(false)
      expect(
        noSecretBearingWorkloadsRemain(
          withWorkloads([{ ...api, type: 'statefulset', transport } as WorkloadDef]),
          new Set(['api'])
        )
      ).toBe(false)
      // A denied Deployment that declares volumeClaimTemplates is deleted by it.
      expect(
        noSecretBearingWorkloadsRemain(
          withWorkloads([
            {
              ...api,
              volumeClaimTemplates: [
                {
                  name: 'data',
                  storageClass: 'standard',
                  accessMode: 'ReadWriteOnce',
                  size: '1Gi',
                },
              ],
            } as WorkloadDef,
          ]),
          new Set(['api'])
        )
      ).toBe(true)
      // A denied Deployment is deleted by it.
      expect(noSecretBearingWorkloadsRemain(withWorkloads([api]), new Set(['api']))).toBe(true)
    })

    it('T-BL1-2 the terminal pass does not record the fact for a denied StatefulSet that keeps an accessible Secret (issue #1349)', async () => {
      stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-mixed', phase: 'completed' })
      recipe.spec.workloads = [
        {
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          port: 5432,
          envSecret: { name: 'own-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          imagePullSecrets: ['foreign-pull'],
        } as WorkloadDef,
      ]
      recipe.status = {
        ...recipe.status,
        workloadInstances: { db: 'wf-run-mixed-db-live' },
      } as WorkflowRecipeCRD['status']
      // own-creds is labeled for the run (accessible); foreign-pull for another
      // recipe (denied).
      mockCoreApi.readNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => ({
        metadata: {
          resourceVersion: '7',
          labels: {
            'clerum.io/owner-recipe': name === 'own-creds' ? 'wf-run-mixed' : 'other-recipe',
          },
        },
        data: { token: 'eA==' },
      }))
      // The StatefulSet is live, rendered while both Secrets were accessible.
      const liveStatefulSet = buildStatefulSet(
        recipe.spec.workloads[0] as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map([
          ['own-creds', { state: 'accessible', keys: new Set(['token']) }],
          ['foreign-pull', { state: 'accessible', keys: new Set<string>() }],
        ])
      ).statefulSet
      await mockAppsApi.createNamespacedStatefulSet({
        namespace: recipe.metadata.namespace,
        body: liveStatefulSet,
      })
      mockAppsApi.patchNamespacedStatefulSet.mockClear()
      const store = installRecipeStore(recipe)

      await reconciler.reconcile(store.current())

      // Witness: the terminal block ran, the denied StatefulSet was re-rendered
      // and its revocation was recorded.
      expect(store.current().status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      expect(store.current().status?.secretOwnershipRevocations?.['db']).toMatch(
        /^sha256:[0-9a-f]{64}$/
      )
      // The re-rendered StatefulSet still reads own-creds, so the fact is not recorded.
      const stored = (await mockAppsApi.readNamespacedStatefulSet({
        name: liveStatefulSet.metadata!.name!,
        namespace: recipe.metadata.namespace,
      })) as k8s.V1StatefulSet
      expect(JSON.stringify(stored.spec?.template)).toContain('own-creds')
      expect(store.current().status?.terminalRunTeardown).not.toHaveProperty(
        'noSecretBearingWorkloads'
      )
      expect(noSecretBearingFactWrites()).toHaveLength(0)
      expect(workflowNeedsOwnershipBackstop(store.current())).toBe(true)
    })

    it('T4.2 the terminal pass records the no-Secret-bearing fact for a denied Deployment and not for one whose Secret is accessible (issue #1349)', async () => {
      stubWorkflowReconciler()
      vi.mocked(k8s.setHeaderMiddleware).mockClear()
      const denied = installRecipeStore(secretBearingTerminalRun('wf-run-denied', 'parent-recipe'))

      const deniedResult = await reconciler.reconcile(denied.current())

      expect(denied.current().status?.terminalRunTeardown).toEqual({
        completedAt: expect.any(String),
        noSecretBearingWorkloads: true,
      })
      expect(deniedResult.requeueAfterMs).toBeUndefined()
      // The fact is a JSON Patch that the API server applies only to a record
      // whose completedAt is the one this pass holds.
      expect(noSecretBearingFactWrites()).toEqual([
        [
          {
            op: 'test',
            path: '/status/terminalRunTeardown/completedAt',
            value: denied.current().status!.terminalRunTeardown!.completedAt,
          },
          { op: 'add', path: NO_SECRET_BEARING_FACT_PATH, value: true },
        ],
      ])
      // No StatefulSet is patched in this pass, so the only JSON Patch is the fact.
      expect(vi.mocked(k8s.setHeaderMiddleware).mock.calls).toContainEqual([
        'Content-Type',
        'application/json-patch+json',
      ])

      // Same child, but its Secret is owned by the run: accessible, so not written.
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
      mockCoreApi.readNamespacedSecret.mockClear()
      const accessible = installRecipeStore(
        secretBearingTerminalRun('wf-run-accessible', 'wf-run-accessible')
      )

      const accessibleResult = await reconciler.reconcile(accessible.current())

      // Witness: the terminal block and the enforcer ran.
      expect(accessible.current().status?.terminalRunTeardown?.completedAt).toEqual(
        expect.any(String)
      )
      expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalled()
      expect(accessible.current().status?.terminalRunTeardown).not.toHaveProperty(
        'noSecretBearingWorkloads'
      )
      expect(noSecretBearingFactWrites()).toHaveLength(0)
      expect(accessibleResult.requeueAfterMs).toBeUndefined()
    })

    it('T-BL2-3 a terminal pass whose revocation record is not stored publishes the denial and does not record the fact (issue #1349)', async () => {
      stubWorkflowReconciler()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      // app-creds is labeled for the parent recipe, so the run child is denied.
      const store = installRecipeStore(secretBearingTerminalRun('wf-run-unstored', 'parent-recipe'))
      const storePatch = mockCustomApi.patchNamespacedCustomObjectStatus.getMockImplementation()!
      mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(
        async (arg: { body?: { status?: { secretOwnershipRevocations?: object } } }) => {
          if (arg.body?.status?.secretOwnershipRevocations) {
            throw { code: 500, message: 'apiserver boom' }
          }
          return storePatch(arg)
        }
      )
      const errorLog = captureLogger('error')

      const result = await reconciler.reconcile(store.current())
      errorLog.mockRestore()

      // Witness: the terminal teardown was recorded and the Deployment delete sent.
      expect(store.current().status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      expect(
        mockAppsApi.deleteNamespacedDeployment.mock.calls.filter(([arg]) =>
          String(arg.name).includes('-api-')
        )
      ).toHaveLength(1)
      expect(
        (result.secretOwnershipConditions ?? []).find(c => c.type === 'EnvSecretOwnershipDenied')
          ?.status
      ).toBe('True')
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(store.current().status?.secretOwnershipRevocations).toBeUndefined()
      expect(store.current().status?.terminalRunTeardown).not.toHaveProperty(
        'noSecretBearingWorkloads'
      )
      expect(noSecretBearingFactWrites()).toHaveLength(0)
    })

    it('T4.6 a terminal pass whose ownership recheck is deferred does not record the fact (issue #1349)', async () => {
      stubWorkflowReconciler()
      // Its only Secret-bearing workload is a transport the terminal teardown
      // deletes, so the deferred recheck alone keeps the fact unwritten.
      const recipe = makeTerminalRunRecipe({
        name: 'wf-run-deferred',
        phase: 'completed',
        transport: true,
      })
      recipe.spec.workloads = recipe.spec.workloads!.map(w => ({
        ...w,
        envSecret: { name: 'app-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
      }))
      expect(noSecretBearingWorkloadsRemain(recipe, new Set())).toBe(true)
      const store = installRecipeStore(recipe)
      mockCoreApi.readNamespacedSecret.mockRejectedValue({ code: 500, message: 'apiserver boom' })

      const result = await reconciler.reconcile(store.current())

      expect(result.message).toContain('EnvSecretOwnershipDenied recheck deferred')
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(store.current().status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      expect(store.current().status?.terminalRunTeardown).not.toHaveProperty(
        'noSecretBearingWorkloads'
      )
    })

    // R1-L7 — the fact is added only to the record the pass saw. A pass that ran
    // on an object read before a re-deploy removed the record (or before a later
    // terminal entry wrote another one) must not leave the fact behind.
    for (const row of [
      { state: 'no record (removed by a re-deploy)', storedRecord: undefined },
      {
        state: 'the record of a later terminal entry',
        storedRecord: { completedAt: '2026-11-16T09:00:00.000Z' },
      },
    ]) {
      it(`T-R3-L7-1: a terminal pass on an older object does not add the fact when the store holds ${row.state} (issue #1349)`, async () => {
        stubWorkflowReconciler()
        // The Secret is labeled for the parent recipe, so the run child is denied
        // and its only Secret-bearing workload is deleted: the fact is due.
        const live = secretBearingTerminalRun('wf-run-stale', 'parent-recipe')
        const stale = structuredClone(live)
        stale.status = {
          ...stale.status,
          terminalRunTeardown: { completedAt: '2026-11-16T08:00:00.000Z' },
        } as WorkflowRecipeCRD['status']
        live.status = {
          ...live.status,
          ...(row.storedRecord ? { terminalRunTeardown: row.storedRecord } : {}),
        } as WorkflowRecipeCRD['status']
        const store = installRecipeStore(live)
        mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
        const errorLog = captureLogger('error')

        const result = await reconciler.reconcile(stale)
        const notStored = errorLog.mock.calls.find(
          ([message]) => message === 'Run status record was not stored; requeueing'
        )
        errorLog.mockRestore()

        // Witness: the pass sent the fact, guarded by the completedAt it holds.
        expect(noSecretBearingFactWrites()).toEqual([
          [
            {
              op: 'test',
              path: '/status/terminalRunTeardown/completedAt',
              value: '2026-11-16T08:00:00.000Z',
            },
            { op: 'add', path: NO_SECRET_BEARING_FACT_PATH, value: true },
          ],
        ])
        // The API server refused it: nothing was stored, the pass is retried.
        expect(store.current().status?.terminalRunTeardown).toEqual(row.storedRecord)
        expect(notStored).toBeDefined()
        expect((notStored![1] as { err: { code?: number } }).err.code).toBe(422)
        expect(stale.status?.terminalRunTeardown).not.toHaveProperty('noSecretBearingWorkloads')
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      })
    }

    it('a fact the API server pruned (older CRD) is not reported as stored (issue #1349, T1.8 L-1)', async () => {
      stubWorkflowReconciler()
      const store = installRecipeStore(
        secretBearingTerminalRun('wf-run-fact-pruned', 'parent-recipe'),
        {
          prune: ['terminalRunTeardown.noSecretBearingWorkloads'],
        }
      )
      const errorLog = captureLogger('error')
      const recipe = store.current()

      const result = await reconciler.reconcile(recipe)
      errorLog.mockRestore()

      // Witness: the fact was sent.
      expect(noSecretBearingFactWrites()).toHaveLength(1)
      const notStored = errorLog.mock.calls.find(
        ([message]) => message === 'Run status record was not stored; requeueing'
      )
      expect(notStored).toBeDefined()
      expect(String((notStored![1] as { err: Error }).err.message)).toContain(
        'terminalRunTeardown.noSecretBearingWorkloads'
      )
      expect(recipe.status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      expect(recipe.status?.terminalRunTeardown).not.toHaveProperty('noSecretBearingWorkloads')
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    })
  })

  it('repairs active normal DB-run workflow credentials using verified parent provenance', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: true,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'parent-recipe',
      'uid-child'
    )
  })

  it('uses the child runtime identity when the DB run does not bind the exact child', async () => {
    mockVerifyWorkflowRunProvenance.mockResolvedValue('invalid')
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: { phase: 'active' } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(mockVerifyWorkflowRunProvenance).toHaveBeenCalledWith({
      runId: 'run-child',
      parentNamespace: 'sandbox-recipes',
      parentName: 'parent-recipe',
      childNamespace: 'sandbox-recipes',
      childName: 'child-run',
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  describe('triggered-run runtime scope handed to the inner workflow reconcile', () => {
    // The inner reconciler judges snippet Secret ownership against the 7th
    // reconcile() argument (runtimeScopeRecipeName). These tests pin that WRC hands
    // it the VERIFIED parent for a run-scoped child CR, and the child name when the
    // DB run does not bind the exact parent/child pair.
    function stubInnerWorkflowReconcile() {
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure created',
        workflowPhase: 'initializing',
      })
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
      return workflowReconcile
    }

    function triggeredSnippetChild(workloads?: WorkloadDef[]): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'child-run',
          namespace: 'sandbox-recipes',
          uid: 'uid-child',
          annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
          labels: {
            'clerum.io/parent-recipe': 'parent-recipe',
            'clerum.io/workflow-run-id': 'run-child',
          },
          ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
        },
        spec: {
          ...(workloads ? { workloads } : {}),
          steps: [
            {
              id: 'triage',
              run: {
                ...snippetRun(),
                capabilities: {
                  secrets: [
                    { alias: 'github_token', secretRef: { name: 'github-token', key: 'token' } },
                  ],
                },
              },
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    }

    it('passes the verified parent recipe as the runtime scope for a triggered child CR', async () => {
      const workflowReconcile = stubInnerWorkflowReconcile()

      await reconciler.reconcile(triggeredSnippetChild())

      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      const [recipeName, , , , , , runtimeScopeRecipeName, workflowRunId] =
        workflowReconcile.mock.calls[0]
      expect(recipeName).toBe('child-run')
      expect(runtimeScopeRecipeName).toBe('parent-recipe')
      expect(workflowRunId).toBe('run-child')
    })

    it('falls back to the child name as runtime scope when the DB run does not bind the child', async () => {
      mockVerifyWorkflowRunProvenance.mockResolvedValue('invalid')
      const workflowReconcile = stubInnerWorkflowReconcile()

      await reconciler.reconcile(triggeredSnippetChild())

      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(workflowReconcile.mock.calls[0][0]).toBe('child-run')
      expect(workflowReconcile.mock.calls[0][6]).toBe('child-run')
    })

    it('pins current behaviour: workload envSecret ownership on a child CR is judged against the child name', async () => {
      // Out of scope for the snippet-secret fix (spec §3.1.1): the workload
      // envSecret gate (readReferencedSecrets → classifySecretAccess with
      // recipe.metadata.name) still keys on the CR name. A parent-owned Secret is
      // therefore denied for the child workload. Changing this is a separate decision.
      const workflowReconcile = stubInnerWorkflowReconcile()
      mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
        args.name === 'parent-creds'
          ? Promise.resolve({
              metadata: {
                resourceVersion: '1',
                labels: { 'clerum.io/owner-recipe': 'parent-recipe' },
              },
              data: { token: 'eA==' },
            })
          : Promise.resolve({ metadata: { resourceVersion: '1' } })
      )

      const result = await reconciler.reconcile(
        triggeredSnippetChild([
          {
            id: 'helper',
            type: 'deployment',
            image: 'helper:test',
            port: 8080,
            envSecret: { name: 'parent-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ])
      )

      const denied = (result.secretOwnershipConditions ?? []).find(
        condition => condition.type === 'EnvSecretOwnershipDenied'
      )
      expect(denied?.status).toBe('True')
      expect(denied?.message).toBe(
        'workload "helper": Secret(s) "parent-creds" not owned by recipe "child-run" — ' +
          'label clerum.io/shared=true or clerum.io/owner-recipe=child-run to grant access'
      )
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      // The denied workload does not stop the workflow pass itself.
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(workflowReconcile.mock.calls[0][6]).toBe('parent-recipe')
    })
  })

  it('requeues a Pending DB binding before creating or rotating workflow runtime resources', async () => {
    mockVerifyWorkflowRunProvenance.mockResolvedValue('pending')
    const ensureCoordinatorRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const refreshRuntimeHttpEgressNetworkPolicies = vi.fn().mockResolvedValue(undefined)
    const reconcileWorkflow = vi.fn().mockResolvedValue({ phase: 'active', message: 'unexpected' })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureCoordinatorRuntimeCredentials: typeof ensureCoordinatorRuntimeCredentials
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          refreshRuntimeHttpEgressNetworkPolicies: typeof refreshRuntimeHttpEgressNetworkPolicies
          reconcile: typeof reconcileWorkflow
        }
      }
    ).workflowReconciler = {
      ensureCoordinatorRuntimeCredentials,
      ensureMcpHostRuntimeCredentials,
      refreshRuntimeHttpEgressNetworkPolicies,
      reconcile: reconcileWorkflow,
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(ensureCoordinatorRuntimeCredentials).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).not.toHaveBeenCalled()
    expect(refreshRuntimeHttpEgressNetworkPolicies).not.toHaveBeenCalled()
    expect(reconcileWorkflow).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('logs an error only when the runtime HTTP egress refresh leaves a NetworkPolicy pending a retry', async () => {
    const errorLog = captureLogger('error')
    try {
      const refreshRuntimeHttpEgressNetworkPolicies = vi
        .fn()
        .mockResolvedValueOnce({ conflicts: [], retryPending: true })
        .mockResolvedValueOnce({
          conflicts: [
            { policy: 'run-recipe-snippet-runner-egress', reason: 'owner-reference-mismatch' },
          ],
          retryPending: false,
        })
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            ensureCoordinatorRuntimeCredentials: ReturnType<typeof vi.fn>
            ensureMcpHostRuntimeCredentials: ReturnType<typeof vi.fn>
            refreshRuntimeHttpEgressNetworkPolicies: typeof refreshRuntimeHttpEgressNetworkPolicies
          }
        }
      ).workflowReconciler = {
        ensureCoordinatorRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        refreshRuntimeHttpEgressNetworkPolicies,
      }
      const recipe = makeRecipe({
        metadata: { name: 'run-recipe', namespace: 'sandbox-recipes', uid: 'uid-run' },
        spec: { steps: [{ id: 'research', instruction: 'run' }] },
        status: {
          phase: 'active',
          message: 'Workflow running',
          workflowExecution: { phase: 'running' },
        } as WorkflowRecipeCRD['status'],
      })
      const pendingRetryLogs = () =>
        errorLog.mock.calls.filter(([msg]) =>
          String(msg).includes('Runtime HTTP egress refresh left a NetworkPolicy pending a retry')
        )

      await reconciler.refreshInProgressWorkflowRuntimeCredentials(recipe)

      expect(refreshRuntimeHttpEgressNetworkPolicies).toHaveBeenCalledTimes(1)
      expect(refreshRuntimeHttpEgressNetworkPolicies).toHaveBeenCalledWith(
        'sandbox-recipes',
        'run-recipe',
        'uid-run',
        recipe.spec,
        'run-recipe'
      )
      expect(pendingRetryLogs()).toHaveLength(1)

      // A conflict alone was already logged at warn by the apply; it is not an error.
      await reconciler.refreshInProgressWorkflowRuntimeCredentials(recipe)

      expect(refreshRuntimeHttpEgressNetworkPolicies).toHaveBeenCalledTimes(2)
      expect(pendingRetryLogs()).toHaveLength(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('requeues a transient DB provenance failure without downgrading to child identity', async () => {
    mockVerifyWorkflowRunProvenance.mockRejectedValue(new Error('ECONNRESET'))
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(ensureMcpHostRuntimeCredentials).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'child-run-coordinator-to-gfs',
      namespace: 'sandbox-recipes',
      body: {
        preconditions: {
          uid: 'uid-child-run-coordinator-to-gfs',
          resourceVersion: '1',
        },
      },
    })
  })

  it('does not open coordinator GFS egress while a child DB binding is Pending', async () => {
    mockVerifyWorkflowRunProvenance.mockResolvedValue('pending')
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
        gfs: { publishTargets: [{ drive: 'main', target: 'outputs' }] },
      },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('requeues a transient owner lookup failure without downgrading to child identity', async () => {
    mockCustomApi.getNamespacedCustomObject
      .mockReset()
      .mockResolvedValueOnce({ metadata: { uid: 'uid-child' } })
      .mockRejectedValueOnce({ code: 503 })
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('uses the child runtime identity when the workflow run id is missing', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: { 'clerum.io/parent-recipe': 'parent-recipe' },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: { phase: 'active' } as WorkflowRecipeCRD['status'],
    })

    const runtimeScope = await (
      reconciler as unknown as {
        workflowRuntimeScopeRecipeName: (input: WorkflowRecipeCRD) => Promise<string>
      }
    ).workflowRuntimeScopeRecipeName(recipe)

    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(runtimeScope).toBe('child-run')
  })

  it('keeps the verified parent identity when the live parent GFS changes after run creation', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { uid: 'uid-parent-recipe', resourceVersion: '1' },
      spec: {
        gfs: {
          mounts: [
            {
              drive: 'main',
              target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              scopes: ['gfs.write'],
            },
          ],
        },
      },
    })

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
        gfs: {
          mounts: [
            {
              drive: 'main',
              target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              scopes: ['gfs.read'],
            },
          ],
        },
      },
      status: { phase: 'active' } as WorkflowRecipeCRD['status'],
    })

    const runtimeScope = await (
      reconciler as unknown as {
        workflowRuntimeScopeRecipeName: (input: WorkflowRecipeCRD) => Promise<string>
      }
    ).workflowRuntimeScopeRecipeName(recipe)

    expect(mockVerifyWorkflowRunProvenance).toHaveBeenCalledWith({
      runId: 'run-child',
      parentNamespace: 'sandbox-recipes',
      parentName: 'parent-recipe',
      childNamespace: 'sandbox-recipes',
      childName: 'child-run',
    })
    expect(runtimeScope).toBe('parent-recipe')
    expect(recipe.spec.gfs?.mounts?.[0]?.scopes).toEqual(['gfs.read'])
  })

  it('does not trust forged controller ownerReferences with mismatched UIDs', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [
          {
            ...workflowRecipeOwnerRef('parent-recipe'),
            uid: 'forged-parent-uid',
          },
        ],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust controller ownerReferences whose target WorkflowRecipe is missing', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    mockCustomApi.getNamespacedCustomObject
      .mockReset()
      .mockResolvedValueOnce({ metadata: { uid: 'uid-child' } })
      .mockRejectedValueOnce({ code: 404 })

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'missing-parent',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('missing-parent')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: 'sandbox-recipes',
      plural: 'workflowrecipes',
      name: 'missing-parent',
    })
    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust controller ownerReferences whose live owner is deleting', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string }) =>
      Promise.resolve({
        metadata: {
          uid: liveWorkflowRecipeUid(name),
          deletionTimestamp: name === 'parent-recipe' ? '2026-05-06T00:00:00Z' : undefined,
          resourceVersion: '1',
          annotations: { 'clerum.io/network-ready': 'true' },
          labels: { 'clerum.io/recipe': 'test-recipe' },
        },
        spec: { mcpServers: [] },
      })
    )

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: 'sandbox-recipes',
      plural: 'workflowrecipes',
      name: 'parent-recipe',
    })
    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust WorkflowRecipe ownerReferences without a UID', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const ownerRefWithoutUid = { ...workflowRecipeOwnerRef('parent-recipe'), uid: undefined }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [ownerRefWithoutUid],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust parent-recipe labels without a controller ownerReference', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/parent-recipe': 'victim-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('binds Codex context as uncertain when parent labels are claimed without provenance', async () => {
    const setCodexReconcileContext = vi.fn()
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          setCodexReconcileContext: typeof setCodexReconcileContext
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { setCodexReconcileContext, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/parent-recipe': 'victim-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
      },
      spec: {
        agent: { provider: 'codex-subscription', model: 'gpt-5.3-codex' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(setCodexReconcileContext).toHaveBeenCalledWith({
      recipeUid: 'uid-child',
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'child-run',
      claimedParent: true,
      parentSpec: null,
      connectionKey: 'unassigned',
      grokConnectionKey: 'unassigned',
    })
  })

  it('binds the inherited parent Codex spec when child provenance is verified', async () => {
    const parentSpec = {
      agent: { provider: 'codex-subscription' as const, model: 'gpt-5.3-codex' },
      steps: [{ id: 'research', instruction: 'parent target' }],
    }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string }) =>
      Promise.resolve({
        metadata: {
          uid: liveWorkflowRecipeUid(name),
          resourceVersion: '1',
        },
        spec: name === 'parent-recipe' ? parentSpec : { mcpServers: [] },
      })
    )
    const setCodexReconcileContext = vi.fn()
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          setCodexReconcileContext: typeof setCodexReconcileContext
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { setCodexReconcileContext, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        agent: { provider: 'openai', model: 'gpt-5.4-mini' },
        steps: [{ id: 'research', instruction: 'child body must not win' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(setCodexReconcileContext).toHaveBeenCalledWith({
      recipeUid: 'uid-child',
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'parent-recipe',
      claimedParent: true,
      parentSpec,
      connectionKey: 'unassigned',
      grokConnectionKey: 'unassigned',
    })
  })

  it('binds the inherited parent Codex grant annotation to the reconcile context', async () => {
    const parentSpec = {
      agent: { provider: 'codex-subscription' as const, model: 'gpt-5.3-codex' },
      steps: [{ id: 'research', instruction: 'parent target' }],
    }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string }) =>
      Promise.resolve({
        metadata: {
          uid: liveWorkflowRecipeUid(name),
          resourceVersion: '1',
          ...(name === 'parent-recipe'
            ? { annotations: { 'clerum.io/codex-connection-ref': 'team-plus' } }
            : {}),
        },
        spec: name === 'parent-recipe' ? parentSpec : { mcpServers: [] },
      })
    )
    const setCodexReconcileContext = vi.fn()
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          setCodexReconcileContext: typeof setCodexReconcileContext
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { setCodexReconcileContext, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        agent: { provider: 'openai', model: 'gpt-5.4-mini' },
        steps: [{ id: 'research', instruction: 'child body must not win' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(setCodexReconcileContext).toHaveBeenCalledWith({
      recipeUid: 'uid-child',
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'parent-recipe',
      claimedParent: true,
      parentSpec,
      connectionKey: 'team-plus',
      grokConnectionKey: 'unassigned',
    })
  })

  it('does not inherit a parent scope on first reconcile without DB-run metadata', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: { 'clerum.io/parent-recipe': 'spoofed-parent' },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'candidate',
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    expect(reconcileWorkflow).toHaveBeenCalledWith(
      'child-run',
      'uid-child',
      'sandbox-recipes',
      expect.objectContaining({ steps: recipe.spec.steps }),
      expect.objectContaining({ workflowExecution: undefined }),
      {},
      'child-run',
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('enforces configured workflow limits before resolving step MCP servers', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
        }
        config: { workflowStepMcpServersMaxItems: number }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow }
    ;(
      reconciler as unknown as {
        config: { workflowStepMcpServersMaxItems: number }
      }
    ).config.workflowStepMcpServersMaxItems = 2

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [
            {
              id: 'research',
              instruction: 'run',
              mcpServers: ['srv0', 'srv1', 'srv2'],
            },
          ],
        },
        status: { phase: 'candidate' } as WorkflowRecipeCRD['status'],
      })
    )

    expect(result).toMatchObject({
      phase: 'failed',
      message: 'spec.steps[0].mcpServers must contain at most 2 items',
    })
    expect(reconcileWorkflow).not.toHaveBeenCalled()
  })

  it('passes workflow admin usage actor labels into the runtime reconciler', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/workflow-run-id': '00000000-0000-4000-8000-000000000123',
          'clerum.io/workflow-team-id': 'control-plane-admin-ui',
          'clerum.io/workflow-actor-id': '11111111-1111-4111-8111-111111111111',
          'clerum.io/workflow-actor-type': 'admin',
        },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'candidate',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(reconcileWorkflow).toHaveBeenCalledWith(
      'child-run',
      'uid-child',
      'sandbox-recipes',
      expect.objectContaining({ steps: recipe.spec.steps }),
      expect.objectContaining({ workflowExecution: undefined }),
      {},
      'child-run',
      '00000000-0000-4000-8000-000000000123',
      'control-plane-admin-ui',
      '11111111-1111-4111-8111-111111111111',
      'admin'
    )
  })

  it('repairs failed parent workflows without a run id as active trigger infrastructure', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      clearWorkflowExecution: true,
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: {
        name: 'e2e-parent',
        namespace: 'sandbox-recipes',
        uid: 'uid-parent',
        labels: {},
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'failed',
        workflowExecution: { phase: 'failed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      clearWorkflowExecution: true,
    })
    expect(reconcileWorkflow).toHaveBeenCalledWith(
      'e2e-parent',
      'uid-parent',
      'sandbox-recipes',
      expect.objectContaining({ steps: recipe.spec.steps }),
      expect.objectContaining({ workflowExecution: { phase: 'failed' } }),
      {},
      'e2e-parent',
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('marks running workflow infrastructure active before skipping reconcile', async () => {
    const ensureCoordinatorRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureCoordinatorRuntimeCredentials: typeof ensureCoordinatorRuntimeCredentials
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = {
      ensureCoordinatorRuntimeCredentials,
      ensureMcpHostRuntimeCredentials,
      validateWorkflowSpec: () => undefined,
    }

    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-test' },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'deploying',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: false,
    })
    expect(ensureCoordinatorRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe'
    )
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe',
      'uid-123'
    )
  })

  it('keeps active running workflows active without another status patch', async () => {
    const ensureCoordinatorRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureCoordinatorRuntimeCredentials: typeof ensureCoordinatorRuntimeCredentials
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureCoordinatorRuntimeCredentials, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-test' },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
    })
    expect(ensureCoordinatorRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe'
    )
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe',
      'uid-123'
    )
  })

  describe('steady workflow coordinator GFS NetworkPolicy convergence', () => {
    function stubSteadyWorkflowRuntime(): void {
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            ensureCoordinatorRuntimeCredentials: () => Promise<void>
            ensureMcpHostRuntimeCredentials: () => Promise<void>
          }
        }
      ).workflowReconciler = {
        ensureCoordinatorRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
      }
    }

    function activeWorkflow(
      publishTargets?: Array<{ drive: string; target: string }>
    ): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'gfs-policy-workflow',
          namespace: 'sandbox-recipes',
          uid: 'uid-gfs-policy',
          labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
        },
        spec: {
          steps: [{ id: 'publish', instruction: 'publish output' }],
          gfs: publishTargets ? { publishTargets } : undefined,
        },
        status: {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        } as WorkflowRecipeCRD['status'],
      })
    }

    // The apply reads first, so a test about creating the policy must start
    // with it absent; the global default models a converged live policy.
    function coordinatorGfsPolicyAbsent(): void {
      const base = mockNetworkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        (args: { name: string; namespace: string }) =>
          args.name === 'gfs-policy-workflow-coordinator-to-gfs'
            ? Promise.reject({ code: 404 })
            : base(args)
      )
    }

    it('creates the exact coordinator GFS policy when publishTargets become present', async () => {
      stubSteadyWorkflowRuntime()
      coordinatorGfsPolicyAbsent()
      const recipe = activeWorkflow([{ drive: 'main', target: 'published-results' }])

      const result = await reconciler.reconcile(recipe)

      expect(result).toMatchObject({
        phase: 'active',
        message: 'Workflow running',
        skipStatusPatch: true,
      })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'gfs-policy-workflow-coordinator-to-gfs',
            namespace: 'sandbox-recipes',
          }),
          spec: expect.objectContaining({
            podSelector: {
              matchLabels: {
                'clerum.io/recipe': 'gfs-policy-workflow',
                'clerum.io/component': 'workflow-coordinator',
              },
            },
            egress: [
              {
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: { 'kubernetes.io/metadata.name': 'gfs' },
                    },
                    podSelector: { matchLabels: { app: 'gfs-controller' } },
                  },
                ],
                ports: [{ port: 8087, protocol: 'TCP' }],
              },
            ],
          }),
        }),
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('deletes only the exact coordinator GFS policy when publishTargets become absent', async () => {
      stubSteadyWorkflowRuntime()

      const result = await reconciler.reconcile(activeWorkflow())

      expect(result).toMatchObject({
        phase: 'active',
        message: 'Workflow running',
        skipStatusPatch: true,
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('tolerates an already-absent coordinator GFS policy', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

      const result = await reconciler.reconcile(activeWorkflow())

      expect(result).toMatchObject({
        phase: 'active',
        message: 'Workflow running',
        skipStatusPatch: true,
      })
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('tolerates a concurrent 404 after reading the owned policy', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

      const result = await reconciler.reconcile(activeWorkflow())

      expect(result).toMatchObject({ phase: 'active', message: 'Workflow running' })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('surfaces non-404 reads without attempting a delete', async () => {
      stubSteadyWorkflowRuntime()
      const apiError = { code: 503, message: 'apiserver unavailable' }
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValueOnce(apiError)

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toBe(apiError)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses to delete an owned policy without complete live identity', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'wrc', 'clerum.io/recipe': 'gfs-policy-workflow' },
        },
      })

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toThrow(
        'live object identity is incomplete'
      )
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('surfaces non-404 revocation failures instead of reporting false convergence', async () => {
      stubSteadyWorkflowRuntime()
      const apiError = { code: 503, message: 'apiserver unavailable' }
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(apiError)

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toBe(apiError)
    })

    it.each([
      {
        branch: 'awaiting-trigger',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              triggers: { onDemand: { allowedActors: ['user'] } },
              steps: [{ id: 'publish', instruction: 'publish output' }],
            },
            status: { phase: 'active' },
          }),
        expected: {
          phase: 'active',
          message: 'Workflow trigger infrastructure registered',
          skipStatusPatch: true,
        },
      },
      {
        branch: 'terminal',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
              labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
            },
            status: {
              phase: 'active',
              message: 'Workflow completed',
              workflowExecution: { phase: 'completed' },
            } as WorkflowRecipeCRD['status'],
          }),
        expected: {
          phase: 'active',
          message: 'Workflow completed',
          skipStatusPatch: true,
        },
      },
      {
        branch: 'in-progress',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
            },
            status: {
              phase: 'deploying',
              workflowExecution: { phase: 'running' },
            } as WorkflowRecipeCRD['status'],
          }),
        expected: {
          phase: 'active',
          message: 'Workflow running',
          skipStatusPatch: false,
        },
      },
    ])('converges the absent policy without changing the $branch result', async testCase => {
      stubSteadyWorkflowRuntime()
      const workflowRuntime = (
        reconciler as unknown as {
          workflowReconciler: Record<string, unknown>
        }
      ).workflowReconciler
      workflowRuntime.teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)

      const result = await reconciler.reconcile(testCase.recipe())

      expect(result).toMatchObject(testCase.expected)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
    })

    it.each([
      {
        branch: 'awaiting-trigger',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              triggers: { onDemand: { allowedActors: ['user'] } },
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: { phase: 'active' },
          }),
      },
      {
        branch: 'terminal',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
              labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: {
              phase: 'active',
              message: 'Workflow completed',
              workflowExecution: { phase: 'completed' },
            } as WorkflowRecipeCRD['status'],
          }),
      },
      {
        branch: 'in-progress',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: {
              phase: 'deploying',
              workflowExecution: { phase: 'running' },
            } as WorkflowRecipeCRD['status'],
          }),
      },
    ])('converges the present policy before returning from $branch', async testCase => {
      stubSteadyWorkflowRuntime()
      coordinatorGfsPolicyAbsent()
      const workflowRuntime = (
        reconciler as unknown as { workflowReconciler: Record<string, unknown> }
      ).workflowReconciler
      workflowRuntime.teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)

      await reconciler.reconcile(testCase.recipe())

      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'gfs-policy-workflow-coordinator-to-gfs',
          }),
        }),
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not open coordinator GFS egress for a workflow rejected by preflight', async () => {
      stubSteadyWorkflowRuntime()
      const workflowRuntime = (
        reconciler as unknown as { workflowReconciler: Record<string, unknown> }
      ).workflowReconciler
      workflowRuntime.validateWorkflowSpec = vi.fn().mockReturnValue('invalid runtime spec')

      const result = await reconciler.reconcile(
        activeWorkflow([{ drive: 'main', target: 'published-results' }])
      )

      expect(result).toMatchObject({ phase: 'active', message: 'Workflow running' })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
    })

    it('refuses to replace a homonymous policy not owned by the exact recipe', async () => {
      stubSteadyWorkflowRuntime()
      // The read-first gate finds the homonymous policy; no create is attempted.
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          uid: 'uid-foreign-policy',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'operator', 'clerum.io/recipe': 'other-recipe' },
        },
      })

      await expect(
        reconciler.reconcile(activeWorkflow([{ drive: 'main', target: 'published-results' }]))
      ).rejects.toThrow('existing policy is not owned by WRC')
      // Witness: the gate read the policy by name before refusing it.
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
      })
      expect(
        postsOf(
          mockNetworkingApi.createNamespacedNetworkPolicy,
          'gfs-policy-workflow-coordinator-to-gfs'
        )
      ).toBe(0)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('replaces the exact owned coordinator GFS policy with its live resourceVersion', async () => {
      stubSteadyWorkflowRuntime()
      // The read-first gate finds an owned policy without the desired spec.
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          uid: 'uid-owned-policy',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'wrc', 'clerum.io/recipe': 'gfs-policy-workflow' },
        },
      })

      await reconciler.reconcile(activeWorkflow([{ drive: 'main', target: 'published-results' }]))

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '7',
          }),
        }),
      })
      expect(
        postsOf(
          mockNetworkingApi.createNamespacedNetworkPolicy,
          'gfs-policy-workflow-coordinator-to-gfs'
        )
      ).toBe(0)
    })

    describe('read-first apply of the coordinator GFS policy', () => {
      const gfsPolicyName = 'gfs-policy-workflow-coordinator-to-gfs'
      const publishTargets = [{ drive: 'main', target: 'published-results' }]

      // Stateful double for the coordinator GFS policy only; every other
      // NetworkPolicy keeps the behaviour installed by the global beforeEach.
      const installGfsPolicyStore = (seed?: k8s.V1NetworkPolicy) => {
        let live = seed ? structuredClone(seed) : undefined
        const baseRead = mockNetworkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
        const baseCreate = mockNetworkingApi.createNamespacedNetworkPolicy.getMockImplementation()!
        const baseReplace =
          mockNetworkingApi.replaceNamespacedNetworkPolicy.getMockImplementation()!
        mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
          async (args: { name: string; namespace: string }) => {
            if (args.name !== gfsPolicyName) return baseRead(args)
            if (!live) throw { code: 404 }
            return structuredClone(live)
          }
        )
        mockNetworkingApi.createNamespacedNetworkPolicy.mockImplementation(
          async (args: { namespace: string; body: k8s.V1NetworkPolicy }) => {
            if (args.body.metadata?.name !== gfsPolicyName) return baseCreate(args)
            if (live) throw { code: 409 }
            live = {
              ...structuredClone(args.body),
              metadata: { ...args.body.metadata, uid: 'uid-owned-policy', resourceVersion: '1' },
            }
            return structuredClone(live)
          }
        )
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
          async (args: { name: string; namespace: string; body: k8s.V1NetworkPolicy }) => {
            if (args.name !== gfsPolicyName) return baseReplace(args)
            if (args.body.metadata?.resourceVersion !== live?.metadata?.resourceVersion) {
              throw { code: 409 }
            }
            live = {
              ...structuredClone(args.body),
              metadata: {
                ...args.body.metadata,
                uid: 'uid-owned-policy',
                resourceVersion: String(Number(live!.metadata!.resourceVersion) + 1),
              },
            }
            return structuredClone(live)
          }
        )
        return { live: () => live }
      }
      const clearPolicyCalls = () => {
        for (const fn of [
          mockNetworkingApi.readNamespacedNetworkPolicy,
          mockNetworkingApi.createNamespacedNetworkPolicy,
          mockNetworkingApi.replaceNamespacedNetworkPolicy,
        ]) {
          fn.mockClear()
        }
      }
      // The gate read misses the policy another writer is about to create, so
      // the pass takes the POST, gets a 409 and re-reads the race winner.
      const missFirstGfsPolicyRead = () => {
        const storeRead = mockNetworkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
        let missed = false
        mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
          async (args: { name: string; namespace: string }) => {
            if (args.name === gfsPolicyName && !missed) {
              missed = true
              throw { code: 404 }
            }
            return storeRead(args)
          }
        )
      }

      it('skips the PUT when the live spec matches in apiserver key order', async () => {
        const infoLog = captureLogger('info')
        try {
          stubSteadyWorkflowRuntime()
          const desired = buildCoordinatorGfsNetworkPolicy({
            recipeName: 'gfs-policy-workflow',
            sandboxNamespace: 'sandbox-recipes',
          })
          // A real read is deserialized by client-node, which rebuilds every
          // object in its attributeTypeMap key order, not the builder's order.
          const read = ObjectSerializer.deserialize(
            JSON.parse(JSON.stringify(desired)),
            'V1NetworkPolicy',
            ''
          ) as k8s.V1NetworkPolicy
          read.metadata = { ...read.metadata, uid: 'uid-owned-policy', resourceVersion: '7' }
          expect(JSON.stringify(read.spec)).not.toBe(JSON.stringify(desired.spec))
          installGfsPolicyStore(read)
          clearPolicyCalls()

          await reconciler.reconcile(activeWorkflow(publishTargets))

          // Witness: the gate read the policy and chose the skip branch.
          expect(
            readsOf(mockNetworkingApi.readNamespacedNetworkPolicy, gfsPolicyName, 'sandbox-recipes')
          ).toBe(1)
          expect(infoLog).toHaveBeenCalledWith(
            'NetworkPolicy matches desired state; skipping update',
            { label: `NetworkPolicy "${gfsPolicyName}" in sandbox-recipes` }
          )
          expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
          expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
        } finally {
          infoLog.mockRestore()
        }
      })

      it('refuses a race winner owned elsewhere without writing it', async () => {
        stubSteadyWorkflowRuntime()
        installGfsPolicyStore({
          metadata: {
            name: gfsPolicyName,
            uid: 'uid-foreign-policy',
            resourceVersion: '7',
            labels: { 'clerum.io/managed-by': 'operator', 'clerum.io/recipe': 'other-recipe' },
          },
        })
        missFirstGfsPolicyRead()
        clearPolicyCalls()

        await expect(reconciler.reconcile(activeWorkflow(publishTargets))).rejects.toThrow(
          'existing policy is not owned by WRC'
        )

        // Witness: the gate read, the POST and the conflict re-read all ran.
        expect(
          readsOf(mockNetworkingApi.readNamespacedNetworkPolicy, gfsPolicyName, 'sandbox-recipes')
        ).toBe(2)
        expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(1)
        expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
      })

      it('sends no PUT when the race winner is the converged owned policy', async () => {
        stubSteadyWorkflowRuntime()
        const converged = buildCoordinatorGfsNetworkPolicy({
          recipeName: 'gfs-policy-workflow',
          sandboxNamespace: 'sandbox-recipes',
        })
        converged.metadata = {
          ...converged.metadata,
          uid: 'uid-owned-policy',
          resourceVersion: '7',
        }
        installGfsPolicyStore(converged)
        missFirstGfsPolicyRead()
        clearPolicyCalls()
        const infoLog = captureLogger('info')
        try {
          const result = await reconciler.reconcile(activeWorkflow(publishTargets))

          expect(result).toMatchObject({ phase: 'active', message: 'Workflow running' })
          // Witness: the gate read, the POST and the conflict re-read all ran.
          expect(
            readsOf(mockNetworkingApi.readNamespacedNetworkPolicy, gfsPolicyName, 'sandbox-recipes')
          ).toBe(2)
          expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(1)
          expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
          // The skip log is the witness that the conflict path ran; no update is claimed.
          const label = `NetworkPolicy "${gfsPolicyName}" in sandbox-recipes`
          expect(infoLog).toHaveBeenCalledWith(
            'NetworkPolicy matches desired state; skipping update',
            { label }
          )
          expect(infoLog).not.toHaveBeenCalledWith('Updated resource', { label })
        } finally {
          infoLog.mockRestore()
        }
      })

      it('sends neither POST nor PUT for a converged policy on the next pass', async () => {
        stubSteadyWorkflowRuntime()
        installGfsPolicyStore()
        await reconciler.reconcile(activeWorkflow(publishTargets))
        expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(1)
        clearPolicyCalls()

        await reconciler.reconcile(activeWorkflow(publishTargets))

        // Witness: the gate read the live policy before deciding not to write.
        expect(
          readsOf(mockNetworkingApi.readNamespacedNetworkPolicy, gfsPolicyName, 'sandbox-recipes')
        ).toBe(1)
        expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
        expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
      })

      it('replaces a live owned policy whose spec drifted, without a create probe', async () => {
        stubSteadyWorkflowRuntime()
        const drifted = buildCoordinatorGfsNetworkPolicy({
          recipeName: 'gfs-policy-workflow',
          sandboxNamespace: 'sandbox-recipes',
        })
        drifted.metadata = { ...drifted.metadata, uid: 'uid-owned-policy', resourceVersion: '7' }
        drifted.spec!.egress![0].ports = [{ port: 9999, protocol: 'TCP' }]
        const store = installGfsPolicyStore(drifted)
        clearPolicyCalls()

        await reconciler.reconcile(activeWorkflow(publishTargets))

        expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
        expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, gfsPolicyName)).toBe(1)
        expect(store.live()?.spec?.egress?.[0].ports).toEqual([{ port: 8087, protocol: 'TCP' }])
        expect(store.live()?.metadata?.resourceVersion).toBe('8')
      })

      it('refuses a homonymous policy owned elsewhere without writing it', async () => {
        stubSteadyWorkflowRuntime()
        installGfsPolicyStore({
          metadata: {
            name: gfsPolicyName,
            uid: 'uid-foreign-policy',
            resourceVersion: '7',
            labels: { 'clerum.io/managed-by': 'operator', 'clerum.io/recipe': 'other-recipe' },
          },
        })
        clearPolicyCalls()

        await expect(reconciler.reconcile(activeWorkflow(publishTargets))).rejects.toThrow(
          'existing policy is not owned by WRC'
        )

        expect(
          readsOf(mockNetworkingApi.readNamespacedNetworkPolicy, gfsPolicyName, 'sandbox-recipes')
        ).toBe(1)
        expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
        expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
      })

      it('propagates a policy read that fails with 503 instead of creating blind', async () => {
        stubSteadyWorkflowRuntime()
        installGfsPolicyStore()
        const failure = { code: 503 }
        const storeRead = mockNetworkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
        mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
          async (args: { name: string; namespace: string }) => {
            if (args.name === gfsPolicyName) throw failure
            return storeRead(args)
          }
        )
        clearPolicyCalls()

        await expect(reconciler.reconcile(activeWorkflow(publishTargets))).rejects.toBe(failure)

        // Witness: the failing read is the only call on the policy.
        expect(
          readsOf(mockNetworkingApi.readNamespacedNetworkPolicy, gfsPolicyName, 'sandbox-recipes')
        ).toBe(1)
        expect(postsOf(mockNetworkingApi.createNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
        expect(putsOf(mockNetworkingApi.replaceNamespacedNetworkPolicy, gfsPolicyName)).toBe(0)
      })
    })

    it('refuses to delete a homonymous policy not owned by the exact recipe', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          uid: 'uid-foreign-policy',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'operator', 'clerum.io/recipe': 'other-recipe' },
        },
      })

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toThrow(
        'existing policy is not owned by WRC'
      )
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('revokes stale coordinator GFS egress before returning a spec limit failure', async () => {
      const recipe = makeRecipe({
        metadata: {
          name: 'gfs-policy-workflow',
          namespace: 'sandbox-recipes',
          uid: 'uid-gfs-policy',
        },
        spec: {
          gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
          steps: [
            { id: 'duplicate', instruction: 'first' },
            { id: 'duplicate', instruction: 'second' },
          ],
        },
        status: { phase: 'active' },
      })

      const result = await reconciler.reconcile(recipe)

      expect(result).toMatchObject({ phase: 'failed' })
      expect(result.message).toContain('duplicate step id "duplicate" is not allowed')
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
    })

    it('opens coordinator GFS egress once only after a successful first deploy', async () => {
      coordinatorGfsPolicyAbsent()
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure created',
        workflowPhase: 'initializing',
      })
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await reconciler.reconcile(
        makeRecipe({
          metadata: {
            name: 'gfs-policy-workflow',
            namespace: 'sandbox-recipes',
            uid: 'uid-gfs-policy',
          },
          spec: {
            steps: [{ id: 'publish', instruction: 'publish output' }],
            gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
          },
          status: { phase: 'candidate' },
        })
      )

      expect(result).toMatchObject({ phase: 'deploying' })
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(workflowReconcile.mock.invocationCallOrder[0]).toBeLessThan(
        mockNetworkingApi.createNamespacedNetworkPolicy.mock.invocationCallOrder[0]
      )
    })

    it('does not open coordinator GFS egress when first deploy fails asynchronously', async () => {
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'failed',
        message: 'snippet Secret reference is invalid',
        workflowPhase: 'failed',
      })
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await reconciler.reconcile(
        makeRecipe({
          metadata: {
            name: 'gfs-policy-workflow',
            namespace: 'sandbox-recipes',
            uid: 'uid-gfs-policy',
          },
          spec: {
            steps: [{ id: 'publish', instruction: 'publish output' }],
            gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
          },
          status: { phase: 'candidate' },
        })
      )

      expect(result).toMatchObject({ phase: 'failed' })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it.each(['failed', 'cancelled'] as const)(
      'revokes coordinator GFS egress for a terminal %s workflow',
      async workflowPhase => {
        stubSteadyWorkflowRuntime()
        const workflowRuntime = (
          reconciler as unknown as { workflowReconciler: Record<string, unknown> }
        ).workflowReconciler
        workflowRuntime.teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)

        const result = await reconciler.reconcile(
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
              labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
            },
            spec: {
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: {
              phase: 'active',
              workflowExecution: { phase: workflowPhase },
            } as WorkflowRecipeCRD['status'],
          })
        )

        expect(result).toMatchObject({ phase: 'failed', message: `Workflow ${workflowPhase}` })
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      }
    )
  })

  it('keeps completed active workflows active when runtime credential repair fails', async () => {
    const ensureMcpHostRuntimeCredentials = vi
      .fn()
      .mockRejectedValue(new Error('control-api unavailable'))
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-test' },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: { phase: 'completed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: true,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalled()
  })

  it('patches a stale active workflow message after execution completes', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = {
      ensureMcpHostRuntimeCredentials,
      validateWorkflowSpec: () => undefined,
    }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/workflow-run-id': 'run-child',
        },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'completed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: false,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalled()
  })

  // ─── Finalizer Tests ──────────────────────────────────────────────

  it('R.8.10 — ensureFinalizer adds finalizer when not present', async () => {
    const recipe = makeRecipe()
    await reconciler.ensureFinalizer(recipe)
    expect(mockCustomApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-recipe',
        body: [{ op: 'add', path: '/metadata/finalizers', value: ['clerum.io/workload-cleanup'] }],
      })
    )
  })

  it('R.8.11 — ensureFinalizer skips if already present', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        finalizers: ['clerum.io/workload-cleanup'],
      },
    })
    await reconciler.ensureFinalizer(recipe)
    expect(mockCustomApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('R.8.12 — removeFinalizer removes the finalizer', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        finalizers: ['clerum.io/workload-cleanup'],
      },
    })
    await reconciler.removeFinalizer(recipe)
    expect(mockCustomApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-recipe',
        body: [{ op: 'remove', path: '/metadata/finalizers/0' }],
      })
    )
  })

  it('R.8.13 — removeFinalizer treats already-deleted recipes as stale cleanup', async () => {
    mockCustomApi.patchNamespacedCustomObject.mockRejectedValueOnce({ code: 404 })
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        finalizers: ['clerum.io/workload-cleanup'],
      },
    })

    await expect(reconciler.removeFinalizer(recipe)).resolves.toBeUndefined()
  })

  // ─── PVC retention annotation ─────────────────────────────────────

  it('reconcileDelete retains PVCs by default when no retention annotation is set', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it("reconcileDelete retains PVCs when retention annotation is 'retain'", async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        annotations: { 'clerum.io/pvc-retention': 'retain' },
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it("reconcileDelete deletes PVCs when retention annotation is 'delete'", async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        annotations: { 'clerum.io/pvc-retention': 'delete' },
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    // The PVC exists and is owned by this recipe (issue #571 delete-path guard reads
    // it before deleting).
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { labels: { 'clerum.io/recipe': 'test-recipe' } },
    })
    await reconciler.reconcileDelete(recipe)
    // issue #571: PVCs are deleted by their recipe-scoped physical name, not the
    // raw logical id.
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ name: resolveResourceName(recipe, 'data') })
    )
  })

  it('reconcileDelete does NOT delete a resource owned by another recipe (issue #571 Finding 3)', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        annotations: { 'clerum.io/pvc-retention': 'delete' },
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [
          { id: 'data', type: 'pvc', size: '10Gi' },
          { id: 'creds', type: 'secret', data: { k: 'v' } },
        ],
      },
    })
    // The objects at the resolved names exist but are owned by ANOTHER recipe
    // (e.g. a poisoned status.resourceInstances pointing at a foreign object).
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { labels: { 'clerum.io/recipe': 'some-other-recipe' } },
    })
    mockCoreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { labels: { 'clerum.io/recipe': 'some-other-recipe' } },
    })

    await reconciler.reconcileDelete(recipe)

    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: resolveResourceName(recipe, 'creds') })
    )
  })

  // ─── Dry-run preview mode ──────────────────────────────────────────

  it('dryRun returns candidate phase with preview workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        dryRun: true,
        workloads: [
          { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
          { id: 'worker', type: 'deployment', image: 'worker:latest' },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('candidate')
    expect(result.message).toContain('Dry-run')
    expect(result.workloadStatuses).toHaveLength(2)
    expect(result.workloadStatuses[0].phase).toBe('preview')
    expect(result.workloadStatuses[0].message).toContain('Would deploy')
  })

  it('dryRun does not create Kubernetes resources', async () => {
    const recipe = makeRecipe({
      spec: {
        dryRun: true,
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
  })

  it('workflow dryRun does not persist workload instances or create runtime resources', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow infrastructure created',
      workflowPhase: 'running',
    })
    const validateWorkflowSpec = vi.fn().mockReturnValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: typeof validateWorkflowSpec
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec }

    const recipe = makeRecipe({
      metadata: { name: 'dry-run-workflow', namespace: 'sandbox-recipes', uid: 'uid-dry-wf' },
      spec: {
        dryRun: true,
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
        steps: [{ id: 'run', run: snippetRun() }],
        gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    const workloadInstancePatches =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
        ([arg]) => arg.body?.status?.workloadInstances
      )
    expect(result.phase).toBe('candidate')
    expect(result.message).toContain('Dry-run')
    expect(workloadInstancePatches).toHaveLength(0)
    expect(validateWorkflowSpec).toHaveBeenCalled()
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('dryRun still validates that at least one workload or step is configured', async () => {
    const recipe = makeRecipe({
      spec: { dryRun: true, workloads: [] },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('at least one workload')
  })

  it('dryRun shows correct namespace per workload', async () => {
    const recipe = makeRecipe({
      spec: {
        dryRun: true,
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('candidate')
    // redis (non-MCP) → sandbox-recipes
    expect(result.workloadStatuses[0].message).toContain('sandbox-recipes')
    // mcp (MCP) → mcp-server
    expect(result.workloadStatuses[1].message).toContain('mcp-server')
  })

  // ─── includeWhen filtering ─────────────────────────────────────────

  it('workload with includeWhen=false is excluded from deployment', async () => {
    const recipe = makeRecipe({
      spec: {
        inputs: { cacheEnabled: false },
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
          {
            id: 'cache',
            type: 'deployment',
            image: 'redis:7',
            port: 6379,
            includeWhen: '{{inputs.cacheEnabled}}',
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
    // Only 'app' should be deployed, 'cache' excluded
    expect(result.workloadStatuses).toHaveLength(1)
    expect(result.workloadStatuses[0].id).toBe('app')
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
  })

  it('workload with includeWhen=true is included', async () => {
    const recipe = makeRecipe({
      spec: {
        inputs: { cacheEnabled: true },
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
          {
            id: 'cache',
            type: 'deployment',
            image: 'redis:7',
            port: 6379,
            includeWhen: '{{inputs.cacheEnabled}}',
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.workloadStatuses).toHaveLength(2)
  })

  it('all workloads excluded by includeWhen returns failed phase', async () => {
    const recipe = makeRecipe({
      spec: {
        inputs: { enabled: false },
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', includeWhen: '{{inputs.enabled}}' },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('All workloads excluded')
  })

  // ─── Issue #15 — clerum.io/mcpserver label on transport workloads ─────

  it('R.15.1 — transport workload Deployment has clerum.io/mcpserver label', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis:7-alpine',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    // Deployment metadata labels
    expect(call.body.metadata.labels['clerum.io/mcpserver']).toBe('test-recipe-redis-mcp')
    // Pod template labels (critical for NetworkPolicy podSelector)
    expect(call.body.spec.template.metadata.labels['clerum.io/mcpserver']).toBe(
      'test-recipe-redis-mcp'
    )
  })

  it('R.15.2 — non-transport workload does NOT have clerum.io/mcpserver label', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'worker', type: 'deployment', image: 'worker:latest', port: 8080 }],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.body.metadata.labels['clerum.io/mcpserver']).toBeUndefined()
    expect(call.body.spec.template.metadata.labels['clerum.io/mcpserver']).toBeUndefined()
  })

  it('R.15.3 — mixed recipe: only transport workloads get mcpserver label', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const calls = mockAppsApi.createNamespacedDeployment.mock.calls
    const redisName = resolveScopedWorkloadResourceName(recipe, 'redis')
    const redisCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === redisName
    )
    const mcpName = resolveScopedWorkloadResourceName(recipe, 'redis-mcp')
    const mcpCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === mcpName
    )
    // Non-transport: no mcpserver label
    expect(redisCall![0].body.metadata.labels['clerum.io/mcpserver']).toBeUndefined()
    // Transport: has mcpserver label
    expect(mcpCall![0].body.metadata.labels['clerum.io/mcpserver']).toBe('test-recipe-redis-mcp')
    expect(mcpCall![0].body.spec.template.metadata.labels['clerum.io/mcpserver']).toBe(
      'test-recipe-redis-mcp'
    )
  })

  it('R.15.4 — mcpserver label value matches mcpServerName() format', async () => {
    mockCustomApi.getNamespacedCustomObject.mockImplementation(
      ({ name, plural }: { name?: string; plural?: string }) => {
        if (plural === 'mcpservers') return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            uid: name === 'mcp-postgres' ? 'uid-456' : liveWorkflowRecipeUid(name),
            resourceVersion: '1',
            annotations: { 'clerum.io/network-ready': 'true' },
            labels: { 'clerum.io/recipe': name ?? 'test-recipe' },
          },
          status: {
            conditions: [{ type: 'ExternalEgressReady', status: 'True' }],
          },
          spec: { mcpServers: [] },
        })
      }
    )
    const recipe = makeRecipe({
      metadata: { name: 'mcp-postgres', namespace: 'sandbox-recipes', uid: 'uid-456' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'pg-mcp',
            type: 'deployment',
            image: 'postgres-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    // Must match format: {recipeName}-{workloadId}
    expect(call.body.metadata.labels['clerum.io/mcpserver']).toBe('mcp-postgres-pg-mcp')
  })

  // ─── resolveWorkloadResourceName: prefixed names for workflow recipes ──

  it('uses the persisted scoped workload instance on update for catalog recipes', async () => {
    // The scoped Deployment already exists with another spec-hash, so the
    // read-first gate replaces it: both the read and the PUT must target the
    // scoped name, never the bare workload id. Two reads: the gate, then the
    // replace re-reads the live resourceVersion.
    const liveScoped = {
      metadata: { resourceVersion: '4', annotations: { 'clerum.io/spec-hash': 'stale' } },
      spec: {},
    }
    mockAppsApi.readNamespacedDeployment
      .mockResolvedValueOnce(liveScoped)
      .mockResolvedValueOnce(liveScoped)

    const recipe = makeRecipe({
      metadata: { name: 'simple-recipe', namespace: 'sandbox-recipes', uid: 'uid-nw' },
      spec: {
        workloads: [
          { id: 'web-server', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 80 },
        ],
      },
      status: { phase: 'approved' },
    })
    await reconciler.reconcile(recipe)

    const expectedName = resolveScopedWorkloadResourceName(recipe, 'web-server')
    const readCall = mockAppsApi.readNamespacedDeployment.mock.calls[0][0]
    expect(readCall.name).toBe(expectedName)
    expect(readCall.name).not.toBe('web-server')
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(0)
    expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(1)
    const replaced = mockAppsApi.replaceNamespacedDeployment.mock.calls[0][0]
    expect(replaced.name).toBe(expectedName)
    expect(replaced.body.metadata.resourceVersion).toBe('4')
  })

  it('patchStatus stores terminal workflowExecution phase for pre-runtime workflow failures', async () => {
    const recipe = makeRecipe({
      spec: {
        steps: [
          {
            id: 'bad',
            run: {
              type: 'snippet',
              language: 'python' as never,
              code: 'return {}',
            },
          },
        ],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'failed',
      message: 'step "bad" snippet language must be typescript',
      workloadStatuses: [],
      workflowPhase: 'failed',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toMatchObject({
      phase: 'failed',
      message: 'step "bad" snippet language must be typescript',
    })
    expect(patch.status.workflowExecution.startedAt).toEqual(expect.any(String))
    expect(patch.status.workflowExecution.completedAt).toEqual(expect.any(String))
  })

  it('patchStatus closes initializing workflowExecution when workflow reconcile fails before runtime', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'initializing',
          startedAt: '2026-05-06T17:11:30.496Z',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'calculate', agent: { provider: 'zai', model: 'glm-4.7' } }],
      },
      status: {
        phase: 'candidate',
        workflowExecution: {
          phase: 'initializing',
          startedAt: '2026-05-06T17:11:30.496Z',
        },
      },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'failed',
      message: 'Step "calculate" references MCP server "missing-tools" not found',
      workloadStatuses: [],
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toMatchObject({
      phase: 'failed',
      message: 'Step "calculate" references MCP server "missing-tools" not found',
      startedAt: '2026-05-06T17:11:30.496Z',
    })
    expect(patch.status.workflowExecution.completedAt).toEqual(expect.any(String))
  })

  it('patchStatus preserves terminal workflowExecution detail while deriving recipe phase', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'failed',
          message: 'artifact body exceeds 8 bytes',
          startedAt: '2026-05-06T17:24:49.188Z',
          completedAt: '2026-05-06T17:25:20.005Z',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'oversized', run: snippetRun() }],
      },
      status: {
        phase: 'deploying',
        workflowExecution: {
          phase: 'failed',
          message: 'artifact body exceeds 8 bytes',
          startedAt: '2026-05-06T17:24:49.188Z',
          completedAt: '2026-05-06T17:25:20.005Z',
        },
      },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'failed',
      message: 'Workflow failed',
      workloadStatuses: [],
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.phase).toBe('failed')
    expect(patch.status.message).toBe('Workflow failed')
    expect(patch.status.workflowExecution).toBeUndefined()
  })

  it('patchStatus does not overwrite a live terminal workflowExecution with stale initializing status', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'completed',
          startedAt: '2026-05-06T16:31:46.000Z',
          completedAt: '2026-05-06T16:31:47.000Z',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }, { id: 'transform' }, { id: 'emit' }],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'deploying',
      message: 'Workflow infrastructure created (workflow-custom)',
      workloadStatuses: [],
      workflowPhase: 'initializing',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toBeUndefined()
  })

  it('patchStatus does not overwrite a live running workflowExecution with stale initializing status', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'running',
          startedAt: '2026-05-06T16:31:46.000Z',
          message: 'Workflow started',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        steps: [
          {
            id: 'query-mongo',
            run: { type: 'snippet', language: 'typescript', code: 'return {}' },
          },
        ],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'deploying',
      message: 'Workflow infrastructure created (snippet-runner)',
      workloadStatuses: [],
      workflowPhase: 'initializing',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toBeUndefined()
  })

  describe('patchStatus after the same pass counted a recovery attempt', () => {
    const passStartExecution = {
      phase: 'recovering',
      startedAt: '2026-05-06T17:11:30.496Z',
      attempt: 1,
    }
    const message =
      'Workflow output prepare pod failed before runtime pod startup; recreating it (attempt 2/3)'

    // RFC 7386, which is how the API server applies application/merge-patch+json.
    function mergePatch(target: unknown, patch: unknown): unknown {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
      const merged: Record<string, unknown> =
        target !== null && typeof target === 'object' && !Array.isArray(target)
          ? { ...(target as Record<string, unknown>) }
          : {}
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key]
        else merged[key] = mergePatch(merged[key], value)
      }
      return merged
    }

    // `recipe` is the object the pass started from. `live` is the stored object
    // after the workflow reconciler patched `attempt + 1` for the pod it is
    // replacing, earlier in the same pass.
    function passThatCountedARecovery() {
      const recipe = makeRecipe({
        spec: { steps: [{ id: 'calculate', run: snippetRun() }] },
        status: { phase: 'deploying', workflowExecution: { ...passStartExecution } },
      })
      const live = {
        metadata: { name: 'test-recipe', namespace: 'sandbox-recipes', uid: 'uid-123' },
        spec: {},
        status: mergePatch(recipe.status, {
          workflowExecution: { ...passStartExecution, phase: 'recovering', attempt: 2, message },
        }),
      }
      const storedExecution = () =>
        (
          mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.reduce(
            (status, [request]) => mergePatch(status, request.body.status),
            live.status
          ) as { workflowExecution?: Record<string, unknown> }
        ).workflowExecution
      const result = {
        phase: 'deploying' as const,
        message,
        workloadStatuses: [],
        workflowPhase: 'recovering' as const,
      }
      return { recipe, live, storedExecution, result }
    }

    it('fails the pass when the live read fails and leaves the counted attempt stored', async () => {
      const { recipe, storedExecution, result } = passThatCountedARecovery()
      const readError = Object.assign(new Error('service unavailable'), { code: 503 })
      mockCustomApi.getNamespacedCustomObject.mockRejectedValueOnce(readError)

      const outcome = await reconciler.patchStatus(recipe, result).then(
        () => 'patched',
        (error: unknown) => error
      )

      // The read of this recipe was attempted, so the pass reached the point
      // where it decides what to write.
      expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
      expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'workflowrecipes', name: 'test-recipe' })
      )
      expect(storedExecution()).toMatchObject({ phase: 'recovering', attempt: 2 })
      expect(outcome).toBe(readError)
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })

    it('builds the patch on the live execution when the read succeeds', async () => {
      const { recipe, live, storedExecution, result } = passThatCountedARecovery()
      mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce(live)

      await reconciler.patchStatus(recipe, result)

      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
      expect(patch.status.workflowExecution).toMatchObject({
        phase: 'recovering',
        attempt: 2,
        message,
      })
      expect(storedExecution()).toMatchObject({
        phase: 'recovering',
        attempt: 2,
        startedAt: passStartExecution.startedAt,
      })
    })
  })

  it('patchStatus can mark workflow infrastructure active while execution is running', async () => {
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'run', instruction: 'run' }],
      },
      status: { phase: 'deploying' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'active',
      message: 'Workflow running',
      workloadStatuses: [],
      workflowPhase: 'running',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      workflowExecution: {
        phase: 'running',
        message: 'Workflow running',
      },
    })
  })

  it('patchStatus clears stale workflowExecution for active parent recipes waiting on triggers', async () => {
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'run', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        workflowExecution: { phase: 'pending', message: 'stale pending status' },
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.patchStatus(recipe, {
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      workloadStatuses: [],
      clearWorkflowExecution: true,
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status).toMatchObject({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      workflowExecution: null,
    })
  })

  // ─── adjustManifestNamespace: cross-namespace ownerRef stripping ──

  describe('adjustManifestNamespace (cross-namespace ownerRef stripping)', () => {
    it('strips ownerReferences when targetNs differs from recipe.metadata.namespace', () => {
      const manifest = {
        metadata: {
          namespace: 'original',
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'WorkflowRecipe',
              name: 'r1',
              uid: 'abc',
            } as k8s.V1OwnerReference,
          ],
        },
        spec: {},
      }

      // recipe lives in sandbox-recipes, manifest targets mcp-server → strip
      ;(
        reconciler as unknown as {
          adjustManifestNamespace: (
            m: typeof manifest,
            targetNs: string,
            recipeNamespace: string
          ) => void
        }
      ).adjustManifestNamespace(manifest, 'mcp-server', 'sandbox-recipes')

      expect(manifest.metadata.namespace).toBe('mcp-server')
      expect(manifest.metadata.ownerReferences).toBeUndefined()
    })

    it('preserves ownerReferences when targetNs === recipe.metadata.namespace', () => {
      const manifest = {
        metadata: {
          namespace: 'original',
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'WorkflowRecipe',
              name: 'r1',
              uid: 'abc',
            } as k8s.V1OwnerReference,
          ],
        },
        spec: {},
      }

      ;(
        reconciler as unknown as {
          adjustManifestNamespace: (
            m: typeof manifest,
            targetNs: string,
            recipeNamespace: string
          ) => void
        }
      ).adjustManifestNamespace(manifest, 'sandbox-recipes', 'sandbox-recipes')

      expect(manifest.metadata.namespace).toBe('sandbox-recipes')
      expect(manifest.metadata.ownerReferences).toHaveLength(1)
    })
  })

  // ─── Webhook Gateway (W1.1) ─────────────────────────────────────────

  describe('webhook gateway', () => {
    function recipeWithWebhook(overrides?: {
      secretMissing?: boolean
      deploymentReady?: boolean
      transportOnHandler?: boolean
    }): WorkflowRecipeCRD {
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [
            overrides?.transportOnHandler
              ? {
                  id: 'handler',
                  type: 'deployment',
                  image: 'echo:1',
                  port: 8080,
                  transport: { type: 'streamableHttp' },
                }
              : { id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 },
          ],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      // Configure mocks per-test scenario.
      mockCoreApi.readNamespacedSecret.mockReset()
      if (overrides?.secretMissing) {
        const e = new Error('not found') as Error & { code: number }
        e.code = 404
        mockCoreApi.readNamespacedSecret.mockRejectedValue(e)
      } else {
        mockCoreApi.readNamespacedSecret.mockResolvedValue({
          metadata: {
            resourceVersion: '1',
            labels: { 'clerum.io/owner-recipe': 'wh-recipe' },
          },
          data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
        })
      }
      installLiveStore(
        {
          read: mockAppsApi.readNamespacedDeployment,
          create: mockAppsApi.createNamespacedDeployment,
          replace: mockAppsApi.replaceNamespacedDeployment,
        },
        { readyReplicas: overrides?.deploymentReady === false ? 0 : 1 }
      )
      return recipe
    }

    it('skips webhook reconcile when spec.webhooks is empty', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      const r = await reconciler.reconcile(makeRecipe())
      // Only the workload deployment, not the gateway deployment.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(r.webhookConditions ?? []).toHaveLength(0)
    })

    it('builds gateway Deployment + Service + ConfigMap + 3 NetworkPolicies on the happy path', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.createNamespacedService.mockClear()
      mockCoreApi.createNamespacedConfigMap.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()

      const r = await reconciler.reconcile(recipeWithWebhook())

      // 1 Deployment for the handler workload + 1 for the gateway.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(2)
      // 1 Service for the handler workload + 1 for the gateway.
      expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(2)
      // 1 ConfigMap for the gateway config.
      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1)
      // 3 NetworkPolicies (proxy ingress + handler egress + handler ingress).
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3)
      expect(r.phase).toBe('active')
      // WebhookHandlerInvalid + WebhookSecretMissing + WebhookGatewayNotReady — all False.
      const types = (r.webhookConditions ?? []).map(c => c.type)
      expect(types).toContain('WebhookHandlerInvalid')
      expect(types).toContain('WebhookSecretMissing')
      expect(types).toContain('WebhookGatewayNotReady')
      const allFalse = (r.webhookConditions ?? []).every(c => c.status === 'False')
      expect(allFalse).toBe(true)
    })

    describe('read-first apply of the gateway objects', () => {
      const ns = 'sandbox-recipes'
      const gateway = 'wf-wh-recipe-webhook-gateway'
      const gatewayConfig = 'wf-wh-recipe-webhook-gateway-config'

      // Two reconciles of the same recipe: the second must find every gateway
      // object live with the desired spec-hash and write none of them.
      const reconcileTwice = async (
        api: {
          read: ReturnType<typeof vi.fn>
          create: ReturnType<typeof vi.fn>
          replace: ReturnType<typeof vi.fn>
        },
        name: string
      ) => {
        const recipe = recipeWithWebhook()
        await reconciler.reconcile(recipe)
        expect(postsOf(api.create, name)).toBe(1)
        api.read.mockClear()
        api.create.mockClear()
        api.replace.mockClear()
        await reconciler.reconcile(recipe)
      }

      it('sends neither POST nor PUT for the unchanged gateway ConfigMap', async () => {
        const api = {
          read: mockCoreApi.readNamespacedConfigMap,
          create: mockCoreApi.createNamespacedConfigMap,
          replace: mockCoreApi.replaceNamespacedConfigMap,
        }
        await reconcileTwice(api, gatewayConfig)

        expect(readsOf(api.read, gatewayConfig, ns)).toBe(1)
        expect(postsOf(api.create, gatewayConfig)).toBe(0)
        expect(putsOf(api.replace, gatewayConfig)).toBe(0)
      })

      it('sends neither POST nor PUT for the unchanged gateway Deployment', async () => {
        const api = {
          read: mockAppsApi.readNamespacedDeployment,
          create: mockAppsApi.createNamespacedDeployment,
          replace: mockAppsApi.replaceNamespacedDeployment,
        }
        await reconcileTwice(api, gateway)

        // The readiness check reads the gateway Deployment too; the gate read
        // is the one that precedes it.
        expect(readsOf(api.read, gateway, ns)).toBe(2)
        expect(postsOf(api.create, gateway)).toBe(0)
        expect(putsOf(api.replace, gateway)).toBe(0)
      })

      it('sends neither POST nor PUT for the unchanged gateway Service', async () => {
        const api = {
          read: mockCoreApi.readNamespacedService,
          create: mockCoreApi.createNamespacedService,
          replace: mockCoreApi.replaceNamespacedService,
        }
        await reconcileTwice(api, gateway)

        expect(readsOf(api.read, gateway, ns)).toBe(1)
        expect(postsOf(api.create, gateway)).toBe(0)
        expect(putsOf(api.replace, gateway)).toBe(0)
      })

      // The gateway Service is the object whose name and spec do not depend on
      // the recipe uid (the handler names and the gateway Deployment do), so a
      // recreated recipe leaves its spec hash equal and only the owner uid moves.
      it('rewrites a hash-unchanged gateway Service whose controller ownerReference uid no longer matches the recipe', async () => {
        const api = {
          read: mockCoreApi.readNamespacedService,
          create: mockCoreApi.createNamespacedService,
          replace: mockCoreApi.replaceNamespacedService,
        }
        const clearCalls = () => {
          api.read.mockClear()
          api.create.mockClear()
          api.replace.mockClear()
        }
        const controllerUid = (body: k8s.V1Service) =>
          body.metadata?.ownerReferences?.find(ref => ref.controller)?.uid

        // recipeWithWebhook() reinstalls the Deployment store, so it is called once.
        const previous = recipeWithWebhook()
        const recreated = structuredClone(previous)
        previous.metadata.uid = 'uid-old'
        recreated.metadata.uid = 'uid-new'
        await reconciler.reconcile(previous)
        expect(postsOf(api.create, gateway)).toBe(1)
        clearCalls()

        await reconciler.reconcile(recreated)

        const puts = api.replace.mock.calls.filter(
          ([arg]) => (arg as { name: string }).name === gateway
        )
        expect(puts).toHaveLength(1)
        const body = (puts[0][0] as { body: k8s.V1Service }).body
        expect(controllerUid(body)).toBe('uid-new')
        expect(body.spec?.clusterIP).toBe(LIVE_CLUSTER_IP)
        // The gate read, then the replace read for resourceVersion and clusterIP.
        expect(readsOf(api.read, gateway, ns)).toBe(2)
        expect(postsOf(api.create, gateway)).toBe(0)
        clearCalls()

        await reconciler.reconcile(recreated)

        expect(readsOf(api.read, gateway, ns)).toBe(1)
        expect(postsOf(api.create, gateway)).toBe(0)
        expect(putsOf(api.replace, gateway)).toBe(0)
      })
    })

    it('T6 (#575) converges the 3 gateway NetworkPolicies through live reads', async () => {
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValue({ code: 404 })
      await reconciler.reconcile(recipeWithWebhook())

      const sealed = new Map<string, unknown>()
      for (const call of mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls) {
        const body = (call[0] as { body: k8s.V1NetworkPolicy }).body
        sealed.set(body.metadata!.name!, JSON.parse(JSON.stringify(body)))
      }
      // Which three, not just how many: cardinality alone stays green if a refactor
      // stops emitting gateway policies and three arrive from another family.
      expect([...sealed.keys()].sort()).toEqual([
        'allow-gateway-egress-to-handler-wf-wh-recipe',
        'allow-gateway-ingress-to-handler-wf-wh-recipe',
        'allow-webhook-proxy-ingress-wf-wh-recipe',
      ])

      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        ({ name }: { name: string }) => {
          const previous = sealed.get(name) as k8s.V1NetworkPolicy | undefined
          if (!previous) return Promise.reject({ code: 404 })
          return Promise.resolve({
            ...previous,
            metadata: { ...previous.metadata, resourceVersion: '9' },
          })
        }
      )
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockClear()
      const previousLevel = process.env.LOG_LEVEL
      process.env.LOG_LEVEL = 'info'
      const logEntries: Array<Record<string, unknown>> = []
      const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
        for (const line of text.split('\n')) {
          if (!line.startsWith('{')) continue
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.msg === 'network policy unchanged; skipping update') logEntries.push(parsed)
        }
        return true
      }) as unknown as typeof process.stdout.write)

      try {
        await reconciler.reconcile(recipeWithWebhook())

        for (const name of sealed.keys()) {
          expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
            expect.objectContaining({ name })
          )
          expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledWith(
            expect.objectContaining({ name })
          )
          expect(logEntries).toContainEqual(
            expect.objectContaining({
              policy: name,
              family: 'webhook-gateway',
              msg: 'network policy unchanged; skipping update',
            })
          )
        }
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      } finally {
        logSpy.mockRestore()
        if (previousLevel === undefined) delete process.env.LOG_LEVEL
        else process.env.LOG_LEVEL = previousLevel
      }
    })

    it('fail-closed when secretRef is missing: no gateway resources, condition set, phase degraded', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.createNamespacedService.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()

      const r = await reconciler.reconcile(recipeWithWebhook({ secretMissing: true }))

      // Workload Deployment (handler) is still created. Gateway resources are NOT.
      // We can detect this because the gateway uses createNamespacedDeployment too,
      // and the handler-only run produces exactly 1 call.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const missingCond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missingCond?.status).toBe('True')
      expect(missingCond?.message).toMatch(/fireflies-creds/)
    })

    it('fail-closed when secretRef belongs to a different recipe (cross-recipe ownership refused)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      const recipe = recipeWithWebhook()
      // Override the happy-path mock with a Secret labeled for ANOTHER recipe.
      mockCoreApi.readNamespacedSecret.mockReset()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
      })

      const r = await reconciler.reconcile(recipe)

      // Gateway not built — only the handler Deployment.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const missingCond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missingCond?.status).toBe('True')
      expect(missingCond?.message).toMatch(/not accessible/)
      expect(missingCond?.message).toMatch(/owner-recipe/)
    })

    it('fail-closed when secretRef is unlabeled (no ownership claim)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      const recipe = recipeWithWebhook()
      mockCoreApi.readNamespacedSecret.mockReset()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1' },
        data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
      })

      const r = await reconciler.reconcile(recipe)

      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(r.phase).toBe('degraded')
      const missingCond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missingCond?.status).toBe('True')
      expect(missingCond?.message).toMatch(/ownership=unlabeled/)
    })

    it('honors clerum.io/shared=true for webhook secretRef', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      const recipe = recipeWithWebhook()
      mockCoreApi.readNamespacedSecret.mockReset()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/shared': 'true' },
        },
        data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
      })

      const r = await reconciler.reconcile(recipe)

      // Handler + gateway Deployment, plus 3 gateway NetworkPolicies.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3)
      expect(r.phase).toBe('active')
    })

    it('fail-closed on W2 violation: workloadRef points at a non-deployment workload', async () => {
      // Use a statefulset (no contextRef requirements) so the rest of the
      // pipeline still passes and we exercise the W2 path cleanly.
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [{ id: 'handler', type: 'statefulset', image: 'pg:16', port: 5432 }],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      const r = await reconciler.reconcile(recipe)
      // Gateway not created.
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const cond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookHandlerInvalid')
      expect(cond?.status).toBe('True')
      expect(cond?.message).toMatch(/must be type=deployment/)
    })

    it('marks WebhookGatewayNotReady=True when Deployment has zero ready replicas', async () => {
      const r = await reconciler.reconcile(recipeWithWebhook({ deploymentReady: false }))
      const notReady = (r.webhookConditions ?? []).find(c => c.type === 'WebhookGatewayNotReady')
      expect(notReady?.status).toBe('True')
      expect(r.phase).toBe('degraded')
    })

    // ─── Phase 2: webhooks[].optional ───────────────────────────────────

    function recipeWithOptionalWebhook(overrides?: { secretMissing?: boolean }): WorkflowRecipeCRD {
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 }],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              optional: true,
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      mockCoreApi.readNamespacedSecret.mockReset()
      if (overrides?.secretMissing) {
        const e = new Error('not found') as Error & { code: number }
        e.code = 404
        mockCoreApi.readNamespacedSecret.mockRejectedValue(e)
      } else {
        mockCoreApi.readNamespacedSecret.mockResolvedValue({
          metadata: {
            resourceVersion: '1',
            labels: { 'clerum.io/owner-recipe': 'wh-recipe' },
          },
          data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
        })
      }
      installLiveStore(
        {
          read: mockAppsApi.readNamespacedDeployment,
          create: mockAppsApi.createNamespacedDeployment,
          replace: mockAppsApi.replaceNamespacedDeployment,
        },
        { readyReplicas: 1 }
      )
      return recipe
    }

    it('optional+missing webhook keeps the gateway up and emits WebhookDormant', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.createNamespacedConfigMap.mockClear()

      const r = await reconciler.reconcile(recipeWithOptionalWebhook({ secretMissing: true }))

      // Gateway IS built (handler Deployment + gateway Deployment = 2 calls).
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(2)
      // Configmap built — gateway has a dormant entry but still serves.
      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1)
      // WebhookSecretMissing stays False (no required secret missing).
      const missing = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missing?.status).toBe('False')
      // WebhookDormant is True with the dormant id in the message.
      const dormant = (r.webhookConditions ?? []).find(c => c.type === 'WebhookDormant')
      expect(dormant?.status).toBe('True')
      expect(dormant?.message).toMatch(/fireflies/)
      // Recipe reaches active despite the missing optional Secret.
      expect(r.phase).toBe('active')
    })

    it('optional+resolved webhook does not emit WebhookDormant', async () => {
      const r = await reconciler.reconcile(recipeWithOptionalWebhook({ secretMissing: false }))
      const dormant = (r.webhookConditions ?? []).find(c => c.type === 'WebhookDormant')
      expect(dormant?.status).toBe('False')
      expect(r.phase).toBe('active')
    })

    it('writes dormant: true into the gateway ConfigMap for optional+missing entries', async () => {
      mockCoreApi.createNamespacedConfigMap.mockClear()
      await reconciler.reconcile(recipeWithOptionalWebhook({ secretMissing: true }))
      const cmCall = mockCoreApi.createNamespacedConfigMap.mock.calls[0][0]
      const cm = cmCall.body as { data?: { 'config.json'?: string } }
      const config = JSON.parse(cm.data!['config.json']!)
      expect(config.webhooks.fireflies.dormant).toBe(true)
      expect(config.webhooks.fireflies.dormantSecretName).toBe('fireflies-creds')
    })

    it('required (non-optional) + missing still fails closed even alongside optional+missing', async () => {
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 }],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              optional: true,
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
            {
              id: 'stripe',
              workloadRef: 'handler',
              path: '/webhooks/stripe',
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'stripe-creds', key: 'signing-secret' },
                signatureHeader: 'Stripe-Signature',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      mockCoreApi.readNamespacedSecret.mockReset()
      const e = new Error('not found') as Error & { code: number }
      e.code = 404
      mockCoreApi.readNamespacedSecret.mockRejectedValue(e)
      mockAppsApi.createNamespacedDeployment.mockClear()

      const r = await reconciler.reconcile(recipe)
      // Required (stripe) fails closed: only handler Deployment, no gateway.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(r.phase).toBe('degraded')
      const missing = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missing?.status).toBe('True')
      expect(missing?.message).toMatch(/stripe/)
      // Optional+missing webhook does NOT appear in WebhookSecretMissing
      // (it would have been dormant if the gateway built).
      expect(missing?.message).not.toMatch(/fireflies/)
    })
  })

  // ─── envSecret optional keys (Phase 3) ──────────────────────────────────

  describe('envSecret optional keys', () => {
    beforeEach(() => {
      mockCoreApi.readNamespacedSecret.mockReset()
    })

    function recipeWithOptionalKey(): WorkflowRecipeCRD {
      return makeRecipe({
        spec: {
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.6-alpine',
              port: 8080,
              envSecret: {
                name: 'app-creds',
                keys: [
                  { secretKey: 'required-token', envVar: 'REQUIRED_TOKEN' },
                  { secretKey: 'optional-token', envVar: 'OPTIONAL_TOKEN', optional: true },
                ],
              },
            },
          ],
        },
      })
    }

    it('omits an optional env var when the Secret is missing entirely (404)', async () => {
      const err = Object.assign(new Error('not found'), {
        response: { statusCode: 404 },
        code: 404,
      })
      mockCoreApi.readNamespacedSecret.mockRejectedValue(err)

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      const names = envVars.map(e => e.name)
      expect(names).toContain('REQUIRED_TOKEN')
      expect(names).not.toContain('OPTIONAL_TOKEN')
    })

    it('omits an optional env var when the key is absent from an existing Secret', async () => {
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'test-recipe' },
        },
        data: { 'required-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{
        name: string
        valueFrom?: { secretKeyRef?: { key: string } }
      }>
      const names = envVars.map(e => e.name)
      expect(names).toContain('REQUIRED_TOKEN')
      expect(names).not.toContain('OPTIONAL_TOKEN')
      const required = envVars.find(e => e.name === 'REQUIRED_TOKEN')!
      expect(required.valueFrom?.secretKeyRef?.key).toBe('required-token')
    })

    it('projects an optional env var when the key is present in the Secret', async () => {
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'test-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      expect(envVars.map(e => e.name).sort()).toEqual(['OPTIONAL_TOKEN', 'REQUIRED_TOKEN'])
    })

    it('honors clerum.io/shared=true the same way as owner-recipe', async () => {
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1', labels: { 'clerum.io/shared': 'true' } },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      expect(envVars.map(e => e.name).sort()).toEqual(['OPTIONAL_TOKEN', 'REQUIRED_TOKEN'])
    })

    it('fails closed: does NOT render a workload whose envSecret Secret is owned by another recipe (Issue #637)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // The offending workload is not rendered — no foreign secretKeyRef reaches
      // a pod, for required OR optional mappings (the #637 fix; previously the
      // required key was still projected and the kubelet injected the credential).
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
      expect(cond?.message).toMatch(/not owned by recipe/)
    })

    it('revokes a denied StatefulSet without data loss: patches it credential-free + deletes ONLY the Pods, once per denied Secret version (Issue #637, #1349)', async () => {
      mockAppsApi.deleteNamespacedStatefulSet.mockClear()
      mockCoreApi.deleteCollectionNamespacedPod.mockClear()
      mockCoreApi.deleteNamespacedPersistentVolumeClaim.mockClear()
      // Secret exists and HAS the key, but it is owned by ANOTHER recipe → denied.
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'db-password': 'eA==' },
      })

      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'db',
              type: 'statefulset',
              image: 'postgres:16',
              port: 5432,
              envSecret: {
                name: 'db-creds',
                keys: [{ secretKey: 'db-password', envVar: 'POSTGRES_PASSWORD' }],
              },
              imagePullSecrets: ['db-pull'],
            },
          ],
        },
        // The instance name assigned when the StatefulSet was first deployed.
        status: {
          workloadInstances: { db: 'test-recipe-db-live' },
        } as unknown as WorkflowRecipeCRD['status'],
      })
      // The StatefulSet is live and was rendered while db-creds and db-pull were
      // accessible: its template carries the credential and the pull Secret.
      const liveStatefulSet = buildStatefulSet(
        recipe.spec.workloads![0] as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map([
          ['db-creds', { state: 'accessible', keys: new Set(['db-password']) }],
          ['db-pull', { state: 'accessible', keys: new Set<string>() }],
        ])
      ).statefulSet
      expect(JSON.stringify(liveStatefulSet.spec?.template)).toContain('POSTGRES_PASSWORD')
      expect(liveStatefulSet.spec?.template.spec?.imagePullSecrets).toContainEqual({
        name: 'db-pull',
      })
      const stsName = liveStatefulSet.metadata!.name!
      const storedStatefulSet = async () =>
        (await mockAppsApi.readNamespacedStatefulSet({
          name: stsName,
          namespace: recipe.metadata.namespace,
        })) as k8s.V1StatefulSet
      await mockAppsApi.createNamespacedStatefulSet({
        namespace: recipe.metadata.namespace,
        body: liveStatefulSet,
      })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      const store = installRecipeStore(recipe)
      const deniedCondition = (result: { secretOwnershipConditions?: StatusCondition[] }) =>
        (result.secretOwnershipConditions ?? []).find(c => c.type === 'EnvSecretOwnershipDenied')
          ?.status

      try {
        const first = await reconciler.reconcile(store.current())

        // The live StatefulSet is patched WITHOUT the foreign credential, not re-created...
        expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
        expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
        const patchBody = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
        expect(jsonPatchOpAt(patchBody, '/spec/template')?.op).toBe('replace')
        expect(JSON.stringify(patchBody)).not.toContain('POSTGRES_PASSWORD')
        // Issue #1349 (P-1) — the stored object, not only the request, is
        // credential-free: no foreign secretKeyRef, no denied pull Secret, and the
        // hash the patch stamped.
        const stored = await storedStatefulSet()
        const storedEnv = stored.spec!.template.spec!.containers.flatMap(c => c.env ?? [])
        expect(storedEnv.filter(e => e.valueFrom?.secretKeyRef?.name === 'db-creds')).toEqual([])
        expect(
          (stored.spec!.template.spec!.imagePullSecrets ?? []).filter(s => s.name === 'db-pull')
        ).toEqual([])
        const hashOp = (patchBody as JsonPatchOperation[]).find(operation =>
          operation.path.startsWith('/metadata/annotations')
        )
        expect(hashOp).toBeDefined()
        expect(stored.metadata?.annotations?.['clerum.io/spec-hash']).toEqual(expect.any(String))
        expect(
          hashOp!.path === '/metadata/annotations'
            ? (hashOp!.value as Record<string, string>)['clerum.io/spec-hash']
            : hashOp!.value
        ).toBe(stored.metadata?.annotations?.['clerum.io/spec-hash'])
        // ...and ONLY its managed Pods are deleted (forced restart from clean template).
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledWith(
          expect.objectContaining({ labelSelector: expect.stringMatching(/^app=/) })
        )
        expect(first.phase).toBe('degraded')
        expect(deniedCondition(first)).toBe('True')
        expect(store.current().status?.secretOwnershipRevocations?.['db']).toMatch(
          /^sha256:[0-9a-f]{64}$/
        )
        const secretReads = mockCoreApi.readNamespacedSecret.mock.calls.length
        mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()

        const second = await reconciler.reconcile(store.current())

        // Witness: pass 2 classified the Secret again.
        expect(mockCoreApi.readNamespacedSecret.mock.calls.length).toBeGreaterThan(secretReads)
        // Same denied Secret version: no second patch, no second Pod restart, no record write.
        expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(1)
        expect(
          mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
            ([arg]) => arg.body?.status?.secretOwnershipRevocations !== undefined
          )
        ).toHaveLength(0)
        expect(second.phase).toBe('degraded')
        expect(deniedCondition(second)).toBe('True')
        // Data-safe on both passes: the StatefulSet object and its PVCs survive.
        expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
        expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      } finally {
        mockCustomApi.patchNamespacedCustomObjectStatus
          .mockReset()
          .mockImplementation(echoPatchedStatus)
      }
    })

    it('T-P1-5: revokes a denied StatefulSet whose stored hash is already the desired one but whose template kept the foreign refs (issue #1349)', async () => {
      mockCoreApi.deleteCollectionNamespacedPod.mockClear()
      const denyAt = (resourceVersion: string) =>
        mockCoreApi.readNamespacedSecret.mockResolvedValue({
          metadata: { resourceVersion, labels: { 'clerum.io/owner-recipe': 'some-other-recipe' } },
          data: { 'db-password': 'eA==' },
        })
      denyAt('1')
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'db',
              type: 'statefulset',
              image: 'postgres:16',
              port: 5432,
              envSecret: {
                name: 'db-creds',
                keys: [{ secretKey: 'db-password', envVar: 'POSTGRES_PASSWORD' }],
              },
              imagePullSecrets: ['db-pull'],
            },
          ],
        },
        status: {
          workloadInstances: { db: 'test-recipe-db-live' },
        } as unknown as WorkflowRecipeCRD['status'],
      })
      const credentialed = buildStatefulSet(
        recipe.spec.workloads![0] as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map([
          ['db-creds', { state: 'accessible', keys: new Set(['db-password']) }],
          ['db-pull', { state: 'accessible', keys: new Set<string>() }],
        ])
      ).statefulSet
      const stsName = credentialed.metadata!.name!
      const namespace = recipe.metadata.namespace!
      const storedStatefulSet = async () =>
        (await mockAppsApi.readNamespacedStatefulSet({
          name: stsName,
          namespace,
        })) as k8s.V1StatefulSet
      const foreignRefs = (sts: k8s.V1StatefulSet) => ({
        env: sts
          .spec!.template.spec!.containers.flatMap(c => c.env ?? [])
          .filter(e => e.valueFrom?.secretKeyRef?.name === 'db-creds'),
        pull: (sts.spec!.template.spec!.imagePullSecrets ?? []).filter(s => s.name === 'db-pull'),
      })
      await mockAppsApi.createNamespacedStatefulSet({ namespace, body: credentialed })
      const store = installRecipeStore(recipe)
      const statefulSetPatches = () => mockAppsApi.patchNamespacedStatefulSet.mock.calls.length

      try {
        // Pass 1 revokes: credential-free template, hash H stamped, entry stored.
        await reconciler.reconcile(store.current())
        const revoked = await storedStatefulSet()
        expect(foreignRefs(revoked)).toEqual({ env: [], pull: [] })
        const hash = revoked.metadata?.annotations?.['clerum.io/spec-hash']
        expect(hash).toEqual(expect.any(String))
        const firstDigest = store.current().status?.secretOwnershipRevocations?.['db']
        expect(firstDigest).toMatch(/^sha256:/)

        // The state the old strategic-merge patch left: the foreign refs are back
        // in the stored template while the annotation still says H.
        const leftover = structuredClone(revoked)
        leftover.spec!.template = structuredClone(credentialed.spec!.template)
        await mockAppsApi.replaceNamespacedStatefulSet({
          name: stsName,
          namespace,
          body: leftover,
        })
        const reverted = await storedStatefulSet()
        expect(foreignRefs(reverted).env).toHaveLength(1)
        expect(foreignRefs(reverted).pull).toHaveLength(1)
        expect(reverted.metadata?.annotations?.['clerum.io/spec-hash']).toBe(hash)

        // Both Secrets move to a new resourceVersion: a new denial digest.
        denyAt('2')
        const patchesBefore = statefulSetPatches()

        await reconciler.reconcile(store.current())

        // Witness: pass 2 sent exactly one StatefulSet patch and restarted the Pods.
        expect(statefulSetPatches()).toBe(patchesBefore + 1)
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(2)
        const pass2Body = mockAppsApi.patchNamespacedStatefulSet.mock.calls[patchesBefore][0].body
        expect(jsonPatchOpAt(pass2Body, '/spec/template')?.op).toBe('replace')
        const corrected = await storedStatefulSet()
        expect(foreignRefs(corrected)).toEqual({ env: [], pull: [] })
        expect(corrected.metadata?.annotations?.['clerum.io/spec-hash']).toBe(hash)
        const secondDigest = store.current().status?.secretOwnershipRevocations?.['db']
        expect(secondDigest).toBe(
          deniedSecretRevocationDigest(
            ['db-creds', 'db-pull'],
            new Map([
              ['db-creds', { state: 'denied', versions: [`${namespace}/2`] }],
              ['db-pull', { state: 'denied', versions: [`${namespace}/2`] }],
            ])
          )
        )
        expect(secondDigest).not.toBe(firstDigest)

        // Pass 3, same versions: the gate skips; no patch, no Pod restart.
        const secretReads = mockCoreApi.readNamespacedSecret.mock.calls.length
        await reconciler.reconcile(store.current())
        // Witness: pass 3 classified the Secrets again.
        expect(mockCoreApi.readNamespacedSecret.mock.calls.length).toBeGreaterThan(secretReads)
        expect(statefulSetPatches()).toBe(patchesBefore + 1)
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(2)
      } finally {
        mockCustomApi.patchNamespacedCustomObjectStatus
          .mockReset()
          .mockImplementation(echoPatchedStatus)
      }
    })

    it('T-R2-8: a denied StatefulSet whose stored hash is the desired one but whose immutable fields drifted is not patched, keeps its Pods and records no revocation (issue #1349)', async () => {
      mockCoreApi.deleteCollectionNamespacedPod.mockClear()
      const denyAt = (resourceVersion: string) =>
        mockCoreApi.readNamespacedSecret.mockResolvedValue({
          metadata: { resourceVersion, labels: { 'clerum.io/owner-recipe': 'some-other-recipe' } },
          data: { 'db-password': 'eA==' },
        })
      denyAt('1')
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'db',
              type: 'statefulset',
              image: 'postgres:16',
              port: 5432,
              envSecret: {
                name: 'db-creds',
                keys: [{ secretKey: 'db-password', envVar: 'POSTGRES_PASSWORD' }],
              },
            },
          ],
        },
        status: {
          workloadInstances: { db: 'test-recipe-db-live' },
        } as unknown as WorkflowRecipeCRD['status'],
      })
      const credentialed = buildStatefulSet(
        recipe.spec.workloads![0] as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map([['db-creds', { state: 'accessible', keys: new Set(['db-password']) }]])
      ).statefulSet
      const stsName = credentialed.metadata!.name!
      const namespace = recipe.metadata.namespace!
      const storedStatefulSet = async () =>
        (await mockAppsApi.readNamespacedStatefulSet({
          name: stsName,
          namespace,
        })) as k8s.V1StatefulSet
      await mockAppsApi.createNamespacedStatefulSet({ namespace, body: credentialed })
      const store = installRecipeStore(recipe)
      const statefulSetPatches = () => mockAppsApi.patchNamespacedStatefulSet.mock.calls.length

      try {
        // Pass 1 revokes: the desired hash is stamped and the entry stored.
        await reconciler.reconcile(store.current())
        const revoked = await storedStatefulSet()
        const hash = revoked.metadata?.annotations?.['clerum.io/spec-hash']
        expect(hash).toEqual(expect.any(String))
        const firstDigest = store.current().status?.secretOwnershipRevocations?.['db']
        expect(firstDigest).toMatch(/^sha256:/)
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(1)

        // An immutable field drifts while the annotation still carries the desired hash.
        const drifted = structuredClone(revoked)
        drifted.spec!.serviceName = 'manually-mutated-headless-service'
        await mockAppsApi.replaceNamespacedStatefulSet({ name: stsName, namespace, body: drifted })
        expect((await storedStatefulSet()).metadata?.annotations?.['clerum.io/spec-hash']).toBe(
          hash
        )

        // The Secret moves to a new resourceVersion: a new denial, so the gate does not skip.
        denyAt('2')
        const patchesBefore = statefulSetPatches()
        const errorLog = captureLogger('error')

        const result = await reconciler.reconcile(store.current())
        errorLog.mockRestore()

        // Witness: the teardown ran and stopped at the immutable-drift check.
        const teardownFailure = errorLog.mock.calls.find(
          ([message]) => message === 'Teardown of denied workload failed; will requeue'
        )
        expect(teardownFailure).toBeDefined()
        expect((teardownFailure![1] as { err: Error }).err.name).toBe(
          'ImmutableStatefulSetDriftError'
        )
        expect(statefulSetPatches()).toBe(patchesBefore)
        expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(1)
        expect(store.current().status?.secretOwnershipRevocations?.['db']).toBe(firstDigest)
        expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      } finally {
        mockCustomApi.patchNamespacedCustomObjectStatus
          .mockReset()
          .mockImplementation(echoPatchedStatus)
      }
    })

    it('T-1518-3: a drift on the desired stored hash blames an outside writer and names the latest field manager of the object in the condition only (issue #1518)', async () => {
      const denyAt = (resourceVersion: string) =>
        mockCoreApi.readNamespacedSecret.mockResolvedValue({
          metadata: { resourceVersion, labels: { 'clerum.io/owner-recipe': 'some-other-recipe' } },
          data: { 'db-password': 'eA==' },
        })
      denyAt('1')
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'db',
              type: 'statefulset',
              image: 'postgres:16',
              port: 5432,
              envSecret: {
                name: 'db-creds',
                keys: [{ secretKey: 'db-password', envVar: 'POSTGRES_PASSWORD' }],
              },
            },
          ],
        },
        status: {
          workloadInstances: { db: 'test-recipe-db-live' },
        } as unknown as WorkflowRecipeCRD['status'],
      })
      const credentialed = buildStatefulSet(
        recipe.spec.workloads![0] as Parameters<typeof buildStatefulSet>[0],
        recipe,
        'minimal',
        new Map([['db-creds', { state: 'accessible', keys: new Set(['db-password']) }]])
      ).statefulSet
      const stsName = credentialed.metadata!.name!
      const namespace = recipe.metadata.namespace!
      const storedStatefulSet = async () =>
        (await mockAppsApi.readNamespacedStatefulSet({
          name: stsName,
          namespace,
        })) as k8s.V1StatefulSet
      await mockAppsApi.createNamespacedStatefulSet({ namespace, body: credentialed })
      const store = installRecipeStore(recipe)

      try {
        // Pass 1 revokes and stamps the desired hash.
        await reconciler.reconcile(store.current())
        const revoked = await storedStatefulSet()
        const hash = revoked.metadata?.annotations?.['clerum.io/spec-hash']
        expect(hash).toEqual(expect.any(String))

        // An immutable field drifts while the annotation keeps the desired hash.
        // helm and kubectl-replace share the latest object time; helm is later in
        // the list. The status subresource entry is newer and is not a writer of
        // the object.
        const t1 = new Date('2026-11-17T10:00:00Z')
        const t2 = new Date('2026-11-17T10:05:00Z')
        const t3 = new Date('2026-11-17T10:09:00Z')
        const drifted = structuredClone(revoked)
        drifted.spec!.serviceName = 'manually-mutated-headless-service'
        drifted.metadata!.managedFields = [
          { manager: 'wrc-test', operation: 'Update', time: t1 },
          { manager: 'kubectl-replace', operation: 'Update', time: t2 },
          { manager: 'helm', operation: 'Update', time: t2 },
          {
            manager: 'kube-controller-manager',
            operation: 'Update',
            subresource: 'status',
            time: t3,
          },
        ]
        await mockAppsApi.replaceNamespacedStatefulSet({ name: stsName, namespace, body: drifted })
        expect((await storedStatefulSet()).metadata?.annotations?.['clerum.io/spec-hash']).toBe(
          hash
        )

        // A new denial version, so the revocation runs again and meets the drift.
        denyAt('2')
        const errorLog = captureLogger('error')
        const result = await reconciler.reconcile(store.current())
        errorLog.mockRestore()

        const teardownFailure = errorLog.mock.calls.find(
          ([message]) => message === 'Teardown of denied workload failed; will requeue'
        )
        expect(teardownFailure).toBeDefined()
        const err = (teardownFailure![1] as { err: Error & { condition: { message: string } } }).err
        expect(err.name).toBe('ImmutableStatefulSetDriftError')
        const conditionMessage = err.condition.message
        expect(conditionMessage).toContain('The stored spec hash is the desired one')
        expect(conditionMessage).toContain('"helm"')
        expect(conditionMessage).not.toContain('"kubectl-replace"')
        expect(conditionMessage).not.toContain('kube-controller-manager')
        // Witness for the negative below: the condition of the same error names helm.
        expect(err.message).not.toContain('"helm"')
        expect(err.message).toContain('The stored spec hash is the desired one')
        // The pass publishes that condition (issue #1518).
        expect(result.workloadConditions).toContainEqual(err.condition)
      } finally {
        mockCustomApi.patchNamespacedCustomObjectStatus
          .mockReset()
          .mockImplementation(echoPatchedStatus)
      }
    })

    it('fails closed: does NOT render a workload whose envSecret Secret is unlabeled (no ownership claim) (Issue #637)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1' },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // Unlabeled in a co-tenant namespace = deny-by-default.
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
    })

    it('requeues (no silent swallow) when a denied workload teardown FAILS (Issue #637 fail-closed)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })
      // Force the denied-workload teardown to throw. Previously this was swallowed
      // (.catch(() => undefined)) with no requeue, so a foreign-credentialed pod could
      // linger until an unrelated event; now it must requeue to retry the revocation.
      const teardownSpy = vi
        .spyOn(
          reconciler as unknown as { teardownDeniedWorkload: () => Promise<void> },
          'teardownDeniedWorkload'
        )
        .mockRejectedValue(new Error('apiserver 500 during teardown'))

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // The denied workload is still not rendered and the condition is still accurate...
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
      // ...but the failed teardown now forces a requeue instead of being dropped.
      expect(r.requeueAfterMs).toBeGreaterThan(0)

      teardownSpy.mockRestore()
    })

    it('CRITICAL: a denied DEPLOYMENT whose underlying delete fails non-404 requeues — the revocation teardown must NOT go through the swallowing safeDelete (Issue #637 fail-open)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })
      // Unlike the test above (which spies teardownDeniedWorkload and so bypasses the
      // real delete), this mocks the UNDERLYING Deployment delete to fail with a non-404.
      // Before the fix, deleteWorkload→safeDelete SWALLOWED non-404 → teardownDeniedWorkload
      // returned normally → no requeue, and a false EnvSecretOwnershipDenied=True was
      // written while the old foreign-credentialed pod stayed live (fail-open). Now the
      // revocation path uses the throwing variant, so the failure propagates and requeues.
      mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
        code: 500,
        message: 'apiserver 500',
      })

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // The foreign credential is never rendered into a new pod...
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      // ...the teardown delete WAS attempted (and failed non-404)...
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
      // ...and its failure now drives a requeue (was undefined before the fix, because
      // safeDelete swallowed the non-404 so teardownDeniedWorkload returned normally).
      expect(r.requeueAfterMs).toBeGreaterThan(0)

      // Restore the shared delete mock so this failure injection does not leak into a
      // later test that relies on deleteNamespacedDeployment succeeding.
      mockAppsApi.deleteNamespacedDeployment.mockResolvedValue({})
    })

    it('a denied Job and CronJob revocation deletes with Background propagation so their running pods are reaped, not orphaned (Issue #637)', async () => {
      mockBatchApi.deleteNamespacedJob.mockClear()
      mockBatchApi.deleteNamespacedCronJob.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==' },
      })
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'batch',
              type: 'job',
              image: 'batch:test',
              envSecret: {
                name: 'creds',
                keys: [{ secretKey: 'required-token', envVar: 'TOKEN' }],
              },
            },
            {
              id: 'sched',
              type: 'cronjob',
              image: 'batch:test',
              schedule: '0 0 * * *',
              envSecret: {
                name: 'creds',
                keys: [{ secretKey: 'required-token', envVar: 'TOKEN' }],
              },
            },
          ],
        },
      })

      await reconciler.reconcile(recipe)

      // The denied Job/CronJob teardown (revocation path, throwOnError) must delete with
      // Background propagation so the apiserver reaps the running (foreign-credentialed)
      // pods instead of orphaning them (the apiserver default for a Job is Orphan).
      // Removing propagationPolicy from the job/cronjob branch of deleteWorkload makes
      // this red — closing the gap that the finalizer-only CronJob test left (no Job
      // assertion, and only on the non-revocation path).
      expect(mockBatchApi.deleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ propagationPolicy: 'Background' })
      )
      expect(mockBatchApi.deleteNamespacedCronJob).toHaveBeenCalledWith(
        expect.objectContaining({ propagationPolicy: 'Background' })
      )
    })

    it('fails closed on the CROSS-NAMESPACE first-wins bypass: a transport workload listed first must not mask a foreign Secret in a non-transport workload (Issue #637, @claude review)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      // The SAME Secret name resolves to two namespaces: the transport workload
      // (listed FIRST) reads it in mcp-server where the attacker never created it
      // (404 → missing); the non-transport workload reads it in sandbox-recipes
      // where it EXISTS and is owned by another recipe (denied). A first-wins
      // name→namespace map would classify only mcp-server (missing) and render the
      // non-transport pod with the foreign secretKeyRef. Worst-wins combine must
      // make the verdict denied.
      mockCoreApi.readNamespacedSecret.mockImplementation((args: { namespace: string }) =>
        args.namespace === 'mcp-server'
          ? Promise.reject({ code: 404 })
          : Promise.resolve({
              metadata: {
                resourceVersion: '1',
                labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
              },
              data: { k: 'eA==' },
            })
      )

      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'mcp',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              envSecret: { name: 'shared-name', keys: [{ secretKey: 'k', envVar: 'TOKEN' }] },
            },
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.6-alpine',
              port: 8080,
              envSecret: { name: 'shared-name', keys: [{ secretKey: 'k', envVar: 'STOLEN' }] },
            },
          ],
        },
      })

      const r = await reconciler.reconcile(recipe)

      // The non-transport 'app' pod must NOT be rendered with the foreign credential.
      const appDeploys = mockAppsApi.createNamespacedDeployment.mock.calls.filter(
        ([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'app'
      )
      expect(appDeploys).toHaveLength(0)
      expect(r.phase).toBe('degraded')
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
    })

    it('projects a required envSecret key when the Secret is owned by this recipe', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      const recipe = recipeWithOptionalKey()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': recipe.metadata.name },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipe)

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      const names = envVars.map(e => e.name)
      expect(names).toContain('REQUIRED_TOKEN')
      expect(names).toContain('OPTIONAL_TOKEN')
    })

    it('projects a required envSecret key from a shared Secret (clerum.io/shared=true)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1', labels: { 'clerum.io/shared': 'true' } },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      expect(envVars.map(e => e.name)).toContain('REQUIRED_TOKEN')
    })

    it('still projects a required (non-optional) env var even when the Secret is missing — kubelet fails the pod', async () => {
      const err = Object.assign(new Error('not found'), {
        response: { statusCode: 404 },
        code: 404,
      })
      mockCoreApi.readNamespacedSecret.mockRejectedValue(err)

      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.6-alpine',
              port: 8080,
              envSecret: {
                name: 'app-creds',
                keys: [{ secretKey: 'k', envVar: 'K' }],
              },
            },
          ],
        },
      })
      await reconciler.reconcile(recipe)

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{
        name: string
        valueFrom?: { secretKeyRef?: { name: string; key: string } }
      }>
      expect(envVars).toHaveLength(1)
      expect(envVars[0].valueFrom?.secretKeyRef).toEqual({ name: 'app-creds', key: 'k' })
    })
  })

  // ─── oauthClientRefs admission-time validation ─────────────────────────
  describe('oauthClientRefs validation', () => {
    function recipeWithRef(
      refs: string[],
      overrides?: {
        clients?: NonNullable<WorkflowRecipeCRD['spec']['oauthClients']>
        transport?: { type: 'streamableHttp' }
        ui?: WorkflowRecipeCRD['spec']['ui']
        workloadId?: string
      }
    ): WorkflowRecipeCRD {
      const workloadId = overrides?.workloadId ?? 'app'
      return makeRecipe({
        spec: {
          ...(overrides?.ui ? { ui: overrides.ui } : {}),
          workloads: [
            {
              id: workloadId,
              type: 'deployment',
              image: 'nginx:1.30.6-alpine',
              port: 8080,
              oauthClientRefs: refs,
              ...(overrides?.transport
                ? { transport: overrides.transport, contextRef: 'ctx' as never }
                : {}),
            },
          ],
          oauthClients: overrides?.clients,
          ...(overrides?.transport ? { contextRef: 'default' } : {}),
        },
      })
    }

    it('rejects an oauthClientRefs entry that names no spec.oauthClients[].id', async () => {
      const recipe = recipeWithRef(['ghost'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/oauthClientRefs/)
      expect(result.message).toMatch(/"ghost"/)
      expect(result.message).toMatch(/does not reference any spec\.oauthClients/)
    })

    it('rejects an oauthClientRefs entry pointing at a non-backgroundAccess client', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            // backgroundAccess omitted — defaults to undefined/false
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/oauthClientRefs/)
      expect(result.message).toMatch(/"sf"/)
      expect(result.message).toMatch(/backgroundAccess: true/)
    })

    it('rejects a duplicate id within oauthClientRefs', async () => {
      const recipe = recipeWithRef(['sf', 'sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/duplicate id "sf"/)
    })

    it('rejects oauthClientRefs on an MCP transport workload', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
        transport: { type: 'streamableHttp' },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/transport \(MCP\)/)
    })

    it('rejects oauthClientRefs on the UI workload', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
        workloadId: 'ui-app',
        ui: { workloadRef: 'ui-app', port: 8080 },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/UI workload/)
    })

    it('accepts a workload whose oauthClientRefs all resolve to backgroundAccess clients', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      // No validateSpec throw → phase is whatever the workload deploy yields.
      // The point of this test is to assert NOT failed-from-validation.
      expect(result.phase).not.toBe('failed')
    })
  })

  describe('B3(a)(b) oauth-broker delete-on-transition ledger', () => {
    const SECRET_NAME = 'wf-test-recipe-oauth-broker-token'
    const POLICY_NAME = 'wf-test-recipe-oauth-broker-egress'

    function reapRecipe(generation: number): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          generation,
        },
      })
    }

    function secretDeletes(): number {
      return mockCoreApi.deleteNamespacedSecret.mock.calls.filter(
        ([arg]) => arg.name === SECRET_NAME
      ).length
    }

    function policyDeletes(): number {
      return mockNetworkingApi.deleteNamespacedNetworkPolicy.mock.calls.filter(
        ([arg]) => arg.name === POLICY_NAME
      ).length
    }

    async function reapPolicy(recipe: WorkflowRecipeCRD): Promise<void> {
      await (
        reconciler as unknown as {
          reconcileOAuthBrokerEgressPolicy: (next: WorkflowRecipeCRD) => Promise<void>
        }
      ).reconcileOAuthBrokerEgressPolicy(recipe)
    }

    /**
     * The Secret watch observed the recipe's token (an ADDED, or the relist
     * that replays one). The Secret-side cases start here: without it the
     * ledger reaps nothing, so a skipped DELETE would prove nothing.
     */
    function tokenSeen(recipeName = 'test-recipe'): void {
      reconciler.invalidateOAuthBrokerSecretLedger(recipeName)
    }

    it('deletes the Secret once for the same generation and logs the skip', async () => {
      const recipe = reapRecipe(4)
      tokenSeen()
      const debugSpy = captureLogger('debug')

      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)

      expect(secretDeletes()).toBe(1)
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping oauth-broker-token delete'),
        expect.objectContaining({ recipe: 'test-recipe', generation: 4 })
      )
      debugSpy.mockRestore()
    })

    it('deletes the Secret again when metadata.generation changes', async () => {
      tokenSeen()
      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(4))
      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(4))
      expect(secretDeletes()).toBe(1)

      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(5))
      expect(secretDeletes()).toBe(2)
    })

    it('a new process sends no token DELETE until the watch replays the token ADDED, then one', async () => {
      tokenSeen()
      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(4))
      expect(secretDeletes()).toBe(1)

      const next = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
        verifyWorkflowRunProvenance: mockVerifyWorkflowRunProvenance,
      })
      await next.ensureOAuthBrokerTokenSecret(reapRecipe(4))
      expect(secretDeletes()).toBe(1)

      // The Secret watch's initial list replays ADDED for a token that exists.
      next.invalidateOAuthBrokerSecretLedger('test-recipe')
      await next.ensureOAuthBrokerTokenSecret(reapRecipe(4))
      expect(secretDeletes()).toBe(2)
    })

    it('deletes the Secret again after ADDED invalidation', async () => {
      const recipe = reapRecipe(4)
      tokenSeen()
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(1)

      reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(2)
    })

    it('ADDED invalidation re-arms the Secret delete but keeps the NetworkPolicy TTL', async () => {
      const recipe = reapRecipe(4)
      tokenSeen()
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      await reapPolicy(recipe)
      expect(secretDeletes()).toBe(1)
      expect(policyDeletes()).toBe(1)

      reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      await reapPolicy(recipe)
      expect(secretDeletes()).toBe(2)
      expect(policyDeletes()).toBe(1)
    })

    function recreatedRecipe(): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-recreated',
          generation: 1,
        },
      })
    }

    /** Fails only the token Secret DELETE; every other Secret DELETE succeeds. */
    function failTokenDelete(code: number): void {
      mockCoreApi.deleteNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => {
        if (name === SECRET_NAME) throw { code }
        return {}
      })
    }

    it.each(['2xx', '404'] as const)(
      'R5-L6: after the finalizer observed token %s, a recreated recipe sends no DELETE until a new token ADDED, then even below the old watermark',
      async outcome => {
        const recipe = reapRecipe(4)
        tokenSeen()
        await reconciler.ensureOAuthBrokerTokenSecret(recipe)
        await reconciler.ensureOAuthBrokerTokenSecret(recipe)
        expect(secretDeletes()).toBe(1)

        if (outcome === '404') failTokenDelete(404)
        try {
          await reconciler.reconcileDelete(recipe)
        } finally {
          mockCoreApi.deleteNamespacedSecret.mockResolvedValue({})
        }
        // The real finalizer sent the token DELETE and mapped its observed result.
        expect(secretDeletes()).toBe(2)
        mockCoreApi.deleteNamespacedSecret.mockClear()

        const debugSpy = captureLogger('debug')
        try {
          await reconciler.ensureOAuthBrokerTokenSecret(recreatedRecipe())
          await reconciler.ensureOAuthBrokerTokenSecret(recreatedRecipe())
          expect(secretDeletes()).toBe(0)
          // Liveness witness: both passes reached the ledger and it declined.
          expect(
            debugSpy.mock.calls.filter(
              ([message, fields]) =>
                typeof message === 'string' &&
                message.startsWith('Skipping oauth-broker-token delete') &&
                (fields as { generation?: number }).generation === 1
            )
          ).toHaveLength(2)
        } finally {
          debugSpy.mockRestore()
        }

        // A token ADDED for a recipe under the same name: the old watermark is
        // gone, so a lower generation deletes.
        tokenSeen()
        await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(3))
        expect(secretDeletes()).toBe(1)
      }
    )

    it('R4-L1/R5-L7: a failed finalizer token DELETE preserves its error object and keeps the token seen', async () => {
      tokenSeen()
      const error = { code: 500, message: 'delete failed' }
      const errorLog = captureLogger('error')
      mockCoreApi.deleteNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => {
        if (name === SECRET_NAME) throw error
        return {}
      })
      try {
        await reconciler.reconcileDelete(reapRecipe(4))
        // Witness: the finalizer sent the token DELETE and it failed.
        expect(secretDeletes()).toBe(1)
        expect(errorLog).toHaveBeenCalledWith('Failed to delete resource', {
          label: `Secret "${SECRET_NAME}" in sandbox-recipes`,
          err: error,
        })
        const failure = errorLog.mock.calls.find(
          ([message]) => message === 'Failed to delete resource'
        )
        expect((failure?.[1] as { err?: unknown }).err).toBe(error)
      } finally {
        mockCoreApi.deleteNamespacedSecret.mockResolvedValue({})
        errorLog.mockRestore()
      }
      mockCoreApi.deleteNamespacedSecret.mockClear()

      // The recipe is recreated under the same name without backgroundAccess.
      await reconciler.ensureOAuthBrokerTokenSecret(recreatedRecipe())
      await reconciler.ensureOAuthBrokerTokenSecret(recreatedRecipe())
      expect(secretDeletes()).toBe(1)
    })

    it('R4-L1: a token ADDED while the finalizer DELETE is in flight keeps the token seen', async () => {
      tokenSeen()
      mockCoreApi.deleteNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => {
        // A late ADDED delivery (or a restart's relist) was handled before the
        // finalizer's DELETE returned; it does not imply a concurrent CR recreation.
        if (name === SECRET_NAME) reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
        return {}
      })
      try {
        await reconciler.reconcileDelete(reapRecipe(4))
        // Witness: the finalizer sent the token DELETE.
        expect(secretDeletes()).toBe(1)
      } finally {
        mockCoreApi.deleteNamespacedSecret.mockResolvedValue({})
      }
      mockCoreApi.deleteNamespacedSecret.mockClear()

      await reconciler.ensureOAuthBrokerTokenSecret(recreatedRecipe())
      await reconciler.ensureOAuthBrokerTokenSecret(recreatedRecipe())
      expect(secretDeletes()).toBe(1)
    })

    it('G3: does not record a Secret delete after DELETE 403 or 500', async () => {
      const recipe = reapRecipe(4)
      tokenSeen()
      mockCoreApi.deleteNamespacedSecret.mockRejectedValue({ code: 403 })
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(2)

      mockCoreApi.deleteNamespacedSecret.mockRejectedValue({ code: 500 })
      mockCoreApi.deleteNamespacedSecret.mockClear()
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(2)
      mockCoreApi.deleteNamespacedSecret.mockResolvedValue({})
    })

    it('G3: records a Secret delete after DELETE 404 and skips the next same-generation call', async () => {
      mockCoreApi.deleteNamespacedSecret.mockRejectedValue({ code: 404 })
      const recipe = reapRecipe(7)
      tokenSeen()
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(1)
      mockCoreApi.deleteNamespacedSecret.mockResolvedValue({})
    })

    it('G3: does not start the NP TTL after DELETE 403', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'))
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValue({ code: 403 })
      const recipe = reapRecipe(4)
      await reapPolicy(recipe)
      await reapPolicy(recipe)
      expect(policyDeletes()).toBe(2)
      vi.setSystemTime(new Date('2026-09-25T01:00:00.000Z'))
      await reapPolicy(recipe)
      expect(policyDeletes()).toBe(3)
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockResolvedValue({})
      vi.useRealTimers()
    })

    it('c3: deletes the NetworkPolicy again when metadata.generation changes', async () => {
      await reapPolicy(reapRecipe(4))
      await reapPolicy(reapRecipe(4))
      expect(policyDeletes()).toBe(1)
      await reapPolicy(reapRecipe(5))
      expect(policyDeletes()).toBe(2)
    })

    it('c3: a recorded delete for one recipe does not skip another recipe', async () => {
      tokenSeen()
      tokenSeen('other-recipe')
      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(0))
      // Liveness witness: the first recipe's delete really ran.
      expect(secretDeletes()).toBe(1)
      const other = makeRecipe({
        metadata: {
          name: 'other-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-other',
        },
      })
      await reconciler.ensureOAuthBrokerTokenSecret(other)
      expect(
        mockCoreApi.deleteNamespacedSecret.mock.calls.filter(
          ([arg]) => arg.name === 'wf-other-recipe-oauth-broker-token'
        )
      ).toHaveLength(1)
    })

    it('R4-L2: deletes the NetworkPolicy once for the same generation, then again after the 1h TTL, logging the skip at debug', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'))
      const recipe = reapRecipe(4)
      const logs = captureLoggerLevels(['debug', 'info'] as const)

      await reapPolicy(recipe)
      await reapPolicy(recipe)
      expect(policyDeletes()).toBe(1)
      // Witness: the skip is logged, at debug.
      expect(logs.calls.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping oauth-broker-egress delete'),
        expect.objectContaining({ recipe: 'test-recipe', generation: 4 })
      )
      expect(logs.calls.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Skipping oauth-broker-egress delete'),
        expect.anything()
      )

      vi.setSystemTime(new Date('2026-09-25T01:00:00.000Z'))
      await reapPolicy(recipe)
      expect(policyDeletes()).toBe(2)
      logs.restore()
      vi.useRealTimers()
    })

    it('R1-L2: a late pass carrying an older generation does not re-delete the Secret', async () => {
      tokenSeen()
      const debugSpy = captureLogger('debug')
      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(4))
      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(5))
      // Liveness witness: both newer-generation deletes really ran.
      expect(secretDeletes()).toBe(2)

      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(4))
      expect(secretDeletes()).toBe(2)
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping oauth-broker-token delete'),
        expect.objectContaining({ recipe: 'test-recipe', generation: 4 })
      )
      debugSpy.mockRestore()
    })

    it('R1-L2: a late pass carrying an older generation does not re-delete the NetworkPolicy, and R4-L2 logs the skip at debug', async () => {
      const logs = captureLoggerLevels(['debug', 'info'] as const)
      await reapPolicy(reapRecipe(4))
      await reapPolicy(reapRecipe(5))
      // Liveness witness: both newer-generation deletes really ran.
      expect(policyDeletes()).toBe(2)

      await reapPolicy(reapRecipe(4))
      expect(policyDeletes()).toBe(2)
      // Witness: the skip is logged, at debug.
      expect(logs.calls.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping oauth-broker-egress delete'),
        expect.objectContaining({ recipe: 'test-recipe', generation: 4 })
      )
      expect(logs.calls.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Skipping oauth-broker-egress delete'),
        expect.anything()
      )
      logs.restore()
    })

    it('R1-L2: a recipe recreated under the same name is reaped even at a lower generation', async () => {
      tokenSeen()
      await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(5))
      await reapPolicy(reapRecipe(5))
      expect(secretDeletes()).toBe(1)
      expect(policyDeletes()).toBe(1)

      // The recipe DELETE event was missed, so nothing invalidated the ledger.
      const recreated = makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-recreated',
          generation: 1,
        },
      })
      await reconciler.ensureOAuthBrokerTokenSecret(recreated)
      await reapPolicy(recreated)
      expect(secretDeletes()).toBe(2)
      expect(policyDeletes()).toBe(2)
    })

    it('R1-L1: an ADDED invalidation that lands while the DELETE is in flight is not overwritten', async () => {
      const recipe = reapRecipe(4)
      tokenSeen()
      mockCoreApi.deleteNamespacedSecret.mockImplementationOnce(async () => {
        // Another writer recreated the Secret and its ADDED was handled before
        // this DELETE returned.
        reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
        throw { code: 404 }
      })
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(1)

      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(2)

      // Liveness witness for the ledger itself: with no racing ADDED the
      // second delete is recorded and the next same-generation pass skips.
      await reconciler.ensureOAuthBrokerTokenSecret(recipe)
      expect(secretDeletes()).toBe(2)
    })

    it('R2-L1: a stale pass of an older generation does not delete the token a newer one provisioned', async () => {
      const issue = vi
        .spyOn(brokerIssuer, 'issueOAuthBrokerToken')
        .mockResolvedValue({ brokerToken: 'issued-token' } as Awaited<
          ReturnType<typeof brokerIssuer.issueOAuthBrokerToken>
        >)
      const debugSpy = captureLogger('debug')
      try {
        tokenSeen()
        // gen4 has no backgroundAccess: the Secret is reaped and recorded.
        await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(4))
        expect(secretDeletes()).toBe(1)

        // gen5 turns backgroundAccess on and the token is issued.
        const withBackgroundAccess = makeRecipe({
          metadata: {
            name: 'test-recipe',
            namespace: 'sandbox-recipes',
            uid: 'uid-123',
            generation: 5,
          },
          spec: {
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            oauthClients: [
              {
                id: 'gmail',
                provider: 'google',
                clientIdRef: { name: 'creds', key: 'client-id' },
                clientSecretRef: { name: 'creds', key: 'client-secret' },
                scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
                backgroundAccess: true,
              },
            ],
          },
        })
        mockCoreApi.readNamespacedSecret.mockRejectedValueOnce({ code: 404 })
        await reconciler.ensureOAuthBrokerTokenSecret(withBackgroundAccess)
        // Witness that the issuance branch ran for gen5.
        expect(issue).toHaveBeenCalledTimes(1)
        expect(
          mockCoreApi.createNamespacedSecret.mock.calls.filter(
            ([arg]) => arg.body?.metadata?.name === SECRET_NAME
          )
        ).toHaveLength(1)

        // The token's watch ADDED, then a queued pass still carrying gen4.
        reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
        await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(4))
        expect(secretDeletes()).toBe(1)
        expect(debugSpy).toHaveBeenCalledWith(
          expect.stringContaining('Skipping oauth-broker-token delete'),
          expect.objectContaining({ recipe: 'test-recipe', generation: 4 })
        )

        // Liveness witness: a newer generation that drops backgroundAccess reaps it.
        await reconciler.ensureOAuthBrokerTokenSecret(reapRecipe(6))
        expect(secretDeletes()).toBe(2)
      } finally {
        debugSpy.mockRestore()
        issue.mockRestore()
      }
    })

    function shortCircuitWorkflowRecipe(
      spec: Partial<WorkflowRecipeCRD['spec']>,
      status: WorkflowRecipeCRD['status'],
      labels: Record<string, string>
    ): WorkflowRecipeCRD {
      return makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads: [],
          steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
          ...spec,
        },
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          generation: 4,
          labels,
        },
        status,
      })
    }

    const RUN_LABEL = { 'clerum.io/workflow-run-id': 'run-123' }

    // Every workflow pass that returns before the first-deploy path. A triggered
    // run (RUN_LABEL) has awaitsTriggeredRun=false; the onDemand recipe without
    // one idles awaiting its trigger.
    const WORKFLOW_SHORT_CIRCUITS = [
      {
        label: 'awaiting-trigger',
        recipe: () =>
          shortCircuitWorkflowRecipe(
            { triggers: { onDemand: { allowedActors: ['user'] } } },
            { phase: 'active' },
            {}
          ),
        expected: { phase: 'active', message: 'Workflow trigger infrastructure registered' },
      },
      {
        label: 'active',
        recipe: () =>
          shortCircuitWorkflowRecipe(
            {},
            { phase: 'active', workflowExecution: { phase: 'running' } },
            RUN_LABEL
          ),
        expected: { phase: 'active', message: 'Workflow running' },
      },
      {
        label: 'in-progress',
        recipe: () =>
          shortCircuitWorkflowRecipe(
            {},
            { phase: 'deploying', workflowExecution: { phase: 'running' } },
            RUN_LABEL
          ),
        expected: { phase: 'active', message: 'Workflow running' },
      },
      {
        label: 'terminal',
        recipe: () =>
          shortCircuitWorkflowRecipe(
            {},
            { phase: 'active', workflowExecution: { phase: 'completed' } },
            RUN_LABEL
          ),
        expected: { phase: 'active', message: 'Workflow completed' },
      },
      {
        label: 'dryRun',
        recipe: () => shortCircuitWorkflowRecipe({ dryRun: true }, { phase: 'approved' }, {}),
        expected: {
          phase: 'candidate',
          message: 'Dry-run: preview generated, no resources created',
        },
      },
    ]

    function installShortCircuitWorkflowReconciler(): ReturnType<typeof vi.fn> {
      const workflowReconcile = vi.fn()
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
            ensureMcpHostRuntimeCredentials?: () => Promise<void>
          }
        }
      ).workflowReconciler = {
        reconcile: workflowReconcile,
        validateWorkflowSpec: () => undefined,
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
      }
      return workflowReconcile
    }

    // The four short-circuits the early reap in reconcileWorkflowRecipe names.
    describe.each(WORKFLOW_SHORT_CIRCUITS.filter(({ label }) => label !== 'dryRun'))(
      'R1-L13: the $label workflow short-circuit',
      ({ recipe, expected }) => {
        it('reaps a token Secret the recipe must not have, without the inner reconcile', async () => {
          const workflowReconcile = installShortCircuitWorkflowReconciler()
          const current = recipe()

          // The watch ADDED re-arms the ledger and enqueues this reconcile.
          reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
          const result = await reconciler.reconcile(current)

          // Witness that the short-circuit was taken, not the first-deploy path.
          expect(workflowReconcile).not.toHaveBeenCalled()
          expect(result).toMatchObject(expected)
          expect(secretDeletes()).toBe(1)

          // The ledger still bounds it: a second pass of the same generation skips.
          await reconciler.reconcile(current)
          expect(secretDeletes()).toBe(1)
        })
      }
    )

    describe.each(WORKFLOW_SHORT_CIRCUITS)(
      'R2-L2: the $label workflow short-circuit on a fresh process',
      ({ recipe, expected }) => {
        it('sends no token DELETE until a token ADDED arrives, then exactly one', async () => {
          const workflowReconcile = installShortCircuitWorkflowReconciler()
          const current = recipe()

          // A restarted process: no token ADDED has been observed for the recipe.
          for (let pass = 0; pass < 3; pass++) {
            const result = await reconciler.reconcile(current)
            // Witness that each pass took the short-circuit under test.
            expect(result).toMatchObject(expected)
          }
          expect(workflowReconcile).not.toHaveBeenCalled()
          expect(secretDeletes()).toBe(0)

          // The watch relist replays ADDED for a token that really exists.
          reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
          await reconciler.reconcile(current)
          expect(secretDeletes()).toBe(1)

          // The ledger bounds it: the next pass of the same generation skips.
          await reconciler.reconcile(current)
          expect(secretDeletes()).toBe(1)
        })
      }
    )

    function installFirstDeployWorkflow(): {
      recipe: WorkflowRecipeCRD
      workflowReconcile: ReturnType<typeof vi.fn>
    } {
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure created',
        workflowPhase: 'initializing',
      })
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
      const recipe = makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          generation: 4,
        },
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          steps: [{ id: 'run', run: snippetRun() }],
        },
      })
      return { recipe, workflowReconcile }
    }

    it('R3-L11: without a token ADDED the first-deploy pass sends no DELETE and logs the skip once, at debug', async () => {
      const { recipe, workflowReconcile } = installFirstDeployWorkflow()
      const skips = (spy: ReturnType<typeof vi.fn>) =>
        spy.mock.calls.filter(
          ([message]) =>
            typeof message === 'string' && message.startsWith('Skipping oauth-broker-token delete')
        )
      const logs = captureLoggerLevels(['debug', 'info'] as const)
      try {
        await reconciler.reconcile(recipe)

        // Witness that the pass went through deployWorkflowWorkloads.
        expect(workflowReconcile).toHaveBeenCalledTimes(1)
        // Witness that the reap ran and the ledger declined it, once per pass.
        expect(skips(logs.calls.debug)).toHaveLength(1)
        expect(skips(logs.calls.info)).toHaveLength(0)
        expect(secretDeletes()).toBe(0)
      } finally {
        logs.restore()
      }

      // Liveness witness: once the watch replays the token ADDED, the next
      // pass sends its one DELETE.
      tokenSeen()
      await reconciler.reconcile(recipe)
      expect(workflowReconcile).toHaveBeenCalledTimes(2)
      expect(secretDeletes()).toBe(1)
    })

    it('R2-L3: a first-deploy pass sends one token DELETE when it fails, and the next pass retries', async () => {
      const { recipe, workflowReconcile } = installFirstDeployWorkflow()
      let tokenDeletes = 0
      mockCoreApi.deleteNamespacedSecret.mockImplementation(async ({ name }: { name: string }) => {
        if (name !== SECRET_NAME) return {}
        tokenDeletes += 1
        if (tokenDeletes === 1) throw { code: 503 }
        return {}
      })
      try {
        // A token ADDED was observed, so the early reap runs in this pass.
        reconciler.invalidateOAuthBrokerSecretLedger('test-recipe')
        await reconciler.reconcile(recipe)

        // Witness that the pass went through deployWorkflowWorkloads.
        expect(workflowReconcile).toHaveBeenCalledTimes(1)
        expect(secretDeletes()).toBe(1)

        // The failed DELETE was not recorded, so the next pass retries it.
        await reconciler.reconcile(recipe)
        expect(workflowReconcile).toHaveBeenCalledTimes(2)
        expect(secretDeletes()).toBe(2)
      } finally {
        mockCoreApi.deleteNamespacedSecret.mockResolvedValue({})
      }
    })
  })

  function ineligibleProjection(): CodexExecutionProjection {
    return {
      targets: [],
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      driftHashInput: '',
      catalogContentHash: null,
      catalogRevision: null,
      connectionRevision: null,
      eligibility: 'ineligible',
      reason: 'static_only',
    }
  }

  // Replaces the WRC's inner reconciler with a real WorkflowReconciler wired
  // to the shared API mocks.
  function installRealInner(): WorkflowReconciler {
    const inner = new WorkflowReconciler({
      coreApi: mockCoreApi,
      customApi: mockCustomApi,
      networkingApi: mockNetworkingApi,
      config: {
        coordinatorImage: 'coordinator:test',
        mcpHostImage: 'mcp-host:test',
        wrcEndpoint: 'http://wrc.example/api',
        sandboxNamespace: 'sandbox-recipes',
        mcpServerNamespace: 'mcp-server',
        imagePullPolicy: 'IfNotPresent',
        maxWorkflowSteps: 100,
        runtimeTokenTtlSeconds: 3600,
        runtimeTokenRefreshBeforeSeconds: 300,
      },
      tokenFactory: {
        signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('t'),
        signCoordinatorToMcpHostToken: vi.fn().mockResolvedValue('t'),
        signCustomCoordinatorToWrcToken: vi.fn().mockResolvedValue('t'),
        signCoordinatorToWrcToken: vi.fn().mockResolvedValue('t'),
      },
      pluginWorkloadSdkRevocationClient: {
        revoke: vi.fn().mockResolvedValue({ state: 'missing', revoked: 0, fencedInvocations: 0 }),
        finalize: vi.fn(),
      },
    } as never)
    ;(reconciler as unknown as { workflowReconciler: WorkflowReconciler }).workflowReconciler =
      inner
    return inner
  }

  describe('G2 skipStatusPatch must not leave GFS deleted', () => {
    const RECIPE = 'g2-recipe'
    const GFS = `${RECIPE}-coordinator-to-gfs`

    it('inner apply does not delete reserved GFS and outer skips ensure on skipStatusPatch', async () => {
      mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          {
            metadata: {
              name: GFS,
              namespace: 'sandbox-recipes',
              labels: { 'clerum.io/recipe': RECIPE, 'clerum.io/managed-by': 'wrc' },
            },
          },
          {
            // Liveness witness: an ordinary catalog member that is not desired sits in
            // the same LIST and must be deleted, so "GFS was not deleted" cannot hold
            // just because the prune never iterated.
            metadata: {
              name: `${RECIPE}-mcp-host-to-grok-proxy`,
              namespace: 'sandbox-recipes',
              labels: { 'clerum.io/recipe': RECIPE, 'clerum.io/managed-by': 'wrc' },
            },
          },
        ],
      })
      const inner = installRealInner()
      const apply = (
        inner as unknown as {
          applyWorkflowNetworkPolicies: (...args: unknown[]) => Promise<unknown>
        }
      ).applyWorkflowNetworkPolicies.bind(inner)
      vi.spyOn(inner, 'reconcile').mockImplementation(async (recipeName, recipeUid, _ns, spec) => {
        const runtime = deriveWorkflowRuntimePlan(spec as never, {
          recipeName: String(recipeName),
          runtimeScopeRecipeName: String(recipeName),
          workflowRunId: 'run-g2',
        })
        const projection = ineligibleProjection()
        await apply(recipeName, recipeUid, spec, runtime, false, projection, false, {
          ...projection,
          requiresGrokProxyEgress: false,
        })
        return {
          phase: 'active',
          message: 'transient',
          workflowPhase: 'running',
          skipStatusPatch: true,
        }
      })

      const result = await reconciler.reconcile(
        makeRecipe({
          metadata: {
            name: RECIPE,
            namespace: 'sandbox-recipes',
            uid: 'uid-g2',
            labels: { 'clerum.io/workflow-run-id': 'run-g2' },
          },
          spec: {
            agent: { provider: 'openai', model: 'gpt-4o' },
            steps: [{ id: 'publish', instruction: 'publish' }],
            gfs: { publishTargets: [{ drive: 'main', target: 'out' }] },
          },
          status: { phase: 'pending' },
        })
      )

      expect(result, result.message).toMatchObject({ skipStatusPatch: true })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: `${RECIPE}-mcp-host-to-grok-proxy` })
      )
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: GFS })
      )
      expect(
        mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
          ([arg]) => arg.body?.metadata?.name === GFS
        )
      ).toBe(false)
    })

    it('retryRunLaneNetworkPolicies prunes nothing: no LIST and no DELETE, reserved GFS included', async () => {
      mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          {
            metadata: {
              name: GFS,
              namespace: 'sandbox-recipes',
              labels: { 'clerum.io/recipe': RECIPE, 'clerum.io/managed-by': 'wrc' },
            },
          },
          {
            metadata: {
              name: `${RECIPE}-snippet-runner-egress`,
              namespace: 'sandbox-recipes',
              labels: { 'clerum.io/recipe': RECIPE, 'clerum.io/managed-by': 'wrc' },
            },
          },
          {
            metadata: {
              name: `${RECIPE}-mcp-host-to-grok-proxy`,
              namespace: 'sandbox-recipes',
              labels: { 'clerum.io/recipe': RECIPE, 'clerum.io/managed-by': 'wrc' },
            },
          },
        ],
      })
      const inner = installRealInner()

      await inner.retryRunLaneNetworkPolicies(
        RECIPE,
        'uid-g2',
        { steps: [{ id: 'publish', instruction: 'publish' }] },
        RECIPE,
        'run-g2'
      )

      // Liveness witness: the retry built this agent spec and applied a lane
      // it wants, so the absent DELETEs below are the retry declining to
      // prune mid-run, not a retry that never ran.
      expect(
        mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
          ([arg]) => arg.body?.metadata?.name === `${RECIPE}-coord-to-mcp-host`
        )
      ).toBe(true)
      // The run's pods are live, so the retry revokes no lane: not the
      // reserved GFS policy, not a sibling the spec no longer wants, not a
      // Codex/Grok proxy, and not the legacy mcp-servers internet policy. It
      // does not even LIST what a prune would find.
      expect(mockNetworkingApi.listNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })
  })

  // R4-L4: a legacy mcp-servers internet policy DELETE that did not land is
  // published as WorkflowLegacyNetworkPolicyRemoved=False/DeletePending. The
  // in-progress, active and terminal short-circuits never reach reconcile(),
  // so the legacy-retry writer runs before them: one DELETE per backoff window
  // (60 s, doubling up to 1 h), a fixed requeue for the rest of the window,
  // and the marker cleared once the policy is gone.
  describe('R4-L4: legacy internet policy DELETE retried before the short-circuits', () => {
    const RECIPE = 'lg-recipe'
    const RUN_ID = 'run-lg'
    const LEGACY = `${RECIPE}-mcp-servers-egress-internet`
    const LEGACY_TYPE = 'WorkflowLegacyNetworkPolicyRemoved'
    const MARKER_TYPE = 'WorkflowNetworkPoliciesConverged'
    const T0 = new Date('2026-09-23T10:00:00.000Z').getTime()

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(T0)
    })

    afterEach(() => {
      vi.useRealTimers()
      mockCustomApi.patchNamespacedCustomObjectStatus
        .mockReset()
        .mockImplementation(echoPatchedStatus)
    })

    function runScopedRecipe(status: Record<string, unknown>): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: RECIPE,
          namespace: 'sandbox-recipes',
          uid: 'uid-lg',
          labels: { 'clerum.io/workflow-run-id': RUN_ID },
        },
        spec: {
          agent: { provider: 'openai', model: 'gpt-4o' },
          steps: [{ id: 'research', instruction: 'run' }],
        },
        status: status as WorkflowRecipeCRD['status'],
      })
    }

    function publishedFacts(prune: 'converged' | 'pending'): StatusCondition[] {
      return networkPolicyMarkerConditions(
        {
          kind: 'reconcile',
          summary: { conflicts: [], retryPending: false, prune, legacy: 'pending' },
        },
        [],
        '2026-09-23T09:00:00.000Z'
      )
    }

    function ofType(conditions: StatusCondition[] | undefined, type: string): StatusCondition[] {
      return (conditions ?? []).filter(c => c.type === type)
    }

    function legacyDeletes(): number {
      return mockNetworkingApi.deleteNamespacedNetworkPolicy.mock.calls.filter(
        ([arg]) => (arg as { name: string }).name === LEGACY
      ).length
    }

    function legacyDeleteAnswers(error: { code: number; message: string }) {
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(
        async ({ name }: { name: string }) => {
          if (name === LEGACY) throw error
          return {}
        }
      )
    }

    function stubShortCircuits(inner: WorkflowReconciler) {
      const ensureCredentials = vi
        .spyOn(inner, 'ensureMcpHostRuntimeCredentials')
        .mockResolvedValue(undefined)
      vi.spyOn(inner, 'refreshRuntimeHttpEgressNetworkPolicies').mockResolvedValue({
        conflicts: [],
        retryPending: false,
      })
      const teardown = vi.spyOn(inner, 'teardownComputePodsForTerminalRun').mockResolvedValue()
      const innerReconcile = vi.spyOn(inner, 'reconcile')
      return { ensureCredentials, teardown, innerReconcile }
    }

    it('R4-L4: sends one legacy DELETE per backoff window from the in-progress, active and terminal short-circuits', async () => {
      const inner = installRealInner()
      const { ensureCredentials, teardown, innerReconcile } = stubShortCircuits(inner)
      legacyDeleteAnswers({ code: 403, message: 'forbidden' })
      const conditions = publishedFacts('converged')
      // Liveness witness: the fixture publishes the legacy fact alone.
      expect(conditions).toMatchObject([
        { type: LEGACY_TYPE, status: 'False', reason: 'DeletePending' },
      ])

      const inProgress = runScopedRecipe({
        phase: 'deploying',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
        conditions,
      })
      const first = await reconciler.reconcile(inProgress)

      // Witness: the in-progress short-circuit ran.
      expect(ensureCredentials).toHaveBeenCalled()
      expect(legacyDeletes()).toBe(1)
      expect(first.requeueAfterMs).toBe(60_000)
      expect(first.requeueFixedInterval).toBe(true)
      expect(ofType(inProgress.status?.conditions, LEGACY_TYPE)).toMatchObject([
        { status: 'False', reason: 'DeletePending' },
      ])

      vi.setSystemTime(T0 + 20_000)
      const active = runScopedRecipe({
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
        conditions,
      })
      const second = await reconciler.reconcile(active)

      // Inside the window: no DELETE, and a requeue for the 40 s left.
      expect(legacyDeletes()).toBe(1)
      expect(second.requeueAfterMs).toBe(40_000)
      expect(second.requeueFixedInterval).toBe(true)

      vi.setSystemTime(T0 + 61_000)
      const terminal = runScopedRecipe({
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: { phase: 'completed' },
        conditions,
      })
      const third = await reconciler.reconcile(terminal)

      // Witness: the terminal branch tore the run's compute down.
      expect(teardown).toHaveBeenCalledWith(RECIPE)
      // Past the window: one more DELETE, and the window doubles.
      expect(legacyDeletes()).toBe(2)
      expect(third.requeueAfterMs).toBe(120_000)
      expect(third.requeueFixedInterval).toBe(true)
      expect(ofType(terminal.status?.conditions, LEGACY_TYPE)).toMatchObject([
        { status: 'False', reason: 'DeletePending' },
      ])
      expect(innerReconcile).not.toHaveBeenCalled()
    })

    it('R4-L4: clears DeletePending from the active short-circuit once the legacy DELETE answers 404, and carries the prune fact', async () => {
      const inner = installRealInner()
      const { ensureCredentials } = stubShortCircuits(inner)
      legacyDeleteAnswers({ code: 404, message: 'not found' })
      const conditions = publishedFacts('pending')
      expect(ofType(conditions, MARKER_TYPE)).toMatchObject([{ reason: 'PrunePending' }])
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
      const active = runScopedRecipe({
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
        conditions,
      })

      const result = await reconciler.reconcile(active)

      // Witness: the active short-circuit ran and sent the DELETE.
      expect(ensureCredentials).toHaveBeenCalled()
      expect(legacyDeletes()).toBe(1)
      expect(ofType(active.status?.conditions, LEGACY_TYPE)).toEqual([])
      expect(ofType(active.status?.conditions, MARKER_TYPE)).toEqual(
        ofType(conditions, MARKER_TYPE)
      )
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      expect(result.requeueAfterMs).toBeUndefined()
    })

    it('R4-L4: sends no legacy DELETE from a short-circuit when no DeletePending marker is published', async () => {
      const inner = installRealInner()
      const { ensureCredentials } = stubShortCircuits(inner)
      legacyDeleteAnswers({ code: 403, message: 'forbidden' })
      const active = runScopedRecipe({
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
        conditions: [],
      })

      const result = await reconciler.reconcile(active)

      // Witness: the active short-circuit ran.
      expect(ensureCredentials).toHaveBeenCalled()
      expect(result.message).toBe('Workflow running')
      expect(legacyDeletes()).toBe(0)
      expect(result.requeueAfterMs).toBeUndefined()
    })

    it('R4-L4: keeps the requeue a short-circuit already asked for while DeletePending stays published', async () => {
      const inner = installRealInner()
      stubShortCircuits(inner)
      const retry = vi
        .spyOn(inner, 'retryRunLaneNetworkPolicies')
        .mockResolvedValue({ conflicts: [], retryPending: true })
      legacyDeleteAnswers({ code: 403, message: 'forbidden' })
      const conditions = networkPolicyMarkerConditions(
        {
          kind: 'reconcile',
          summary: { conflicts: [], retryPending: true, prune: 'converged', legacy: 'pending' },
        },
        [],
        '2026-09-23T09:00:00.000Z'
      )
      expect(ofType(conditions, MARKER_TYPE)).toMatchObject([{ reason: 'RetryPending' }])
      expect(ofType(conditions, LEGACY_TYPE)).toMatchObject([{ reason: 'DeletePending' }])
      const active = runScopedRecipe({
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
        conditions,
      })

      const result = await reconciler.reconcile(active)

      // Witnesses: the apply retry ran and the legacy DELETE was sent.
      expect(retry).toHaveBeenCalledTimes(1)
      expect(legacyDeletes()).toBe(1)
      expect(ofType(active.status?.conditions, LEGACY_TYPE)).toMatchObject([
        { reason: 'DeletePending' },
      ])
      // The apply retry's progress requeue wins over the 60 s legacy window.
      expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
      expect(result.requeueFixedInterval).toBe(false)
    })

    it('R5-J1: retries the legacy DELETE before a validation return, so DeletePending never requeues at 1 s', async () => {
      const inner = installRealInner()
      const { innerReconcile } = stubShortCircuits(inner)
      legacyDeleteAnswers({ code: 403, message: 'forbidden' })
      const conditions = publishedFacts('converged')
      const overLimit = makeRecipe({
        metadata: {
          name: RECIPE,
          namespace: 'sandbox-recipes',
          uid: 'uid-lg',
          labels: { 'clerum.io/workflow-run-id': RUN_ID },
        },
        spec: {
          agent: { provider: 'openai', model: 'gpt-4o' },
          steps: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, instruction: 'run' })),
        },
        status: {
          phase: 'active',
          message: 'Workflow running',
          workflowExecution: { phase: 'running' },
          conditions,
        } as WorkflowRecipeCRD['status'],
      })

      const result = await reconciler.reconcile(overLimit)

      // Witness: the pass took the spec-limit return, before reconcile().
      expect(result.phase).toBe('failed')
      expect(result.message).toBe('spec.steps must contain at most 100 items')
      expect(innerReconcile).not.toHaveBeenCalled()
      // The DELETE was sent, so the requeue is the 60 s backoff, not the 1 s floor.
      expect(legacyDeletes()).toBe(1)
      expect(result.requeueAfterMs).toBe(60_000)
      expect(result.requeueFixedInterval).toBe(true)
    })

    function realWatcherBridge(
      recipe: WorkflowRecipeCRD,
      options: { dbRunProcessor?: { syncFromRecipeExecution: ReturnType<typeof vi.fn> } } = {}
    ) {
      // The surrounding ledger-only cases fake Date; this bridge drives real timers too.
      vi.useRealTimers()
      vi.useFakeTimers()
      vi.setSystemTime(T0)
      let live: WorkflowRecipeCRD | undefined = structuredClone(recipe)
      const previousGet = mockCustomApi.getNamespacedCustomObject.getMockImplementation()!
      mockCustomApi.getNamespacedCustomObject.mockImplementation(async args => {
        if (args.plural !== 'workflowrecipes' || args.name !== RECIPE) return previousGet(args)
        if (!live) throw { code: 404 }
        return structuredClone(live)
      })
      mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }) => {
        if (!live) throw { code: 404 }
        if (
          body.metadata &&
          (body.metadata.uid !== live.metadata.uid ||
            body.metadata.resourceVersion !== live.metadata.resourceVersion)
        ) {
          throw { code: 409 }
        }
        live.status = mergeStatusPatch(live.status, body.status)
        live.metadata.resourceVersion = String(Number(live.metadata.resourceVersion) + 1)
        return structuredClone(live)
      })
      const queueFailures = vi.fn()
      const queue = new RecipeEventQueue(queueFailures)
      const watcher = Object.create(WorkflowRecipeWatcher.prototype) as {
        recipes: Map<string, WorkflowRecipeCRD>
        eventQueue: RecipeEventQueue
        transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
        handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
        clearTransientRetry: (name: string) => void
      }
      Object.assign(watcher, {
        recipes: new Map(),
        eventQueue: queue,
        transientRetries: new Map(),
        stopped: false,
        traceReporter: null,
        dbRunProcessor: options.dbRunProcessor ?? null,
        reconciler,
        customApi: mockCustomApi,
      })
      return {
        watcher,
        queue,
        queueFailures,
        current: () => live,
        replace: (next: WorkflowRecipeCRD | undefined) => {
          live = next
        },
        drain: () => queue.enqueue(RECIPE, async () => {}),
      }
    }

    function terminalRetryRecipe(): WorkflowRecipeCRD {
      const recipe = runScopedRecipe({
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: { phase: 'completed' },
        conditions: publishedFacts('converged'),
        workloadInstances: { 'web-search': `${RECIPE}-web-search-run` },
      })
      recipe.metadata.resourceVersion = '1'
      recipe.metadata.generation = 1
      recipe.spec.workloads = [
        {
          id: 'web-search',
          type: 'deployment',
          image: 'web-search:test',
          transport: { type: 'streamableHttp', path: '/mcp' },
        },
      ]
      return recipe
    }

    it('R5-L3: the dedicated retry retains the pipeline namespace allowlist', async () => {
      const inner = installRealInner()
      const retry = vi.spyOn(inner, 'retryLegacyMcpServersInternetEgressDelete')
      const recipe = terminalRetryRecipe()
      recipe.metadata.namespace = 'other-namespace'
      expect(ofType(recipe.status?.conditions, LEGACY_TYPE)).toHaveLength(1)
      mockCustomApi.getNamespacedCustomObject.mockClear()
      const result = await reconciler.retryPendingLegacyNetworkPolicyDeleteOnly(recipe)
      expect(result).toEqual({})
      expect(retry).not.toHaveBeenCalled()
      expect(mockCustomApi.getNamespacedCustomObject).not.toHaveBeenCalled()
      expect(legacyDeletes()).toBe(0)
    })

    it('R5-L3: the real watcher, WRC and event queue retry only legacy DELETE across 60/120/240 s windows', async () => {
      vi.useFakeTimers()
      const inner = installRealInner()
      vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue()
      const teardown = vi.spyOn(inner, 'teardownComputePodsForTerminalRun')
      const fullReconcile = vi.spyOn(reconciler, 'reconcile')
      legacyDeleteAnswers({ code: 403, message: 'forbidden' })
      const bridge = realWatcherBridge(terminalRetryRecipe())

      await bridge.queue.enqueue(RECIPE, () =>
        bridge.watcher.handleRecipeEvent('ADDED', bridge.current()!)
      )

      expect(teardown).toHaveBeenCalledTimes(1)
      expect(legacyDeletes()).toBe(1)
      const initialEffects = {
        pods: mockCoreApi.deleteNamespacedPod.mock.calls.length,
        transport: mockCustomApi.deleteNamespacedCustomObject.mock.calls.filter(
          ([arg]) => arg.plural === 'mcpservers'
        ).length,
        deployments: mockAppsApi.deleteNamespacedDeployment.mock.calls.length,
        gfs: mockNetworkingApi.deleteNamespacedNetworkPolicy.mock.calls.filter(([arg]) =>
          arg.name.endsWith('-coordinator-to-gfs')
        ).length,
      }
      expect(initialEffects.pods).toBe(3)
      expect(initialEffects.transport).toBeGreaterThan(0)
      expect(initialEffects.deployments).toBeGreaterThan(0)
      expect(initialEffects.gfs).toBeGreaterThan(0)

      for (const [index, delay] of [60_000, 120_000, 240_000].entries()) {
        await vi.advanceTimersByTimeAsync(delay)
        await bridge.drain()
        expect(legacyDeletes()).toBe(index + 2)
        expect(fullReconcile).toHaveBeenCalledTimes(1)
        expect(teardown).toHaveBeenCalledTimes(1)
        expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledTimes(initialEffects.pods)
        expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(
          initialEffects.deployments
        )
        expect(
          mockCustomApi.deleteNamespacedCustomObject.mock.calls.filter(
            ([arg]) => arg.plural === 'mcpservers'
          )
        ).toHaveLength(initialEffects.transport)
        expect(
          mockNetworkingApi.deleteNamespacedNetworkPolicy.mock.calls.filter(([arg]) =>
            arg.name.endsWith('-coordinator-to-gfs')
          )
        ).toHaveLength(initialEffects.gfs)
      }

      // Recovery performs a conditions-only patch, preserving the workflow/SDK state.
      const beforeRecovery = structuredClone(bridge.current()!.status)
      legacyDeleteAnswers({ code: 404, message: 'not found' })
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
      await vi.advanceTimersByTimeAsync(480_000)
      await bridge.drain()
      expect(legacyDeletes()).toBe(5)
      expect(fullReconcile).toHaveBeenCalledTimes(1)
      expect(bridge.current()!.status?.workflowExecution).toEqual(beforeRecovery?.workflowExecution)
      expect(bridge.current()!.status?.pluginWorkloadSdk).toEqual(beforeRecovery?.pluginWorkloadSdk)
      expect(ofType(bridge.current()!.status?.conditions, LEGACY_TYPE)).toEqual([])
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            metadata: { uid: 'uid-lg', resourceVersion: expect.any(String) },
            status: { conditions: expect.any(Array) },
          },
        }),
        expect.anything()
      )
      expect(bridge.queueFailures).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      // Deliver the actual accepted PATCH response through the ordinary watch
      // path. Its unchanged generation makes this a status-only MODIFIED. The
      // terminal teardown of the ADDED pass is recorded on the run (issue #1349;
      // that record write is resourceVersion 2), so the event only syncs the DB:
      // no second full reconcile, and the teardown deletes are not repeated.
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      const recoveryWatchObject = (await mockCustomApi.patchNamespacedCustomObjectStatus.mock
        .results[0].value) as WorkflowRecipeCRD
      expect(recoveryWatchObject).toEqual(bridge.current())
      expect(recoveryWatchObject.metadata.resourceVersion).toBe('3')
      expect(recoveryWatchObject.metadata.generation).toBe(1)
      expect(recoveryWatchObject.status?.terminalRunTeardown?.completedAt).toEqual(
        expect.any(String)
      )
      await bridge.queue.enqueue(RECIPE, () =>
        bridge.watcher.handleRecipeEvent('MODIFIED', recoveryWatchObject)
      )
      await bridge.drain()
      expect(fullReconcile).toHaveBeenCalledTimes(1)
      expect(teardown).toHaveBeenCalledTimes(1)
      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledTimes(initialEffects.pods)
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(
        initialEffects.deployments
      )
      expect(
        mockCustomApi.deleteNamespacedCustomObject.mock.calls.filter(
          ([arg]) => arg.plural === 'mcpservers'
        )
      ).toHaveLength(initialEffects.transport)
      expect(
        mockNetworkingApi.deleteNamespacedNetworkPolicy.mock.calls.filter(([arg]) =>
          arg.name.endsWith('-coordinator-to-gfs')
        )
      ).toHaveLength(initialEffects.gfs)
      expect(legacyDeletes()).toBe(5)
      // The event publishes nothing, so it cannot drive another watch event.
      // No legacy timer or continuing status-write loop remains either.
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(3_600_000)
      await bridge.drain()
      expect(fullReconcile).toHaveBeenCalledTimes(1)
      expect(teardown).toHaveBeenCalledTimes(1)
      expect(legacyDeletes()).toBe(5)
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      expect(bridge.queueFailures).not.toHaveBeenCalled()
      bridge.watcher.clearTransientRetry(RECIPE)
    })

    it('the watch events of a recorded terminal teardown only sync the DB (issue #1349)', async () => {
      const inner = installRealInner()
      vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue()
      const teardown = vi.spyOn(inner, 'teardownComputePodsForTerminalRun')
      const fullReconcile = vi.spyOn(reconciler, 'reconcile')
      legacyDeleteAnswers({ code: 404, message: 'not found' })
      const dbRunProcessor = { syncFromRecipeExecution: vi.fn().mockResolvedValue(undefined) }
      const bridge = realWatcherBridge(terminalRetryRecipe(), { dbRunProcessor })

      await bridge.queue.enqueue(RECIPE, () =>
        bridge.watcher.handleRecipeEvent('ADDED', bridge.current()!)
      )
      await bridge.drain()

      expect(fullReconcile).toHaveBeenCalledTimes(1)
      expect(teardown).toHaveBeenCalledTimes(1)
      // The ADDED event synced the DB before its reconcile; count only what follows.
      dbRunProcessor.syncFromRecipeExecution.mockClear()
      // Every status patch the pass sent, as the watch delivers them: the record
      // patch first, then any later patch of the same pass.
      const watchObjects = await Promise.all(
        mockCustomApi.patchNamespacedCustomObjectStatus.mock.results.map(
          r => r.value as Promise<WorkflowRecipeCRD>
        )
      )
      const recordIndex = watchObjects.findIndex(
        o => o.status?.terminalRunTeardown?.completedAt !== undefined
      )
      expect(recordIndex).toBeGreaterThanOrEqual(0)
      const delivered = watchObjects.slice(recordIndex)
      for (const object of delivered) {
        await bridge.queue.enqueue(RECIPE, () =>
          bridge.watcher.handleRecipeEvent('MODIFIED', object)
        )
      }
      await bridge.drain()

      expect(dbRunProcessor.syncFromRecipeExecution).toHaveBeenCalledTimes(delivered.length)
      expect(fullReconcile).toHaveBeenCalledTimes(1)
      expect(teardown).toHaveBeenCalledTimes(1)
      expect(bridge.watcher.recipes.get(RECIPE)?.status?.terminalRunTeardown?.completedAt).toEqual(
        expect.any(String)
      )
      expect(bridge.queueFailures).not.toHaveBeenCalled()
      bridge.watcher.clearTransientRetry(RECIPE)
    })

    it('T2.1 a terminal run child revokes its denied workloads once, and the record event runs no pass (issue #1349)', async () => {
      const inner = installRealInner()
      vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue()
      const teardown = vi.spyOn(inner, 'teardownComputePodsForTerminalRun')
      const fullReconcile = vi.spyOn(reconciler, 'reconcile')
      legacyDeleteAnswers({ code: 404, message: 'not found' })
      const recipe = terminalRetryRecipe()
      recipe.spec.workloads = [
        {
          ...recipe.spec.workloads![0],
          envSecret: { name: 'ws-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
        } as WorkloadDef,
        {
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          port: 5432,
          envSecret: {
            name: 'db-creds',
            keys: [{ secretKey: 'token', envVar: 'POSTGRES_PASSWORD' }],
          },
        } as WorkloadDef,
      ]
      recipe.status!.workloadInstances = {
        ...recipe.status!.workloadInstances,
        db: `${RECIPE}-db-run`,
      }
      // Both named Secrets are foreign (denied); every other Secret read is unchanged.
      const deniedVersions: Record<string, string> = { 'ws-creds': '11', 'db-creds': '12' }
      const otherSecretRead = mockCoreApi.readNamespacedSecret.getMockImplementation()!
      mockCoreApi.readNamespacedSecret.mockImplementation(async (args: { name: string }) => {
        const resourceVersion = deniedVersions[args.name]
        if (resourceVersion === undefined) return otherSecretRead(args)
        return {
          metadata: { resourceVersion, labels: { 'clerum.io/owner-recipe': 'some-other-recipe' } },
          data: { token: 'eA==' },
        }
      })
      // The StatefulSet is live, rendered while db-creds was accessible.
      await mockAppsApi.createNamespacedStatefulSet({
        namespace: recipe.metadata.namespace,
        body: buildStatefulSet(
          recipe.spec.workloads[1] as Parameters<typeof buildStatefulSet>[0],
          recipe,
          'minimal',
          new Map([['db-creds', { state: 'accessible', keys: new Set(['token']) }]])
        ).statefulSet,
      })
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      const bridge = realWatcherBridge(recipe)
      const deniedCondition = (result: { secretOwnershipConditions?: StatusCondition[] }) =>
        (result.secretOwnershipConditions ?? []).find(c => c.type === 'EnvSecretOwnershipDenied')
          ?.status
      // Every create/delete/patch/replace the reconciler can send, by API and verb.
      const mutatingCalls = () =>
        Object.fromEntries(
          (
            [
              ['apps', mockAppsApi],
              ['batch', mockBatchApi],
              ['core', mockCoreApi],
              ['custom', mockCustomApi],
              ['networking', mockNetworkingApi],
            ] as Array<[string, Record<string, ReturnType<typeof vi.fn>>]>
          ).flatMap(([api, mocks]) =>
            Object.entries(mocks)
              .filter(([verb]) => /^(create|delete|patch|replace)/.test(verb))
              .map(([verb, fn]) => [`${api}.${verb}`, fn.mock.calls.length])
          )
        )

      await bridge.queue.enqueue(RECIPE, () =>
        bridge.watcher.handleRecipeEvent('ADDED', bridge.current()!)
      )
      await bridge.drain()

      // Pass 1: the terminal teardown and both revocations ran and were recorded.
      expect(fullReconcile).toHaveBeenCalledTimes(1)
      expect(teardown).toHaveBeenCalledTimes(1)
      const first = await fullReconcile.mock.results[0].value
      expect(deniedCondition(first)).toBe('True')
      expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledTimes(1)
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      expect(
        mockAppsApi.deleteNamespacedDeployment.mock.calls.some(([arg]) =>
          String(arg.name).includes('web-search')
        )
      ).toBe(true)
      const records = bridge.current()!.status?.secretOwnershipRevocations
      expect(records?.['web-search']).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(records?.['db']).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(bridge.current()!.status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      // Pass 1 deleted the coordinator GFS policy; the API server now answers 404
      // for it, so the read-first revocation of a later pass sends no delete.
      expect(
        mockNetworkingApi.deleteNamespacedNetworkPolicy.mock.calls.some(([arg]) =>
          arg.name.endsWith('-coordinator-to-gfs')
        )
      ).toBe(true)
      const otherPolicyRead = mockNetworkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        async (args: { name: string; namespace: string }) => {
          if (args.name.endsWith('-coordinator-to-gfs')) throw { code: 404 }
          return otherPolicyRead(args)
        }
      )
      const afterFirstPass = mutatingCalls()
      const secretReads = mockCoreApi.readNamespacedSecret.mock.calls.length

      // Pass 2: a full pass on the recorded object sends nothing.
      const second = await reconciler.reconcile(structuredClone(bridge.current()!))

      // Witness: pass 2 classified the Secrets again.
      expect(mockCoreApi.readNamespacedSecret.mock.calls.length).toBeGreaterThan(secretReads)
      expect(mutatingCalls()).toEqual(afterFirstPass)
      expect(second.phase).toBe(first.phase)
      expect(second.message).toBe(first.message)
      expect(deniedCondition(second)).toBe('True')

      // The object the revocation record patch returned, delivered as the watch
      // delivers it (status-only MODIFIED): no pass runs.
      const watchObjects = await Promise.all(
        mockCustomApi.patchNamespacedCustomObjectStatus.mock.results.map(
          r => r.value as Promise<WorkflowRecipeCRD>
        )
      )
      const revocationObject = watchObjects.find(
        o => o.status?.secretOwnershipRevocations?.['db'] !== undefined
      )
      expect(revocationObject?.status?.terminalRunTeardown?.completedAt).toEqual(expect.any(String))
      await bridge.queue.enqueue(RECIPE, () =>
        bridge.watcher.handleRecipeEvent('MODIFIED', revocationObject!)
      )
      await bridge.drain()

      expect(fullReconcile).toHaveBeenCalledTimes(2)
      expect(mutatingCalls()).toEqual(afterFirstPass)
      expect(bridge.queueFailures).not.toHaveBeenCalled()
      bridge.watcher.clearTransientRetry(RECIPE)
    })

    it.each([
      'recreated',
      'deleted',
      'deleting',
      'marker-cleared',
      'namespace-changed',
      'name-changed',
    ] as const)(
      'R5-L3: a queued legacy retry drops a %s recipe after its fresh API read',
      async change => {
        vi.useFakeTimers()
        const inner = installRealInner()
        vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue()
        const teardown = vi.spyOn(inner, 'teardownComputePodsForTerminalRun')
        const fullReconcile = vi.spyOn(reconciler, 'reconcile')
        legacyDeleteAnswers({ code: 403, message: 'forbidden' })
        const bridge = realWatcherBridge(terminalRetryRecipe())
        await bridge.queue.enqueue(RECIPE, () =>
          bridge.watcher.handleRecipeEvent('ADDED', bridge.current()!)
        )
        expect(legacyDeletes()).toBe(1)
        expect(vi.getTimerCount()).toBe(1)
        let release!: () => void
        const blocker = bridge.queue.enqueue(
          RECIPE,
          () =>
            new Promise<void>(resolve => {
              release = resolve
            })
        )
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(60_000)
        const next = structuredClone(bridge.current()!)
        if (change === 'deleted') bridge.replace(undefined)
        else {
          if (change === 'recreated') next.metadata.uid = 'uid-new'
          if (change === 'deleting') next.metadata.deletionTimestamp = new Date().toISOString()
          if (change === 'marker-cleared') next.status!.conditions = []
          if (change === 'namespace-changed') next.metadata.namespace = 'other-namespace'
          if (change === 'name-changed') next.metadata.name = 'other-recipe'
          bridge.replace(next)
        }
        // Leave the watcher's cache stale: the API read after the queue wait is authoritative.
        release()
        await blocker
        await bridge.drain()
        expect(legacyDeletes()).toBe(1)
        expect(fullReconcile).toHaveBeenCalledTimes(1)
        expect(teardown).toHaveBeenCalledTimes(1)
        expect(bridge.queueFailures).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
        bridge.watcher.clearTransientRetry(RECIPE)
      }
    )

    it.each(['recreated', 'deleting', 'marker-cleared'] as const)(
      'R5-L3: the post-DELETE read refuses to publish on a %s recipe',
      async change => {
        const inner = installRealInner()
        vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue()
        const fullReconcile = vi.spyOn(reconciler, 'reconcile')
        legacyDeleteAnswers({ code: 403, message: 'forbidden' })
        const bridge = realWatcherBridge(terminalRetryRecipe())
        await bridge.queue.enqueue(RECIPE, () =>
          bridge.watcher.handleRecipeEvent('ADDED', bridge.current()!)
        )
        expect(legacyDeletes()).toBe(1)
        mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
        mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
          if (name === LEGACY) {
            const next = structuredClone(bridge.current()!)
            if (change === 'recreated') next.metadata.uid = 'uid-new'
            if (change === 'deleting') next.metadata.deletionTimestamp = new Date().toISOString()
            if (change === 'marker-cleared') next.status!.conditions = []
            bridge.replace(next)
          }
          return {}
        })
        await vi.advanceTimersByTimeAsync(60_000)
        await bridge.drain()
        expect(legacyDeletes()).toBe(2)
        expect(fullReconcile).toHaveBeenCalledTimes(1)
        expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
        expect(bridge.queueFailures).not.toHaveBeenCalled()
      }
    )

    it.each(['recreated', 'newer-policy-facts'] as const)(
      'R5-L3: a status conflict caused by %s retries only the fenced conditions patch',
      async change => {
        const inner = installRealInner()
        vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue()
        const fullReconcile = vi.spyOn(reconciler, 'reconcile')
        legacyDeleteAnswers({ code: 403, message: 'forbidden' })
        const bridge = realWatcherBridge(terminalRetryRecipe())
        await bridge.queue.enqueue(RECIPE, () =>
          bridge.watcher.handleRecipeEvent('ADDED', bridge.current()!)
        )
        mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
        const newerFacts = networkPolicyMarkerConditions(
          {
            kind: 'reconcile',
            summary: { conflicts: [], retryPending: true, prune: 'pending', legacy: 'pending' },
          },
          [],
          new Date().toISOString()
        )
        mockCustomApi.patchNamespacedCustomObjectStatus.mockImplementationOnce(async ({ body }) => {
          // resourceVersion 2 is the terminal teardown record of the ADDED pass (#1349).
          expect(body.metadata).toEqual({ uid: 'uid-lg', resourceVersion: '2' })
          const next = structuredClone(bridge.current()!)
          next.metadata.resourceVersion = '3'
          if (change === 'recreated') next.metadata.uid = 'uid-new'
          else next.status!.conditions = newerFacts
          bridge.replace(next)
          throw { code: 409 }
        })
        legacyDeleteAnswers({ code: 404, message: 'not found' })
        await vi.advanceTimersByTimeAsync(60_000)
        await bridge.drain()
        expect(legacyDeletes()).toBe(2)
        expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(4_999)
        await bridge.drain()
        expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await bridge.drain()
        expect(legacyDeletes()).toBe(2)
        expect(fullReconcile).toHaveBeenCalledTimes(1)
        if (change === 'recreated') {
          expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
          expect(bridge.current()!.metadata.uid).toBe('uid-new')
        } else {
          expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
          expect(
            mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[1][0].body.metadata
          ).toEqual({ uid: 'uid-lg', resourceVersion: '3' })
          expect(ofType(bridge.current()!.status?.conditions, LEGACY_TYPE)).toEqual([])
          expect(ofType(bridge.current()!.status?.conditions, MARKER_TYPE)).toEqual(
            ofType(newerFacts, MARKER_TYPE)
          )
          expect(bridge.current()!.status?.workflowExecution).toEqual({ phase: 'completed' })
        }
        expect(vi.getTimerCount()).toBe(0)
        expect(bridge.queueFailures).not.toHaveBeenCalled()
      }
    )

    it('R5-L3: clearing the retry while its callback waits in the real queue cancels its API work', async () => {
      const inner = installRealInner()
      vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue()
      legacyDeleteAnswers({ code: 403, message: 'forbidden' })
      const bridge = realWatcherBridge(terminalRetryRecipe())
      await bridge.queue.enqueue(RECIPE, () =>
        bridge.watcher.handleRecipeEvent('ADDED', bridge.current()!)
      )
      let release!: () => void
      const blocker = bridge.queue.enqueue(
        RECIPE,
        () =>
          new Promise<void>(resolve => {
            release = resolve
          })
      )
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(60_000)
      bridge.watcher.clearTransientRetry(RECIPE)
      mockCustomApi.getNamespacedCustomObject.mockClear()
      release()
      await blocker
      await bridge.drain()
      expect(mockCustomApi.getNamespacedCustomObject).not.toHaveBeenCalled()
      expect(legacyDeletes()).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(bridge.queueFailures).not.toHaveBeenCalled()
    })
  })

  // A reconcile() prune whose DELETE did not land publishes
  // WorkflowNetworkPoliciesConverged=False/PrunePending. That fact is not a
  // pending retry: the mid-run retry prunes nothing, so the short-circuits
  // must not reapply for it, and the terminal branch must keep it, because
  // the terminal teardown removes pods, not run-lane policies. The finalizer
  // sweep by recipe label is what removes the leftover.
  describe('run-lane NetworkPolicy prune-pending across a run-scoped run', () => {
    const RECIPE = 'pp-recipe'
    const RUN_ID = 'run-pp'
    const GFS = `${RECIPE}-coordinator-to-gfs`
    const LEFTOVER = `${RECIPE}-mcp-host-to-grok-proxy`
    const WRC_LABELS = { 'clerum.io/recipe': RECIPE, 'clerum.io/managed-by': 'wrc' }
    const MARKER_TYPE = 'WorkflowNetworkPoliciesConverged'

    function runScopedRecipe(status: Record<string, unknown>): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: RECIPE,
          namespace: 'sandbox-recipes',
          uid: 'uid-pp',
          labels: { 'clerum.io/workflow-run-id': RUN_ID },
        },
        spec: {
          agent: { provider: 'openai', model: 'gpt-4o' },
          steps: [{ id: 'research', instruction: 'run' }],
        },
        status: status as WorkflowRecipeCRD['status'],
      })
    }

    function markers(conditions: StatusCondition[] | undefined): StatusCondition[] {
      return (conditions ?? []).filter(c => c.type === MARKER_TYPE)
    }

    function deletedPolicyNames(): string[] {
      return mockNetworkingApi.deleteNamespacedNetworkPolicy.mock.calls.map(
        ([arg]) => (arg as { name: string }).name
      )
    }

    // The WRC first-deploy pass with the real inner apply and prune. The
    // leftover is live under the recipe's labels and its DELETE answers 403.
    // The inner reconcile() is reduced to the NetworkPolicy step: the real
    // apply-and-prune, published through the production `reconcile` marker
    // writer. The inner suite pins that reconcile() publishes exactly that
    // writer's conditions for its own pass summary (nit-3), so this stub
    // cannot drift from the translation it stands in for.
    async function failedPrunePass(inner: WorkflowReconciler) {
      mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: { name: LEFTOVER, namespace: 'sandbox-recipes', labels: WRC_LABELS } }],
      })
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(
        async ({ name }: { name: string }) => {
          if (name === LEFTOVER) throw { code: 403, message: 'forbidden' }
          return {}
        }
      )
      const apply = (
        inner as unknown as {
          applyWorkflowNetworkPolicies: (...args: unknown[]) => Promise<NetworkPolicyPassSummary>
        }
      ).applyWorkflowNetworkPolicies.bind(inner)
      vi.spyOn(inner, 'reconcile').mockImplementation(
        async (recipeName, recipeUid, _ns, spec, currentStatus) => {
          const runtime = deriveWorkflowRuntimePlan(spec as never, {
            recipeName: String(recipeName),
            runtimeScopeRecipeName: String(recipeName),
            workflowRunId: RUN_ID,
          })
          const projection = ineligibleProjection()
          const summary = await apply(
            recipeName,
            recipeUid,
            spec,
            runtime,
            false,
            projection,
            false,
            {
              ...projection,
              requiresGrokProxyEgress: false,
            }
          )
          // No retry flag is owed: the pass has nothing pending but the prune.
          expect(summary.retryPending).toBe(false)
          return {
            phase: 'active',
            message: 'Workflow running',
            workflowPhase: 'running',
            networkPolicyOwnershipConditions: networkPolicyMarkerConditions(
              { kind: 'reconcile', summary },
              currentStatus?.conditions,
              new Date().toISOString()
            ),
          }
        }
      )

      const result = await reconciler.reconcile(runScopedRecipe({ phase: 'pending' }))
      // Liveness witness: the prune reached the leftover's DELETE.
      expect(deletedPolicyNames()).toContain(LEFTOVER)
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(async () => ({}))
      return result
    }

    it('publishes PrunePending from a reconcile() prune that could not delete, with no requeue', async () => {
      const inner = installRealInner()

      const result = await failedPrunePass(inner)

      expect(markers(result.networkPolicyOwnershipConditions)).toMatchObject([
        { status: 'False', reason: 'PrunePending' },
      ])
      expect(result.requeueAfterMs).toBeUndefined()
    })

    it('does not reapply from the in-progress short-circuit for a pending prune', async () => {
      const inner = installRealInner()
      const published = (await failedPrunePass(inner)).networkPolicyOwnershipConditions
      const ensureCredentials = vi
        .spyOn(inner, 'ensureMcpHostRuntimeCredentials')
        .mockResolvedValue(undefined)
      vi.spyOn(inner, 'refreshRuntimeHttpEgressNetworkPolicies').mockResolvedValue({
        conflicts: [],
        retryPending: false,
      })
      const retry = vi.spyOn(inner, 'retryRunLaneNetworkPolicies')
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
      const recipe = runScopedRecipe({
        phase: 'deploying',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
        conditions: published,
      })

      const result = await reconciler.reconcile(recipe)

      // Witness: the in-progress short-circuit ran.
      expect(ensureCredentials).toHaveBeenCalled()
      expect(result.message).toBe('Workflow running')
      expect(retry).not.toHaveBeenCalled()
      expect(result.requeueAfterMs).toBeUndefined()
      expect(markers(recipe.status?.conditions)).toMatchObject([
        { status: 'False', reason: 'PrunePending' },
      ])
    })

    it('keeps the PrunePending marker through the terminal teardown, which deletes no run-lane policy', async () => {
      const inner = installRealInner()
      const published = (await failedPrunePass(inner)).networkPolicyOwnershipConditions
      vi.spyOn(inner, 'ensureMcpHostRuntimeCredentials').mockResolvedValue(undefined)
      vi.spyOn(inner, 'refreshRuntimeHttpEgressNetworkPolicies').mockResolvedValue({
        conflicts: [],
        retryPending: false,
      })
      // The real teardown runs: the "no run-lane DELETE" assertion below is
      // only meaningful if the code that could send one executes.
      const teardown = vi.spyOn(inner, 'teardownComputePodsForTerminalRun')
      const retry = vi.spyOn(inner, 'retryRunLaneNetworkPolicies')
      mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
      const recipe = runScopedRecipe({
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: { phase: 'completed' },
        conditions: published,
      })

      // The shared core mock has no single-Pod DELETE; the teardown deletes
      // the run's compute pods one by one.
      const coreApi = mockCoreApi as unknown as Record<string, unknown>
      const deletePod = vi.fn().mockResolvedValue({})
      coreApi.deleteNamespacedPod = deletePod
      try {
        await reconciler.reconcile(recipe)
      } finally {
        delete coreApi.deleteNamespacedPod
      }

      // Witnesses: the terminal branch ran the real teardown, which deleted
      // the run's coordinator pod.
      expect(teardown).toHaveBeenCalledWith(RECIPE)
      expect(deletePod).toHaveBeenCalledWith({
        name: `${RECIPE}-coordinator`,
        namespace: 'sandbox-recipes',
      })
      expect(retry).not.toHaveBeenCalled()
      expect(deletedPolicyNames().filter(name => name !== GFS)).toEqual([])
      expect(markers(recipe.status?.conditions)).toMatchObject([
        { status: 'False', reason: 'PrunePending' },
      ])
    })

    it('removes the leftover from the finalizer sweep', async () => {
      const inner = installRealInner()
      await failedPrunePass(inner)
      // Only the finalizer's own calls are asserted below.
      mockNetworkingApi.listNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: { name: LEFTOVER, namespace: 'sandbox-recipes', labels: WRC_LABELS } }],
      })

      // The shared core mock has no single-Pod DELETE; the finalizer deletes
      // the run's pods one by one before it answers.
      const coreApi = mockCoreApi as unknown as Record<string, unknown>
      const deletePod = vi.fn().mockResolvedValue({})
      coreApi.deleteNamespacedPod = deletePod
      try {
        await reconciler.reconcileDelete(
          runScopedRecipe({ phase: 'active', workflowExecution: { phase: 'completed' } })
        )
      } finally {
        delete coreApi.deleteNamespacedPod
      }

      // Witness: the finalizer ran the workflow cleanup.
      expect(deletePod).toHaveBeenCalledWith({
        name: `${RECIPE}-coordinator`,
        namespace: 'sandbox-recipes',
      })
      expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'sandbox-recipes',
        labelSelector: `clerum.io/recipe=${RECIPE},clerum.io/managed-by=wrc`,
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: LEFTOVER,
        namespace: 'sandbox-recipes',
      })
    })
  })

  // ─── Broker-token issuance failure is non-fatal ─────────────────────────
  //
  // A transient control-api blip during reconcile (e.g. it is mid-restart)
  // used to permanently brick the recipe — phase=failed is a terminal,
  // non-deployable state and the rotation loop alone cannot transition out
  // of it. Reconcile now logs and continues so dependent pods sit in
  // ContainerCreating until the next rotation tick succeeds, rather than
  // the whole recipe getting stuck.
  describe('broker-token issuance failure during reconcile', () => {
    beforeEach(() => {
      vi.spyOn(brokerIssuer, 'issueOAuthBrokerToken').mockReset()
      mockCoreApi.readNamespacedSecret.mockReset()
    })

    function recipeWithBackgroundAccess(): WorkflowRecipeCRD {
      return makeRecipe({
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          oauthClients: [
            {
              id: 'gmail',
              provider: 'google',
              clientIdRef: { name: 'creds', key: 'client-id' },
              clientSecretRef: { name: 'creds', key: 'client-secret' },
              scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
              backgroundAccess: true,
            },
          ],
        },
      })
    }

    it('does not transition the recipe to failed when issueOAuthBrokerToken throws', async () => {
      // Secret missing → reconcile takes the "create" branch, which calls
      // issueOAuthBrokerToken. The mock makes that call time out.
      mockCoreApi.readNamespacedSecret.mockRejectedValue(
        Object.assign(new Error('not found'), { code: 404 })
      )
      vi.spyOn(brokerIssuer, 'issueOAuthBrokerToken').mockRejectedValue(
        new Error('OAuth broker token issuance timed out after 10000ms for recipe "test-recipe"')
      )
      const warnSpy = captureLogger('warn')

      const result = await reconciler.reconcile(recipeWithBackgroundAccess())

      expect(result.phase).not.toBe('failed')
      expect(result.phase).toBe('active')
      // Warning was emitted so the operator can see what happened.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Broker-token issuance failed during reconcile'),
        expect.objectContaining({ err: expect.any(Error) })
      )
      // Workloads still deployed.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      warnSpy.mockRestore()
    })
  })

  // ─── Transient API-server blip must not latch a healthy recipe ──────────
  //
  // A momentary controller↔API partition (connect ETIMEDOUT) used to throw
  // mid-reconcile and flip an otherwise-healthy recipe to the terminal
  // `failed` phase, which the skip guard then refused to re-process — a
  // false-positive failure with no self-recovery. Reconcile now classifies
  // retryable infra errors and leaves the recipe alone so the next resync
  // retries, and re-reconciles a transiently-latched recipe back to active.
  describe('transient infra error handling', () => {
    function etimedout(): Error {
      return Object.assign(
        new Error(
          'request to https://203.0.113.10/api/v1/namespaces/sandbox-recipes/services/app failed, reason: connect ETIMEDOUT 203.0.113.10:443'
        ),
        { code: 'ETIMEDOUT', name: 'FetchError' }
      )
    }

    it('does not latch an active recipe to failed when an API call times out', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // A K8s call deep in the pipeline (Service create) times out at connect.
      mockCoreApi.createNamespacedService.mockRejectedValueOnce(etimedout())

      const recipe = makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).not.toBe('failed')
      expect(result.phase).toBe('active')
      // Status is left untouched — no churn, no false "Failed" in the UI.
      expect(result.skipStatusPatch).toBe(true)
      // Prior workload readiness is preserved, not wiped to [].
      expect(result.workloadStatuses).toEqual([
        { id: 'app', phase: 'deployed', ready: true, message: undefined },
      ])
    })

    it('does not latch an active recipe to failed when the API server returns a top-level 5xx', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockCoreApi.createNamespacedService.mockRejectedValueOnce({
        statusCode: 503,
        message: 'apiserver temporarily unavailable',
      })

      const recipe = makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('active')
      expect(result.message).toBe('All workloads deployed')
      expect(result.skipStatusPatch).toBe(true)
      expect(result.requeueAfterMs).toBeGreaterThan(0)
      expect(result.workloadStatuses).toEqual([
        { id: 'app', phase: 'deployed', ready: true, message: undefined },
      ])
    })

    it('re-reconciles a recipe latched in failed by a transient message and recovers it to active', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message:
            'FetchError: request to https://203.0.113.10/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 203.0.113.10:443',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)

      // Self-healed: the pipeline ran and drove it back to active.
      expect(result.phase).toBe('active')
      expect(result.message).toBe('All workloads deployed')
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalled()
    })

    it('re-reconciles a recipe failed by shared mcp-server internal dependency boundary', async () => {
      installLiveStore(
        {
          read: mockAppsApi.readNamespacedDeployment,
          create: mockAppsApi.createNamespacedDeployment,
          replace: mockAppsApi.replaceNamespacedDeployment,
        },
        { readyReplicas: 1 }
      )
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [
                { name: 'DB_HOST', value: '{{db:host}}' },
                {
                  name: 'CONTACT_FINDER_MCP_URL',
                  value: 'http://mcp-contact-finder.mcp-server.svc.cluster.local:3000/mcp',
                },
              ],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
        status: {
          phase: 'failed',
          message:
            'Workload "api" env.CONTACT_FINDER_MCP_URL references cluster-local host "mcp-contact-finder.mcp-server.svc.cluster.local", but it is not an eligible runtime Service in WorkflowRecipe "test-recipe"',
          conditions: [
            {
              type: 'InternalDependenciesReady',
              status: 'False',
              reason: 'InvalidInternalDependency',
              message:
                'Workload "api" env.CONTACT_FINDER_MCP_URL references cluster-local host "mcp-contact-finder.mcp-server.svc.cluster.local", but it is not an eligible runtime Service in WorkflowRecipe "test-recipe"',
              lastTransitionTime: '2026-06-08T00:00:00.000Z',
            },
          ],
          workloads: [{ id: 'api', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('active')
      expect(result.internalDependencyConditions?.[0]).toMatchObject({
        type: 'InternalDependenciesReady',
        status: 'True',
        reason: 'Reconciled',
      })
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalled()
      const internalPolicies = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => call[0].body)
        .filter(
          policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'internal-dependency'
        )
      expect(internalPolicies.map(policy => policy.metadata?.name)).toEqual([
        'wr-intdep-egress-test-recipe-api',
        'wr-intdep-ingress-test-recipe-db',
      ])
    })

    it('still skips a recipe that failed for a non-transient, recipe-specific reason', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: 'All workloads excluded by includeWhen conditions',
          workloads: [],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(result.message).toContain('excluded')
      // Guard held — the deploy pipeline never ran.
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a policy-violation failure even when the message embeds a transient token (security)', async () => {
      // A policy-rejected recipe whose operator-controlled image is named to
      // smuggle "ETIMEDOUT" into the persisted "Policy violation: …" message.
      // The transient self-heal exception must NOT fire — otherwise the
      // alreadyPolicyFailed idempotency guard would skip re-enforcement and the
      // policy-rejected workload would deploy.
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message:
            'Policy violation: [pol] imageAllowlist: Workload "app" image "docker.io/evil:ETIMEDOUT" not in allowlist',
          workloads: [],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(result.message).toContain('Policy violation:')
      // Critical: the deploy pipeline must NOT run for a policy-failed recipe.
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a policy-violation failure with a stale shared mcp-server internal-dependency condition (security)', async () => {
      const staleBoundaryMessage =
        'Workload "api" env.CONTACT_FINDER_MCP_URL references cluster-local host "mcp-contact-finder.mcp-server.svc.cluster.local", but it is not an eligible runtime Service in WorkflowRecipe "test-recipe"'
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message:
            'Policy violation: [pol] imageAllowlist: Workload "api" image "docker.io/evil:latest" not in allowlist',
          conditions: [
            {
              type: 'InternalDependenciesReady',
              status: 'False',
              reason: 'InvalidInternalDependency',
              message: staleBoundaryMessage,
              lastTransitionTime: '2026-06-08T00:00:00.000Z',
            },
          ],
          workloads: [],
        },
      })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(result.message).toContain('Policy violation:')
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    })

    it('re-enforces policy on the self-heal path: a transient-latched recipe is still rejected by an active denylist (security invariant)', async () => {
      // The fix's safety rests on policy ALWAYS re-running before deploy on the
      // self-heal path. This recipe IS self-heal-eligible (genuine transient
      // message, not a "Policy violation:" one) but its image violates an
      // active denylist policy. It must re-fail at policy enforcement, never
      // reaching resource creation.
      const recipe = makeRecipe({
        spec: {
          workloads: [
            { id: 'app', type: 'deployment', image: 'docker.io/evil:latest', port: 8080 },
          ],
        },
        status: {
          phase: 'failed',
          message:
            'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const denyPolicy = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipePolicy',
        metadata: { name: 'deny-evil', namespace: 'sandbox-recipes' },
        // `**` globstar matches across `/` path segments (single `*` would not).
        spec: { detection: { imageDenylist: ['**evil**'] } },
      }
      mockCustomApi.listNamespacedCustomObject.mockImplementation((args: { plural?: string }) =>
        Promise.resolve({
          items: args?.plural === 'workflowrecipepolicies' ? [denyPolicy] : [],
        })
      )
      try {
        const result = await reconciler.reconcile(recipe)

        // Self-heal was eligible, but policy re-enforcement rejected it first.
        expect(result.phase).toBe('failed')
        expect(result.message).toContain('Policy violation:')
        expect(result.message).toContain('denylist')
        // Invariant: a denylisted image never deploys, even via self-heal.
        expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      } finally {
        mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })
      }
    })

    // The exact persisted messages observed on dev (helpdesk / leadforge / recap)
    // when the controller↔API-server link blipped mid-reconcile.
    it('self-heals recipes latched by the real dev API-timeout messages', async () => {
      const devMessages = [
        // helpdesk — pre-deploy Context allowlist fetch
        'Error: Pre-deploy failed for WorkflowRecipe "recipe-helpdesk-v1-0-0-4549198b". WRC cannot start transport workloads until HCC can reconcile child McpServers: Error: Pre-deploy Context allowlist failed for "recipe-helpdesk-v1-0-0-4549198b": request to https://203.0.113.10/apis/clerum.io/v1alpha1/namespaces/mcp-server/contexts/context1 failed, reason: connect ETIMEDOUT 203.0.113.10:443',
        // leadforge — NetworkPolicy fetch
        'FetchError: request to https://203.0.113.10/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies/wl-egress-recipe-leadforge-app-v1-0-0-bdb457b6-prospector-api failed, reason: connect ETIMEDOUT 203.0.113.10:443',
        // recap — NetworkPolicy list
        'FetchError: request to https://203.0.113.10/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 203.0.113.10:443',
      ]
      for (const message of devMessages) {
        const recipe = makeRecipe({
          status: {
            phase: 'failed',
            message,
            workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
          },
        })
        const result = await reconciler.reconcile(recipe)
        expect(result.phase, message).toBe('active')
      }
    })

    // ── Observed-health self-heal (fix #3) ──────────────────────────────
    // The durable backstop: even when the latched message is NOT recognized
    // by the transport-error classifier, a recipe whose last-observed
    // workloads were all ready must re-derive its phase from live health
    // rather than staying stuck at `failed`. This is the exact worktracker
    // pre-deploy incident — the message ("Pre-deploy failed … cannot start
    // transport workloads … Reconciler will retry") carries no `connect
    // ETIMEDOUT`/`reason:` shape, so isRetryableInfraError(message) is false.
    const worktrackerLatchMessage =
      'Pre-deploy failed for WorkflowRecipe "test-recipe". WRC cannot start transport ' +
      'workloads until HCC can reconcile child McpServers: Error: Pre-deploy failed for ' +
      'workload(s): wt-mcp. Reconciler will retry to ensure all NetworkPolicies are applied ' +
      'before workloads start.'

    it('self-heals a failed recipe with an UNRECOGNIZED message when all observed workloads are ready', async () => {
      // Guard against a false positive from the transport classifier — the
      // recovery here must come from observed health, not message matching.
      expect(isRetryableInfraError(worktrackerLatchMessage)).toBe(false)
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: worktrackerLatchMessage,
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('active')
    })

    it('does NOT self-heal a failed recipe with NO observed workloads (pre-workload failure stays terminal)', async () => {
      // status.workloads empty ⇒ the recipe failed before any workload was
      // observed healthy (bad spec, pre-deploy never succeeded). Re-running it
      // would churn; it must stay skipped at `failed`.
      const recipe = makeRecipe({
        status: { phase: 'failed', message: worktrackerLatchMessage, workloads: [] },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toBe(worktrackerLatchMessage)
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a failed recipe when an observed workload is not ready', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: worktrackerLatchMessage,
          workloads: [
            { id: 'app', type: 'deployment', phase: 'deployed', ready: true },
            { id: 'db', type: 'statefulset', phase: 'pending', ready: false },
          ],
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a policy-violation failure even with all observed workloads ready (security)', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: 'Policy violation: [deny-evil] imageDenylist: image matches **evil**',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toContain('Policy violation:')
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a genuinely failed WORKFLOW run even when its workloads are ready', async () => {
      // For a workflow, workload readiness ≠ run success. A real "Workflow
      // failed" must stay terminal — the observed-health heuristic is scoped
      // to non-workflow recipes only.
      const recipe = makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search' }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        },
        status: {
          phase: 'failed',
          message: 'Workflow failed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
          workflowExecution: { phase: 'failed', message: 'step research crashed' },
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
    })

    it('keeps phase + requeues when a live NetworkPolicy create times out (leadforge path)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const kc = new k8s.KubeConfig()
      const r = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.34'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(
          new Error(
            'request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443'
          ),
          { code: 'ETIMEDOUT', name: 'FetchError' }
        )
      )
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.6-alpine',
              port: 8080,
              egressBindings: [{ dns: 'api.example.com', port: 443 }],
            },
          ],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await r.reconcile(recipe)

      expect(result.phase).not.toBe('failed')
      expect(result.skipStatusPatch).toBe(true)
      expect(result.requeueAfterMs).toBeGreaterThan(0)
    })

    it('self-heals a child workflow latched failed by an API timeout via the recovering handoff', async () => {
      // The recipe phase is failed and the top-level message is just "Workflow
      // failed" — the transient timeout lives on the INNER workflowExecution.
      const recipe = makeRecipe({
        spec: { steps: [{ id: 'render', run: snippetRun() }] },
        status: {
          phase: 'failed',
          message: 'Workflow failed',
          workflowExecution: {
            phase: 'failed',
            message:
              'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
          },
        },
      })
      const kc = new k8s.KubeConfig()
      const r = new WorkflowRecipeReconciler(kc)
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure recreated',
        workflowPhase: 'recovering',
      })
      ;(
        r as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await r.reconcile(recipe)

      // Terminal guard bypassed → inner reconcile invoked for recovery...
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      // ...with a `recovering` execution phase (not the stale `failed`),
      // preserving the original inner message.
      const inboundStatus = workflowReconcile.mock.calls[0][4] as {
        workflowExecution?: { phase?: string; message?: string }
      }
      expect(inboundStatus.workflowExecution?.phase).toBe('recovering')
      expect(inboundStatus.workflowExecution?.message).toContain('ETIMEDOUT')
      // Did NOT re-confirm the terminal failure.
      expect(result.phase).not.toBe('failed')
    })

    it('self-heals a workflow latched failed by a transient status.message with NO workflowExecution (fresh path)', async () => {
      // Edge case: latchedByTransientError is true via status.message alone, but
      // there is no existing workflowExecution to hand a `recovering` phase to.
      // The recovery handoff must NOT fire (nothing to preserve); the inner
      // reconciler starts fresh and the recipe is not re-latched failed.
      const recipe = makeRecipe({
        spec: { steps: [{ id: 'render', run: snippetRun() }] },
        status: {
          phase: 'failed',
          message:
            'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
          // NOTE: no workflowExecution — recipe failed before one was persisted.
        },
      })
      const kc = new k8s.KubeConfig()
      const r = new WorkflowRecipeReconciler(kc)
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure created',
        workflowPhase: 'deploying',
      })
      ;(
        r as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await r.reconcile(recipe)

      // Terminal guard bypassed (transient) → inner reconcile invoked for a fresh start.
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      // No `recovering` handoff: inboundStatus.workflowExecution is undefined
      // because there was no existing execution to preserve.
      const inboundStatus = workflowReconcile.mock.calls[0][4] as {
        workflowExecution?: unknown
      }
      expect(inboundStatus.workflowExecution).toBeUndefined()
      // Did NOT re-latch the terminal failure.
      expect(result.phase).not.toBe('failed')
    })
  })

  // ── issue #375 BLOCKER (jozer-rami review): clientNotifications-only workflow-
  // lane SDK recipes must FALL THROUGH the two active-phase short-circuits (the
  // awaiting-trigger one and the steady-active one) the same way promptBridge
  // does, so the inner reconcile gathers the bootstrap proof and the capability
  // projects `validated` with NO skipStatusPatch. Before the fix both
  // short-circuits returned skipStatusPatch:true, shouldPatchRecipeStatus bailed
  // at its first line, and the awaiting_policy→validated transition was never
  // published — the original #375 symptom, unchanged, for that family.
  describe('issue #375 BLOCKER — clientNotifications-only workflow-lane fall-through', () => {
    const CN_MESSAGE = 'Workflow trigger infrastructure registered'

    function clientNotificationsOnlyRecipe(labels?: Record<string, string>): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          ...(labels ? { labels } : {}),
        },
        spec: {
          steps: [{ id: 'step-1', run: snippetRun() }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: {
            clientNotifications: { allowedEventTypes: ['workflow.completed'] },
            allowedCallers: ['app'],
          },
        },
        status: {
          phase: 'active',
          message: CN_MESSAGE,
          pluginWorkloadSdk: {
            state: 'awaiting_policy',
            promptBridge: false,
            clientNotifications: true,
            message: 'Plugin Workload SDK clientNotifications is awaiting an operator grant',
            verifiedAt: new Date(Date.now() - 10_000).toISOString(),
          } as never,
        },
      })
    }

    function stubWorkflowReconciler() {
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'active',
        message: CN_MESSAGE,
        pluginWorkloadSdkBootstrapProof: {
          ready: true,
          contractVersion: 2,
          podUid: 'sdk-pod-uid',
          policyReady: true,
          clientNotificationsPolicyReady: true,
          verifiedAt: new Date().toISOString(),
        },
      })
      const reconcilePluginWorkloadSdkOnly = vi.fn()
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = {
        reconcile: workflowReconcile,
        reconcilePluginWorkloadSdkOnly,
        validateWorkflowSpec: () => undefined,
      }
      return { workflowReconcile, reconcilePluginWorkloadSdkOnly }
    }

    it('awaiting-trigger lane: recomputes and publishes awaiting_policy→validated (no skipStatusPatch)', async () => {
      // Phase active + mcpHost required (flag ON) + no run label + no
      // workflowExecution ⇒ the awaiting-trigger short-circuit. Pre-fix this
      // returned skipStatusPatch:true without ever calling the inner reconcile.
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = clientNotificationsOnlyRecipe()

      const result = await reconciler.reconcile(recipe)

      // Fall-through proof: the inner reconcile actually ran (steps present ⇒
      // the stepless SDK-only adapter must NOT be used).
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
      // The reconcile pass has an SDK opinion and does not suppress the patch.
      expect(result.skipStatusPatch).toBeFalsy()
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      // The full chain the incident depends on: the watcher would publish it.
      expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
    })

    it('steady-active lane (run-labelled): recomputes and publishes awaiting_policy→validated (no skipStatusPatch)', async () => {
      // Phase active + run-id label ⇒ awaitsTriggeredRun=false ⇒ the steady-
      // active short-circuit, which pre-fix returned skipStatusPatch:true
      // unconditionally (no family carve-out at all).
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = clientNotificationsOnlyRecipe({ 'clerum.io/workflow-run-id': 'run-e2e-1' })

      const result = await reconciler.reconcile(recipe)

      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
      expect(result.skipStatusPatch).toBeFalsy()
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
    })

    it('steady-active lane (run-labelled): promptBridge recipes ALSO fall through (no family re-carve)', async () => {
      // Side effect of the carve-out being family-agnostic: a promptBridge SDK
      // recipe in phase active, run-labelled (awaitsTriggeredRun false), with NO
      // in-progress execution, falls through the steady-active short-circuit
      // too — intended, bounded by the verifiedAt throttle. This pin turns RED
      // if the condition is ever re-carved by family (e.g.
      // `!recipe.spec.pluginWorkloadSdk?.clientNotifications`) or reverted to
      // the unconditional skipStatusPatch:true return.
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          labels: { 'clerum.io/workflow-run-id': 'run-e2e-4' },
        },
        spec: {
          steps: [{ id: 'step-1', run: snippetRun() }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
        status: {
          phase: 'active',
          message: CN_MESSAGE,
          pluginWorkloadSdk: {
            state: 'awaiting_policy',
            promptBridge: true,
            clientNotifications: false,
            message: 'Plugin Workload SDK promptBridge is awaiting an operator grant',
            verifiedAt: new Date(Date.now() - 10_000).toISOString(),
          } as never,
        },
      })

      const result = await reconciler.reconcile(recipe)

      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
      expect(result.skipStatusPatch).toBeFalsy()
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
    })

    it('steady-active lane with an IN-PROGRESS execution: SDK recipes still short-circuit (409-window protection)', async () => {
      // The carve-out is bounded: while a workflow execution is in progress the
      // steady-active short-circuit is KEPT even for SDK recipes — that branch
      // protects the coordinator's 409-free windows, and the capability
      // publication is level-triggered so it lands on the next non-running
      // pass. Removing the `|| wfInProgress` term from the carve-out condition
      // turns this RED: the running recipe would fall through to the inner
      // reconcile and drop skipStatusPatch.
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = clientNotificationsOnlyRecipe({ 'clerum.io/workflow-run-id': 'run-e2e-3' })
      recipe.status = {
        ...recipe.status,
        phase: 'active',
        workflowExecution: { phase: 'running' },
      } as typeof recipe.status

      const result = await reconciler.reconcile(recipe)

      expect(result.skipStatusPatch).toBe(true)
      expect(workflowReconcile).not.toHaveBeenCalled()
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
    })

    it('non-SDK workflow recipes keep both steady-state short-circuits (no regression)', async () => {
      // The carve-out is SDK-scoped: a plain workflow recipe in the same two
      // shapes must still short-circuit with skipStatusPatch:true and must NOT
      // reach the inner reconcile on every steady tick.
      const { workflowReconcile } = stubWorkflowReconciler()
      const awaitingTrigger = makeRecipe({
        spec: {
          steps: [{ id: 'step-1', instruction: 'run' }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        },
        status: { phase: 'active', message: CN_MESSAGE },
      })
      const awaitingResult = await reconciler.reconcile(awaitingTrigger)
      expect(awaitingResult.skipStatusPatch).toBe(true)
      expect(workflowReconcile).not.toHaveBeenCalled()

      const runLabelled = makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          labels: { 'clerum.io/workflow-run-id': 'run-e2e-2' },
        },
        spec: {
          steps: [{ id: 'step-1', run: snippetRun() }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
        },
        status: { phase: 'active', message: CN_MESSAGE },
      })
      const steadyResult = await reconciler.reconcile(runLabelled)
      expect(steadyResult.skipStatusPatch).toBe(true)
      expect(workflowReconcile).not.toHaveBeenCalled()
    })
  })

  // ── issue #375 M1 (jozer review): the projection WIRING is pinned against the
  // real pipeline, not hand-built ReconcileResults. Each test goes RED if its
  // wiring line is neutered:
  //   - reconcile() must ATTACH result.pluginWorkloadSdkProjection (the single
  //     line the whole P1 fix hangs on),
  //   - projectPluginWorkloadSdk must pass the persisted capability through as
  //     existingCapability (the R1 validatedAt carry-forward),
  //   - patchStatus must REUSE the attached projection instead of recomputing.
  describe('issue #375 M1 — projection wiring through the real pipeline', () => {
    it('reconcile() attaches a populated pluginWorkloadSdkProjection to every result', async () => {
      // Non-SDK recipe: the projection must still be attached (capability null =
      // "clear the field"), proving production populates it on EVERY reconcile.
      const result = await reconciler.reconcile(makeRecipe())
      expect(result.pluginWorkloadSdkProjection).toBeDefined()
      expect(result.pluginWorkloadSdkProjection?.capability).toBeNull()
    })

    it('reconcile() projects the SDK-only lane bootstrap proof into a validated capability', async () => {
      const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: {
          ready: true,
          contractVersion: 2,
          podUid: 'sdk-pod-uid',
          provider: 'zai',
          model: 'glm-4.7',
          policyReady: true,
          verifiedAt: '2026-08-04T00:00:00.000Z',
        },
        networkPolicies: {
          conflicts: [],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          }
        }
      ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

      const result = await reconciler.reconcile(
        makeRecipe({
          spec: {
            agent: { provider: 'zai', model: 'glm-4.7' },
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
          },
        })
      )

      // The REAL pipeline attached the projection and it carries the computed
      // capability — no test-side hand-building involved.
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(result.pluginWorkloadSdkProjection?.capability?.bootstrapPodUid).toBe('sdk-pod-uid')
    })

    it('carries forward the persisted validatedAt on a steady validated capability (R1 wiring)', async () => {
      const FIRST_VALIDATED_AT = '2026-08-01T00:00:00.000Z'
      const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: {
          ready: true,
          contractVersion: 2,
          podUid: 'sdk-pod-uid',
          provider: 'zai',
          model: 'glm-4.7',
          policyReady: true,
          verifiedAt: new Date().toISOString(),
        },
        networkPolicies: {
          conflicts: [],
          retryPending: false,
          prune: 'converged',
          legacy: 'removed',
        },
      })
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          }
        }
      ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

      const result = await reconciler.reconcile(
        makeRecipe({
          spec: {
            agent: { provider: 'zai', model: 'glm-4.7' },
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 },
            ],
            pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
          },
          status: {
            phase: 'active',
            pluginWorkloadSdk: {
              state: 'validated',
              promptBridge: true,
              clientNotifications: false,
              validatedAt: FIRST_VALIDATED_AT,
              verifiedAt: new Date(Date.now() - 60_000).toISOString(),
            } as never,
          },
        })
      )

      // existingCapability wiring (workflowRecipeReconciler.ts): the stable
      // validatedAt marker must be CARRIED FORWARD, not re-stamped to `now`.
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(result.pluginWorkloadSdkProjection?.capability?.validatedAt).toBe(FIRST_VALIDATED_AT)
    })

    it('patchStatus REUSES the attached projection instead of recomputing it', async () => {
      // The attached projection is deliberately DISTINCT from anything
      // patchStatus could recompute from this recipe/result (no bootstrap proof
      // ⇒ a recompute projects degraded/BootstrapNotReady). If patchStatus
      // recomputes instead of reusing, the marker never reaches the patch body.
      const recipe = makeRecipe({
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.6-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
        status: { phase: 'active' },
      })
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true

      const attachedCapability = {
        state: 'validated' as const,
        promptBridge: true,
        clientNotifications: false,
        message: 'REUSED-PROJECTION-MARKER',
        bootstrapPodUid: 'marker-pod',
        verifiedAt: new Date().toISOString(),
      }
      await reconciler.patchStatus(recipe, {
        phase: 'active',
        message: 'All workloads deployed',
        workloadStatuses: [],
        pluginWorkloadSdkProjection: {
          conditions: [
            {
              type: 'PluginWorkloadSdkCapability',
              status: 'True',
              reason: 'Validated',
              message: 'REUSED-PROJECTION-MARKER',
              lastTransitionTime: new Date().toISOString(),
            },
          ],
          capability: attachedCapability as never,
        },
      })

      const patchCall = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)?.[0] as {
        body: { status: { pluginWorkloadSdk?: { message?: string; bootstrapPodUid?: string } } }
      }
      expect(patchCall.body.status.pluginWorkloadSdk?.message).toBe('REUSED-PROJECTION-MARKER')
      expect(patchCall.body.status.pluginWorkloadSdk?.bootstrapPodUid).toBe('marker-pod')
    })
  })
})
