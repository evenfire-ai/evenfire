/**
 * Contract: the fake control-api that Control UI tests run against
 * (control-ui/test/fixtures/fakeControlApi.ts) answers as control-api's real
 * Host routes do.
 *
 * One script of requests is replayed into the real routes, through
 * ./helpers/hostRouteHarness.ts (the real ResourceService over an in-memory
 * apiserver), and into the fake with `versionRule: true`, the routes as they
 * are since a version-less PUT that changes `spec.approval` is refused (spec
 * 2026-11-24-control-ui-approval-settings §6.8). At every step, status, body and the stored Host must be equal once
 * the server values are normalized away: `resourceVersion`, `uid`, `generation`,
 * `creationTimestamp`, `managedFields` and both administrative-intent
 * annotations. Versions are opaque and differ between the sides, so their
 * behaviour is compared instead: whether the step moved the stored version, and
 * whether the answer carries the stored version.
 *
 * Both sides start from one object: it is seeded in the in-memory apiserver,
 * read through the real GET, and that answer seeds the fake.
 *
 * The script runs once per Host CRD version. On the current CRD it also records
 * the bodies Control UI tests consume, in test/fixtures/wire/: with
 * UPDATE_WIRE_GOLDENS=1 it writes them; otherwise it asserts they are unchanged.
 * One of them is not a script step: the 500 a `/detail` read answers when the
 * Host read fails unexpectedly, recorded with NODE_ENV=production.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import request from 'supertest'
import {
  type FakeControlApi,
  type HostObject,
  createFakeControlApi,
} from '../../control-ui/test/fixtures/fakeControlApi'
import {
  ADMINISTRATIVE_INTENT_ANNOTATION,
  ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION,
} from '../src/services/tracing/adminOperationConstants.js'
import {
  type AdministrativeOperationCall,
  type HarnessAllowedModel,
  type HarnessObject,
  type HarnessWrite,
  type HostRouteHarness,
  buildHostRouteHarness,
} from './helpers/hostRouteHarness.js'

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const WIRE_DIR = new URL('./fixtures/wire/', import.meta.url)

// Sent on every real request, so every real answer is deterministic.
const CORRELATION_ID = '00000000-0000-4000-9000-000000000001'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const PROVIDER = 'claude'
const MODEL = 'claude-sonnet-4-6'
const STALE_MODEL = 'claude-sonnet-4-5'
const ALLOWED_MODELS: HarnessAllowedModel[] = [
  { provider: PROVIDER, model: MODEL, enabled: true, stale: false },
  { provider: PROVIDER, model: STALE_MODEL, enabled: true, stale: true },
]

const HOST_PATH = '/api/v1/admin/hosts/foo'
const MISSING_HOST_PATH = '/api/v1/admin/hosts/nobody'

const SEED: HarnessObject = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'Host',
  metadata: { name: 'foo' },
  spec: {
    host: 'foo',
    contextRef: 'ctx-a',
    secretRef: 'foo-llm',
    channels: [],
    model: { provider: PROVIDER, name: MODEL },
    approval: { defaultPolicy: 'cli_only', channels: {} },
  },
  status: { lifecycle: { state: 'active', effectiveMode: 'stateful', observedGeneration: 1 } },
}

type Answer = { status: number; body: unknown }
type Answers = Record<string, Answer>
type Step = {
  label: string
  method: 'GET' | 'PUT'
  path: string
  body?: (answers: Answers) => unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hostAnswer(answers: Answers, label: string): HostObject {
  const body = answers[label]?.body
  if (!isRecord(body) || !isRecord(body.metadata)) {
    throw new Error(`script step "${label}" did not answer a Host`)
  }
  return body as HostObject
}

const specOf = (answers: Answers, label: string) => hostAnswer(answers, label).spec
const versionOf = (answers: Answers, label: string) =>
  hostAnswer(answers, label).metadata.resourceVersion

// Labels other steps or assertions refer to.
const READ = 'read'
const DETAIL = 'detail'
const NO_APPROVAL_CHANGE = 'version-less PUT without an approval change'
const APPROVAL_CHANGE = 'version-less PUT with an approval change'
const VERSIONED_APPROVAL_CHANGE = 'versioned PUT with an approval change'
const CURRENT_CRD_ONLY_CHANGE = 'versioned PUT of a field only the current CRD keeps'
const REORDERED_APPROVAL = 'version-less PUT with the stored approval, its keys reordered'
const RE_READ = 're-read'
const VERSIONED = 'versioned PUT'
const STALE_VERSION = 'versioned PUT with a stale version'
const STRUCTURAL_422 = 'structural 422'
const STALE_MODEL_ASSIGNED = 'version-less PUT assigning a stale model'
const UNCHANGED_FIRST = 'version-less PUT with an unchanged spec, first'
const UNCHANGED_SECOND = 'version-less PUT with an unchanged spec, second'
const UNCHANGED_ANSWER_VERSION = 'versioned PUT carrying the unchanged-spec answer version'

const SCRIPT: Step[] = [
  { label: READ, method: 'GET', path: HOST_PATH },
  { label: DETAIL, method: 'GET', path: `${HOST_PATH}/detail` },
  {
    label: NO_APPROVAL_CHANGE,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({ spec: { ...specOf(a, READ), contextRef: 'ctx-b' } }),
  },
  {
    label: APPROVAL_CHANGE,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({
      spec: {
        ...specOf(a, NO_APPROVAL_CHANGE),
        approval: {
          defaultPolicy: 'cli_only',
          modeCeiling: 'manual',
          channels: { telegram: { enabled: true } },
          tools: { shell_exec: false },
        },
      },
    }),
  },
  {
    // Versioned: a version-less write could not change spec.approval.
    label: VERSIONED_APPROVAL_CHANGE,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({
      metadata: { resourceVersion: versionOf(a, NO_APPROVAL_CHANGE) },
      spec: {
        ...specOf(a, NO_APPROVAL_CHANGE),
        approval: {
          defaultPolicy: 'cli_only',
          modeCeiling: 'manual',
          channels: { telegram: { enabled: true } },
          tools: { shell_exec: false },
        },
      },
    }),
  },
  {
    // v0.12.1 prunes modeCeiling, so there this write leaves the spec unchanged.
    label: CURRENT_CRD_ONLY_CHANGE,
    method: 'PUT',
    path: HOST_PATH,
    body: a => {
      const spec = specOf(a, VERSIONED_APPROVAL_CHANGE)
      return {
        metadata: { resourceVersion: versionOf(a, VERSIONED_APPROVAL_CHANGE) },
        spec: {
          ...spec,
          approval: { ...(spec.approval as Record<string, unknown>), modeCeiling: 'allow_all' },
        },
      }
    },
  },
  { label: RE_READ, method: 'GET', path: HOST_PATH },
  {
    label: VERSIONED,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({
      metadata: { resourceVersion: versionOf(a, RE_READ) },
      spec: { ...specOf(a, RE_READ), contextRef: 'ctx-c' },
    }),
  },
  {
    label: STALE_VERSION,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({
      metadata: { resourceVersion: versionOf(a, READ) },
      spec: { ...specOf(a, VERSIONED), contextRef: 'ctx-d' },
    }),
  },
  {
    // hostSpecValidation.ts: needs no database, and runs before any version check.
    label: STRUCTURAL_422,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({
      metadata: { resourceVersion: versionOf(a, READ) },
      spec: { ...specOf(a, VERSIONED), model: { name: MODEL } },
    }),
  },
  {
    // An enabled model the allowlist marks stale, new to the stored spec.
    label: STALE_MODEL_ASSIGNED,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({
      spec: { ...specOf(a, VERSIONED), model: { provider: PROVIDER, name: STALE_MODEL } },
    }),
  },
  {
    label: UNCHANGED_FIRST,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({ spec: specOf(a, STALE_MODEL_ASSIGNED) }),
  },
  {
    label: UNCHANGED_SECOND,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({ spec: specOf(a, STALE_MODEL_ASSIGNED) }),
  },
  {
    label: UNCHANGED_ANSWER_VERSION,
    method: 'PUT',
    path: HOST_PATH,
    body: a => ({
      metadata: { resourceVersion: versionOf(a, UNCHANGED_SECOND) },
      spec: specOf(a, STALE_MODEL_ASSIGNED),
    }),
  },
  {
    // Pins the key-order-insensitive compare the routes and the fake share.
    label: REORDERED_APPROVAL,
    method: 'PUT',
    path: HOST_PATH,
    body: a => {
      const spec = specOf(a, STALE_MODEL_ASSIGNED)
      const approval = spec.approval as Record<string, unknown>
      return {
        spec: {
          ...spec,
          contextRef: 'ctx-b2',
          approval: Object.fromEntries(Object.entries(approval).reverse()),
        },
      }
    },
  },
  { label: 'GET of a missing Host', method: 'GET', path: MISSING_HOST_PATH },
  {
    label: 'PUT of a missing Host',
    method: 'PUT',
    path: MISSING_HOST_PATH,
    body: a => ({ spec: specOf(a, READ) }),
  },
]

/** What the routes did at the apiserver and the administrative-operation service during one step. */
type StepEffects = {
  replaces: HarnessWrite[]
  patches: HarnessWrite[]
  operations: AdministrativeOperationCall[]
}

type Observation = Answer & {
  label: string
  method: Step['method']
  stored: HostObject
  storedMoved: boolean
  /** Whether the answer's Host carries the stored version; null when it has no Host. */
  answerIsStored: boolean | null
}

type Side = {
  send(step: Step, body: unknown): Promise<Answer>
  stored(): HostObject
}

function answerVersion(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const host = isRecord(body.host) ? body.host : body
  return isRecord(host.metadata) ? (host.metadata.resourceVersion as string) : undefined
}

async function runScript(side: Side): Promise<Observation[]> {
  const answers: Answers = {}
  const observations: Observation[] = []
  for (const step of SCRIPT) {
    const before = side.stored().metadata.resourceVersion
    const answer = await side.send(step, step.body?.(answers))
    answers[step.label] = answer
    const stored = side.stored()
    const version = answerVersion(answer.body)
    observations.push({
      ...answer,
      label: step.label,
      method: step.method,
      stored,
      storedMoved: stored.metadata.resourceVersion !== before,
      answerIsStored: version === undefined ? null : version === stored.metadata.resourceVersion,
    })
  }
  return observations
}

function realSide(harness: HostRouteHarness, effects: Map<string, StepEffects>): Side {
  return {
    async send(step, body) {
      const replaces = harness.replaceBodies.length
      const patches = harness.patchBodies.length
      const operations = harness.adminOperations.length
      const call =
        step.method === 'GET'
          ? request(harness.app).get(step.path)
          : request(harness.app)
              .put(step.path)
              .send(body as object)
      const res = await call.set('x-correlation-id', CORRELATION_ID)
      effects.set(step.label, {
        replaces: harness.replaceBodies.slice(replaces),
        patches: harness.patchBodies.slice(patches),
        operations: harness.adminOperations.slice(operations),
      })
      return { status: res.status, body: res.body as unknown }
    },
    stored() {
      const stored = harness.store.get('hosts', 'foo')
      if (!stored) throw new Error('the in-memory apiserver lost Host foo')
      return stored as HostObject
    },
  }
}

function fakeSide(fake: FakeControlApi): Side {
  return {
    async send(step, body) {
      const response = await fake.fetch(
        `/control-api${step.path}`,
        step.method === 'GET'
          ? {}
          : {
              method: step.method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
      )
      return { status: response.status, body: (await response.json()) as unknown }
    },
    stored: () => fake.stored('foo'),
  }
}

const SERVER_METADATA = [
  'resourceVersion',
  'uid',
  'generation',
  'creationTimestamp',
  'managedFields',
] as const

/** A Host without the values the server picks. */
function normalizeHost(host: unknown): unknown {
  if (!isRecord(host) || !isRecord(host.metadata)) return host
  const normalized = structuredClone(host) as { metadata: Record<string, unknown> }
  for (const key of SERVER_METADATA) delete normalized.metadata[key]
  const annotations = normalized.metadata.annotations
  if (isRecord(annotations)) {
    delete annotations[ADMINISTRATIVE_INTENT_ANNOTATION]
    delete annotations[ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION]
    if (Object.keys(annotations).length === 0) delete normalized.metadata.annotations
  }
  return normalized
}

function normalizeBody(body: unknown): unknown {
  if (!isRecord(body)) return body
  if (isRecord(body.metadata)) return normalizeHost(body)
  if (isRecord(body.host)) return { ...body, host: normalizeHost(body.host) }
  if (typeof body.correlationId === 'string' && UUID.test(body.correlationId)) {
    return { ...body, correlationId: '<a UUID>' }
  }
  return body
}

function comparable(observation: Observation) {
  return {
    status: observation.status,
    body: normalizeBody(observation.body),
    stored: normalizeHost(observation.stored),
    storedMoved: observation.storedMoved,
    answerIsStored: observation.answerIsStored,
  }
}

/** Writes or checks a wire file; `mask` is applied to both sides before they are compared. */
function pinWire(
  file: string,
  value: unknown,
  mask: (wire: unknown) => unknown = wire => wire
): void {
  const url = new URL(file, WIRE_DIR)
  const actual = JSON.parse(JSON.stringify(value)) as unknown
  if (UPDATE) writeFileSync(url, `${JSON.stringify(actual, null, 2)}\n`)
  expect(mask(actual), file).toEqual(mask(JSON.parse(readFileSync(url, 'utf8'))))
}

/** A wire answer with the value of its body's `correlationId` masked: it changes per request. */
function maskCorrelationId(wire: unknown): unknown {
  if (!isRecord(wire) || !isRecord(wire.body) || typeof wire.body.correlationId !== 'string') {
    return wire
  }
  return { ...wire, body: { ...wire.body, correlationId: '<per request>' } }
}

const DETAIL_500_SOURCE =
  "control-api/test/routes.hostPut.fakeContract.test.ts: GET /api/v1/admin/hosts/foo/detail whose Host read throws a plain Error, answered by clerumErrorHandler's production branch (NODE_ENV=production), as deployed control-api answers"

// Accepted PUTs whose stored spec changes (a new generation) or stays the same,
// per Host CRD: v0.12.1 prunes the only change CURRENT_CRD_ONLY_CHANGE makes.
const SPEC_CHANGING_PUTS = {
  current: [
    NO_APPROVAL_CHANGE,
    VERSIONED_APPROVAL_CHANGE,
    CURRENT_CRD_ONLY_CHANGE,
    VERSIONED,
    STALE_MODEL_ASSIGNED,
    REORDERED_APPROVAL,
  ],
  'v0.12.1': [
    NO_APPROVAL_CHANGE,
    VERSIONED_APPROVAL_CHANGE,
    VERSIONED,
    STALE_MODEL_ASSIGNED,
    REORDERED_APPROVAL,
  ],
}
const SPEC_UNCHANGED_PUTS = {
  current: [UNCHANGED_FIRST, UNCHANGED_SECOND],
  'v0.12.1': [CURRENT_CRD_ONLY_CHANGE, UNCHANGED_FIRST, UNCHANGED_SECOND],
}

describe.each(['current', 'v0.12.1'] as const)(
  'fake control-api against the real Host routes (%s Host CRD)',
  crd => {
    let harness: HostRouteHarness
    const effects = new Map<string, StepEffects>()
    let real: Observation[] = []
    let faked: Observation[] = []
    const observed = (label: string): Observation => {
      const observation = real.find(candidate => candidate.label === label)
      if (!observation) throw new Error(`no real observation for "${label}"`)
      return observation
    }
    const intentOf = (label: string): string => {
      const intents = effects
        .get(label)
        ?.operations.filter(call => call.method === 'persistHostIntent')
      if (intents?.length !== 1) throw new Error(`"${label}" persisted ${intents?.length} intents`)
      return intents[0].intent.operationId
    }

    beforeAll(async () => {
      harness = buildHostRouteHarness({ crd, allowedModels: ALLOWED_MODELS })
      harness.store.seed('hosts', SEED)
      const seedRead = await request(harness.app)
        .get(HOST_PATH)
        .set('x-correlation-id', CORRELATION_ID)
      expect(seedRead.status).toBe(200)
      const fake = createFakeControlApi({
        hosts: { foo: seedRead.body as HostObject },
        crd,
        versionRule: true,
        staleModels: ALLOWED_MODELS.filter(row => row.enabled && row.stale).map(
          ({ provider, model }) => ({ provider, model })
        ),
      })
      real = await runScript(realSide(harness, effects))
      faked = await runScript(fakeSide(fake))
    })

    afterAll(() => harness?.dispose())

    it('answers and stores as the real routes at every step of the script', () => {
      expect(faked.map(observation => observation.label)).toEqual(SCRIPT.map(step => step.label))
      for (const [index, observation] of real.entries()) {
        expect.soft(comparable(faked[index]), observation.label).toEqual(comparable(observation))
      }
    })

    it('real routes: a PUT that leaves the spec unchanged answers a version its post-write patch has already moved past', () => {
      for (const label of SPEC_CHANGING_PUTS[crd]) {
        const observation = observed(label)
        expect(observation.status, label).toBe(200)
        expect(effects.get(label)?.patches, label).toEqual([])
        expect(observation.answerIsStored, label).toBe(true)
      }
      for (const label of SPEC_UNCHANGED_PUTS[crd]) {
        const observation = observed(label)
        const answer = observation.body as HostObject
        expect(observation.status, label).toBe(200)
        // reconcileAdministrativeIntentGeneration lowers the predicted generation
        // annotation to the one the replace persisted, on the replace's version.
        expect(
          effects.get(label)?.patches.map(patch => patch.body),
          label
        ).toEqual([
          {
            metadata: {
              resourceVersion: answer.metadata.resourceVersion,
              annotations: {
                [ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION]: String(answer.metadata.generation),
              },
            },
          },
        ])
        expect(observation.storedMoved, label).toBe(true)
        expect(observation.answerIsStored, label).toBe(false)
      }
      expect(observed(APPROVAL_CHANGE)).toMatchObject({
        status: 409,
        body: { error: 'conflict', reason: 'approval_requires_version' },
      })
      expect(observed(APPROVAL_CHANGE).storedMoved).toBe(false)
      expect(observed(UNCHANGED_ANSWER_VERSION)).toMatchObject({
        status: 409,
        body: { error: 'conflict', reason: 'resource_changed' },
      })
    })

    it('real routes: every accepted PUT writes a fresh administrative intent into its replace body', () => {
      const accepted = real.filter(
        observation => observation.method === 'PUT' && observation.status === 200
      )
      expect(accepted.map(observation => observation.label).sort()).toEqual(
        [...SPEC_CHANGING_PUTS[crd], ...SPEC_UNCHANGED_PUTS[crd]].sort()
      )
      for (const { label } of accepted) {
        expect(
          effects
            .get(label)
            ?.replaces.map(
              write => write.body.metadata.annotations?.[ADMINISTRATIVE_INTENT_ANNOTATION]
            ),
          label
        ).toEqual([intentOf(label)])
      }
      expect(intentOf(UNCHANGED_FIRST)).not.toBe(intentOf(UNCHANGED_SECOND))
    })

    // Registered for the current CRD only, so no run reports a skipped test.
    if (crd !== 'current') return

    it('records the wire bodies Control UI tests consume', () => {
      const wire = (label: string): Answer => {
        const { status, body } = observed(label)
        return { status, body }
      }
      pinWire('host-put-409.wire.json', wire(STALE_VERSION))
      pinWire('host-put-422.wire.json', wire(STRUCTURAL_422))
      pinWire('host-put-warnings.wire.json', wire(STALE_MODEL_ASSIGNED))
      pinWire('host-detail.wire.json', wire(DETAIL))
      pinWire('host-unchanged-put-annotations.wire.json', {
        puts: [UNCHANGED_FIRST, UNCHANGED_SECOND].map(label => {
          const observation = observed(label)
          const answer = observation.body as HostObject
          return {
            replaceAnnotations: effects.get(label)?.replaces[0]?.body.metadata.annotations,
            answer: {
              resourceVersion: answer.metadata.resourceVersion,
              generation: answer.metadata.generation,
            },
            postWritePatch: effects.get(label)?.patches[0]?.body,
            stored: {
              resourceVersion: observation.stored.metadata.resourceVersion,
              generation: observation.stored.metadata.generation,
              annotations: observation.stored.metadata.annotations,
            },
          }
        }),
      })
    })

    it("records control-api's production 500 for a /detail read that fails unexpectedly", async () => {
      // clerumErrorHandler reads NODE_ENV per request: production omits `message`.
      vi.stubEnv('NODE_ENV', 'production')
      try {
        harness.failNextRead(new Error('Host read failed unexpectedly'))
        const res = await request(harness.app)
          .get(`${HOST_PATH}/detail`)
          .set('x-correlation-id', CORRELATION_ID)
        expect(res.status).toBe(500)
        expect(Object.keys(res.body as object).sort(), 'the production body').toEqual([
          'correlationId',
          'error',
        ])
        pinWire(
          'host-detail-500.wire.json',
          { _source: DETAIL_500_SOURCE, status: res.status, body: res.body as unknown },
          maskCorrelationId
        )
      } finally {
        vi.unstubAllEnvs()
      }
    })
  }
)
