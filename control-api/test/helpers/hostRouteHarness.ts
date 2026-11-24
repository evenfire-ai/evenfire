/**
 * control-api's real Host routes over an in-memory apiserver, for route tests
 * that need the real `ResourceService` (administrative intents, the post-write
 * generation patch, the replace preconditions) without a cluster or Postgres.
 *
 * `buildHostRouteHarness` returns an Express app wired like `src/app.ts` for an
 * authenticated operator: the JSON parser, the correlation-id middleware, an
 * administrative request context on every `/api/v1/admin` request (`app.ts`
 * `runWithAdministrativeRequestContext`), the hosts overview router (`/detail`)
 * mounted before the resources router (Host GET, POST and PUT), the `/admin`
 * catch-all 404 and `clerumErrorHandler`. Behind the routes:
 *
 * - the real `ResourceService` over a stub `customApi`, the in-memory apiserver
 *   described below. The gateway the routers get is that service plus Secret
 *   reads with no Secrets: `listSecrets` answers none and `getSecret` 404s;
 * - a stub administrative-operation service, set with
 *   `setAdministrativeOperationService`, which gives every Host write an intent
 *   with a deterministic operation id and records each call;
 * - Postgres: `pool.connect` and `pool.query` are spied, as
 *   ./accessTransactionTripwire.ts does, so the real `withTransaction`, advisory
 *   locks and idle bound run over a fake client. It answers the two
 *   `llm_allowed_models` reads of the Host model checks from `allowedModels`,
 *   the directory reads of `/detail` with no rows, and the transaction's own
 *   statements with no rows. Any other statement throws, so a route that starts
 *   reading another table fails loudly instead of reading an empty one.
 *
 * No `vi.mock` is needed in the test file. Call `dispose()` after each test: it
 * restores the Postgres spies and clears the administrative-operation service.
 *
 * The in-memory apiserver models what these routes depend on:
 * - a replace must carry the stored `resourceVersion`, and the stored uid when
 *   it names one; otherwise 409. A merge patch is checked the same way when it
 *   carries a `resourceVersion`;
 * - a write that changes the object issues a new `resourceVersion` (one counter
 *   for the whole store, as etcd's revision); a write that changes nothing keeps
 *   the object and its version;
 * - `metadata.generation` moves only when the spec changes: the Host CRD has a
 *   status subresource (charts/clerum-crds/crds/host.yaml);
 * - a replace or patch keeps `status`, `uid`, `creationTimestamp` and
 *   `managedFields`;
 * - `patchNamespacedCustomObject` is a JSON merge patch (RFC 7386), the strategy
 *   of `reconcileAdministrativeIntentGeneration`;
 * - on every create, replace and patch, a Host's `spec.approval` is pruned and
 *   defaulted with the Host CRD fixture (control-ui/test/fixtures/hostCrdApproval.ts),
 *   the same model the fake control-api uses. Seeds are stored as given;
 * - errors are `@kubernetes/client-node` `ApiException`s carrying a metav1
 *   Status body, as the real client throws them.
 * There is no delete.
 */
import { type MockInstance, vi } from 'vitest'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { ApiException } from '@kubernetes/client-node'
import { EventEmitter } from 'node:events'
import {
  type HostCrdApprovalVersion,
  defaultApprovalBlock,
  loadHostCrdApprovalSchema,
  pruneApprovalBlock,
} from '../../../control-ui/test/fixtures/hostCrdApproval'
import { config } from '../../src/config.js'
import { pool } from '../../src/db.js'
import { clerumErrorHandler } from '../../src/http/errorHandler.js'
import { correlationIdMiddleware } from '../../src/middleware/correlationId.js'
import { createAdminHostsOverviewRouter } from '../../src/routes/admin/hostsOverview.js'
import { createAdminResourcesRouter } from '../../src/routes/admin/resources.js'
import {
  ResourceService,
  setAdministrativeOperationService,
} from '../../src/services/resourceService.js'
import { runWithAdministrativeRequestContext } from '../../src/services/tracing/adminOperationContext.js'
import type {
  ControlApiAdministrativeOperationService,
  HostAdministrativeAction,
  HostAdministrativeIntent,
  HostAdministrativeOutcome,
} from '../../src/services/tracing/adminOperationService.js'
import { CLERUM_GROUP, CLERUM_VERSION, type ClerumResourceType } from '../../src/types.js'

/** An object as the apiserver stores it. */
export type HarnessObject = {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    generation?: number
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    managedFields?: unknown[]
    [key: string]: unknown
  }
  spec?: Record<string, unknown>
  status?: unknown
  [key: string]: unknown
}

/** One `llm_allowed_models` row, as the Host model checks read it. */
export type HarnessAllowedModel = {
  provider: string
  model: string
  enabled: boolean
  stale: boolean
}

/** A body the routes sent to the apiserver. */
export type HarnessWrite = {
  plural: string
  namespace: string
  name: string
  body: HarnessObject
}

export type PersistHostIntentInput = {
  action: HostAdministrativeAction
  namespace: string
  name: string
  operatorSub: string
  requestId: string | null
}

/** One call to the stub administrative-operation service, in call order. */
export type AdministrativeOperationCall =
  | { method: 'persistHostIntent'; input: PersistHostIntentInput; intent: HostAdministrativeIntent }
  | {
      method: 'persistHostOutcome'
      intent: HostAdministrativeIntent
      outcome: HostAdministrativeOutcome
      reasonCode: string
    }

export type HostRouteHarnessOptions = {
  /** The Host CRD whose approval schema the apiserver prunes and defaults with. Default `current`. */
  crd?: HostCrdApprovalVersion
  /** The `llm_allowed_models` rows. Default none, so every model is refused. */
  allowedModels?: HarnessAllowedModel[]
  /** The authenticated operator of every request. */
  operatorSub?: string
}

export interface HarnessStore {
  /**
   * Stores an object as given, in its plural's namespace unless it names one,
   * and fills the server fields it lacks (uid, creationTimestamp, generation 1,
   * a new resourceVersion). Returns a copy of the stored object.
   */
  seed(plural: ClerumResourceType, object: HarnessObject): HarnessObject
  /** A copy of the stored object, or undefined. */
  get(plural: ClerumResourceType, name: string, namespace?: string): HarnessObject | undefined
}

export interface HostRouteHarness {
  app: Express
  store: HarnessStore
  /** Every replace body, in order, including refused ones. */
  replaceBodies: HarnessWrite[]
  /** Every merge-patch body, in order, including refused ones. */
  patchBodies: HarnessWrite[]
  adminOperations: AdministrativeOperationCall[]
  /** Restores the Postgres spies and clears the administrative-operation service. */
  dispose(): void
}

// The namespace map K8sGateway gives its ResourceService (src/k8s.ts).
const RESOURCE_NAMESPACES: Partial<Record<ClerumResourceType, string>> = {
  hosts: config.hostsNamespace,
  contexts: config.contextsNamespace,
  communicationchannels: config.communicationChannelsNamespace,
  mcpservers: config.mcpServersNamespace,
  llmhooks: config.llmHooksNamespace,
  workflowrecipes: config.sandboxNamespace,
  workflowrecipepolicies: config.sandboxNamespace,
  sharedfilesystems: config.sharedFilesystemsNamespace,
}

const DEFAULT_OPERATOR_SUB = 'host-route-harness-operator'
const CREATION_TIMESTAMP = '2026-11-01T00:00:00Z'
const EMPTY_RESULT = Object.freeze({ rows: [], rowCount: 0 })

// The two statements of src/services/llmAllowedModels.ts the Host model checks
// run, whitespace collapsed.
const IS_MODEL_ALLOWED_SQL =
  'SELECT 1 FROM llm_allowed_models WHERE provider = $1 AND model = $2 AND enabled LIMIT 1'
const MODEL_ALLOWLIST_STATE_SQL =
  'SELECT enabled, stale FROM llm_allowed_models WHERE provider = $1 AND model = $2 LIMIT 1'
// The directory reads of the /detail bundle (src/services/directory).
const DIRECTORY_READ = /\bFROM (?:users|teams|user_agents|team_agents)\b/

type QueryResult = { rows: unknown[]; rowCount: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A JSON copy: what crosses the apiserver's wire. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Equality of JSON values; object key order is ignored, array order is not. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    )
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    )
  }
  return a === b
}

/** RFC 7386: a `null` deletes, an object merges, anything else replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch
  const merged: Record<string, unknown> = isRecord(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = mergePatch(merged[key], value)
  }
  return merged
}

function deterministicId(variant: string, n: number): string {
  return `00000000-0000-4000-${variant}-${String(n).padStart(12, '0')}`
}

function kubernetesStatus(code: number, reason: string, message: string): ApiException<unknown> {
  return new ApiException(
    code,
    message,
    { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason, code },
    {}
  )
}

function createApiserver(crd: HostCrdApprovalVersion) {
  const schema = loadHostCrdApprovalSchema(crd)
  const objects = new Map<string, HarnessObject>()
  const replaceBodies: HarnessWrite[] = []
  const patchBodies: HarnessWrite[] = []
  let revision = 0
  let uids = 0
  const nextVersion = () => String((revision += 1))
  const keyOf = (namespace: string, plural: string, name: string) =>
    `${namespace}/${plural}/${name}`
  const notFound = (plural: string, name: string) =>
    kubernetesStatus(404, 'NotFound', `${plural}.${CLERUM_GROUP} "${name}" not found`)
  const conflict = (plural: string, name: string, why: string) =>
    kubernetesStatus(
      409,
      'Conflict',
      `Operation cannot be fulfilled on ${plural}.${CLERUM_GROUP} "${name}": ${why}`
    )

  /** The apiserver's decode of a Host write: `spec.approval` pruned and defaulted. */
  function admit(plural: string, object: HarnessObject): HarnessObject {
    if (plural !== 'hosts' || !isRecord(object.spec) || !isRecord(object.spec.approval)) {
      return object
    }
    const approval = defaultApprovalBlock(pruneApprovalBlock(object.spec.approval, schema), schema)
    return { ...object, spec: { ...object.spec, approval } }
  }

  function requireCurrent(namespace: string, plural: string, name: string): HarnessObject {
    const current = objects.get(keyOf(namespace, plural, name))
    if (!current) throw notFound(plural, name)
    return current
  }

  /** The server fields of an update, then the write, unless nothing changed. */
  function update(
    namespace: string,
    plural: string,
    current: HarnessObject,
    admitted: HarnessObject
  ): HarnessObject {
    const generation = current.metadata.generation ?? 1
    const next = copy({
      ...admitted,
      metadata: {
        ...admitted.metadata,
        uid: current.metadata.uid,
        creationTimestamp: current.metadata.creationTimestamp,
        generation: sameJson(admitted.spec, current.spec) ? generation : generation + 1,
        managedFields: current.metadata.managedFields,
        resourceVersion: current.metadata.resourceVersion,
      },
      // The main endpoint never writes status (status subresource).
      status: current.status,
    })
    if (sameJson(next, current)) return copy(current)
    next.metadata.resourceVersion = nextVersion()
    objects.set(keyOf(namespace, plural, current.metadata.name), next)
    return copy(next)
  }

  type Target = { namespace: string; plural: string; name: string }

  const customApi = {
    async getNamespacedCustomObject({ namespace, plural, name }: Target) {
      return copy(requireCurrent(namespace, plural, name))
    },
    async listNamespacedCustomObject({ namespace, plural }: Omit<Target, 'name'>) {
      const prefix = keyOf(namespace, plural, '')
      return {
        apiVersion: `${CLERUM_GROUP}/${CLERUM_VERSION}`,
        kind: 'List',
        metadata: { resourceVersion: String(revision) },
        items: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, object]) => copy(object)),
      }
    },
    async createNamespacedCustomObject({
      namespace,
      plural,
      body,
    }: Omit<Target, 'name'> & { body: HarnessObject }) {
      const name = body.metadata.name
      if (objects.has(keyOf(namespace, plural, name))) {
        throw kubernetesStatus(
          409,
          'AlreadyExists',
          `${plural}.${CLERUM_GROUP} "${name}" already exists`
        )
      }
      const { status: _ignored, ...admitted } = admit(plural, copy(body))
      const created = copy({
        ...admitted,
        metadata: {
          ...admitted.metadata,
          namespace,
          uid: deterministicId('a000', (uids += 1)),
          creationTimestamp: CREATION_TIMESTAMP,
          generation: 1,
          resourceVersion: nextVersion(),
        },
      })
      objects.set(keyOf(namespace, plural, name), created)
      return copy(created)
    },
    async replaceNamespacedCustomObject({
      namespace,
      plural,
      name,
      body,
    }: Target & { body: HarnessObject }) {
      replaceBodies.push({ plural, namespace, name, body: copy(body) })
      const current = requireCurrent(namespace, plural, name)
      const precondition = body.metadata?.resourceVersion
      if (!precondition) {
        throw kubernetesStatus(
          422,
          'Invalid',
          `${plural}.${CLERUM_GROUP} "${name}" is invalid: metadata.resourceVersion: Invalid value: 0x0: must be specified for an update`
        )
      }
      if (precondition !== current.metadata.resourceVersion) {
        throw conflict(
          plural,
          name,
          'the object has been modified; please apply your changes to the latest version and try again'
        )
      }
      if (body.metadata.uid !== undefined && body.metadata.uid !== current.metadata.uid) {
        throw conflict(
          plural,
          name,
          `Precondition failed: UID in precondition: ${body.metadata.uid}, UID in object meta: ${current.metadata.uid}`
        )
      }
      return update(namespace, plural, current, admit(plural, copy(body)))
    },
    async patchNamespacedCustomObject({
      namespace,
      plural,
      name,
      body,
    }: Target & { body: HarnessObject }) {
      patchBodies.push({ plural, namespace, name, body: copy(body) })
      const current = requireCurrent(namespace, plural, name)
      const precondition = body.metadata?.resourceVersion
      if (precondition !== undefined && precondition !== current.metadata.resourceVersion) {
        throw conflict(
          plural,
          name,
          'the object has been modified; please apply your changes to the latest version and try again'
        )
      }
      const patched = mergePatch(copy(current), copy(body)) as HarnessObject
      return update(namespace, plural, current, admit(plural, patched))
    },
  }

  const store: HarnessStore = {
    seed(plural, object) {
      const stored = copy(object)
      const namespace = stored.metadata.namespace ?? RESOURCE_NAMESPACES[plural] ?? config.namespace
      stored.metadata.namespace = namespace
      stored.metadata.uid ??= deterministicId('a000', (uids += 1))
      stored.metadata.creationTimestamp ??= CREATION_TIMESTAMP
      stored.metadata.generation ??= 1
      const seeded = Number(stored.metadata.resourceVersion)
      if (!stored.metadata.resourceVersion) stored.metadata.resourceVersion = nextVersion()
      else if (Number.isSafeInteger(seeded)) revision = Math.max(revision, seeded)
      objects.set(keyOf(namespace, plural, stored.metadata.name), stored)
      return copy(stored)
    },
    get(plural, name, namespace = RESOURCE_NAMESPACES[plural] ?? config.namespace) {
      const stored = objects.get(keyOf(namespace, plural, name))
      return stored && copy(stored)
    },
  }

  return { customApi, store, replaceBodies, patchBodies }
}

function createAdministrativeOperations(calls: AdministrativeOperationCall[]) {
  let operations = 0
  return {
    async persistHostIntent(input: PersistHostIntentInput): Promise<HostAdministrativeIntent> {
      const intent: HostAdministrativeIntent = {
        operationId: deterministicId('8000', (operations += 1)),
        action: input.action,
        namespace: input.namespace,
        targetRef: `${input.namespace}/${input.name}`,
        operatorSub: input.operatorSub,
        requestId: input.requestId,
      }
      calls.push({ method: 'persistHostIntent', input: { ...input }, intent })
      return intent
    },
    async persistHostOutcome(
      intent: HostAdministrativeIntent,
      outcome: HostAdministrativeOutcome,
      reasonCode: string
    ): Promise<void> {
      calls.push({ method: 'persistHostOutcome', intent, outcome, reasonCode })
    },
  }
}

/** Postgres for the Host routes: see the module comment. */
function installDatabase(allowedModels: readonly HarnessAllowedModel[]): MockInstance[] {
  const row = (values: readonly unknown[]) =>
    allowedModels.find(entry => entry.provider === values[0] && entry.model === values[1])
  const answer = async (text: string, values: readonly unknown[] = []): Promise<QueryResult> => {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return EMPTY_RESULT
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return EMPTY_RESULT
    if (sql.startsWith("SELECT set_config('idle_in_transaction_session_timeout'")) {
      return EMPTY_RESULT
    }
    if (sql === IS_MODEL_ALLOWED_SQL) {
      return row(values)?.enabled ? { rows: [{ '?column?': 1 }], rowCount: 1 } : EMPTY_RESULT
    }
    if (sql === MODEL_ALLOWLIST_STATE_SQL) {
      const found = row(values)
      return found
        ? { rows: [{ enabled: found.enabled, stale: found.stale }], rowCount: 1 }
        : EMPTY_RESULT
    }
    if (DIRECTORY_READ.test(sql)) return EMPTY_RESULT
    throw new Error(`hostRouteHarness: no answer for SQL: ${sql}`)
  }
  return [
    vi.spyOn(pool, 'connect').mockImplementation((async () =>
      Object.assign(new EventEmitter(), {
        query: answer,
        release: () => {},
      })) as never),
    vi.spyOn(pool, 'query').mockImplementation(answer as never),
  ]
}

export function buildHostRouteHarness(options: HostRouteHarnessOptions = {}): HostRouteHarness {
  const apiserver = createApiserver(options.crd ?? 'current')
  const adminOperations: AdministrativeOperationCall[] = []
  setAdministrativeOperationService(
    createAdministrativeOperations(
      adminOperations
    ) as unknown as ControlApiAdministrativeOperationService
  )
  const spies = installDatabase(options.allowedModels ?? [])

  const service = new ResourceService(
    apiserver.customApi as never,
    config.namespace,
    RESOURCE_NAMESPACES
  )
  const gateway = {
    getResource: service.getResource.bind(service),
    listResource: service.listResource.bind(service),
    createResource: service.createResource.bind(service),
    updateResource: service.updateResource.bind(service),
    listSecrets: async () => [],
    getSecret: async (name: string) => {
      throw kubernetesStatus(404, 'NotFound', `secrets "${name}" not found`)
    },
  }

  const operatorSub = options.operatorSub ?? DEFAULT_OPERATOR_SUB
  const api = express.Router()
  api.use('/admin', (req: Request, _res: Response, next: NextFunction) => {
    runWithAdministrativeRequestContext({ operatorSub, requestId: req.correlationId ?? null }, next)
  })
  api.use(createAdminHostsOverviewRouter(gateway as never))
  api.use(createAdminResourcesRouter(gateway as never))
  api.use('/admin', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' })
  })

  const app = express()
  app.use(express.json({ limit: config.jsonBodyLimit, inflate: false }))
  app.use(correlationIdMiddleware)
  app.use('/api/v1', api)
  app.use(clerumErrorHandler)

  return {
    app,
    store: apiserver.store,
    replaceBodies: apiserver.replaceBodies,
    patchBodies: apiserver.patchBodies,
    adminOperations,
    dispose() {
      for (const spy of spies) spy.mockRestore()
      setAdministrativeOperationService(null)
    },
  }
}
