/**
 * The per-tool approval save (spec §6.4 steps 2–14), named after the spec §7 A3
 * rows it settles.
 *
 * Only `fetch` is replaced, by the fake control-api with the version rule on
 * (control-api since spec §6.8), so the real `getHost`, `apiSend`, in-flight
 * GET map and `formatApiError` run (spec A6). The protocol's clock is a
 * virtual one: no test waits for a real timeout. An answer that stands for
 * another component's is that component's: control-api's 403, 422, 500 and
 * warnings bodies (control-api/test/fixtures/wire), the proxy's 502 and 504
 * (test/fixtures/wire), or the fake's own answer, which
 * control-api/test/routes.hostPut.fakeContract.test.ts pins to the real routes.
 *
 * Unless a test says otherwise the admin moves system_info, whose default is
 * Skip, to Required: that never loosens (spec §6.6), so no dialog was confirmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type VirtualClock,
  createVirtualClock,
  seededRandom,
} from '../../test/fixtures/approvalClock'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import {
  type FakeControlApi,
  type FakeLogEntry,
  type HostObject,
  createFakeControlApi,
} from '../../test/fixtures/fakeControlApi'
import {
  AuthExpiredError,
  REQUEST_TIMED_OUT_MESSAGE,
  formatApiError,
  getHost,
  setGlobalAuthErrorHandler,
} from '../api'
import { type LooseningItem, looseningItems } from '../approvalLoosening'
import {
  APPROVAL_CREATED_ELSEWHERE_MESSAGE,
  TOOLS_CHANGED_MESSAGE,
  type ToolsSaveInput,
  type ToolsSaveOutcome,
  __resetHostApprovalSaveForTests,
  __setApprovalClockForTests,
  getApprovalClock,
  notStoredMessage,
  realApprovalClock,
  saveTools,
} from '../hostApprovalSave'
import { __resetReadRequestCacheForTests } from '../readRequestCache'

const FOO = '/api/v1/admin/hosts/foo'

type WireAnswer = { status: number; body: unknown }

function readWire(path: string): WireAnswer {
  return JSON.parse(readFileSync(resolve(__dirname, path), 'utf8')) as WireAnswer
}

// The proxy's own answers (app/control-api/[...path]/route.ts), recorded by its route.wireBodies test.
const PROXY_502 = readWire('../../test/fixtures/wire/proxy-502.wire.json')
const PROXY_504 = readWire('../../test/fixtures/wire/proxy-504.wire.json')
// control-api's answers, recorded by control-api/test/routes.hostPut.fakeContract.test.ts.
const CONTROL_API_WIRE = '../../../control-api/test/fixtures/wire'
const HOST_PUT_403 = readWire(`${CONTROL_API_WIRE}/host-put-403.wire.json`)
const HOST_PUT_422 = readWire(`${CONTROL_API_WIRE}/host-put-422.wire.json`)
const HOST_PUT_WARNINGS = readWire(`${CONTROL_API_WIRE}/host-put-warnings.wire.json`)
// clerumErrorHandler's production 500, which it answers for any unexpected
// error; recorded on a /detail read.
const CONTROL_API_500 = readWire(`${CONTROL_API_WIRE}/host-detail-500.wire.json`)

// Spec §6.4 steps 8 and 13, verbatim.
const GAVE_UP = 'The agent kept changing while saving. Try again.'
const MAYBE = 'The save may not have applied. Reload to check.'

const BASE_TOOLS = { json_transform: true }
const DRAFT_TOOLS = { json_transform: true, system_info: true }

function seedHost(name: string, spec: Record<string, unknown> = {}): HostObject {
  return materializeHostResource(
    {
      metadata: { name },
      spec: {
        host: name,
        contextRef: 'ctx-a',
        secretRef: `${name}-llm`,
        channels: [],
        model: { provider: 'claude', name: 'claude-sonnet-4-6' },
      },
    },
    { spec }
  )
}

/** The fake control-api as control-api runs since spec §6.8, in place of `fetch`. */
function createFake(
  approval: Record<string, unknown> | null | undefined,
  options: { crd?: 'current' | 'v0.12.1'; spec?: Record<string, unknown> } = {}
): FakeControlApi {
  const spec = { ...options.spec, ...(approval === undefined ? {} : { approval }) }
  const fake = createFakeControlApi({
    hosts: { foo: seedHost('foo', spec) },
    crd: options.crd ?? 'current',
    versionRule: true,
  })
  vi.stubGlobal('fetch', fake.fetch)
  return fake
}

/** A save on a Host with its own block, base `{ json_transform: true }`. */
function toolsSave(overrides: Partial<ToolsSaveInput> = {}): ToolsSaveInput {
  return {
    host: 'foo',
    base: { ...BASE_TOOLS },
    baseInherited: false,
    draftTools: { ...DRAFT_TOOLS },
    confirmedItems: [],
    ...overrides,
  }
}

/** The first save on an inheriting Host, with "Nobody (Desktop only)" chosen. */
function firstSave(overrides: Partial<ToolsSaveInput> = {}): ToolsSaveInput {
  return {
    host: 'foo',
    base: undefined,
    baseInherited: true,
    draftTools: { system_info: true },
    firstSavePolicy: 'cli_only',
    confirmedItems: [],
    ...overrides,
  }
}

function writes(fake: FakeControlApi): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'write' && entry.path === FOO)
}

function reads(fake: FakeControlApi): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'read' && entry.path === FOO)
}

function storedApproval(fake: FakeControlApi): unknown {
  return fake.stored('foo').spec.approval
}

/** The `spec.approval` a logged PUT sent. */
function sentApproval(entry: FakeLogEntry): unknown {
  return (entry.body as { spec: Record<string, unknown> }).spec.approval
}

/** The version of the Host a logged read answered. */
function versionRead(entry: FakeLogEntry): string | undefined {
  return (entry.response?.body as HostObject).metadata.resourceVersion
}

function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: boolean } {
  const state = { promise, settled: false }
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  )
  return state
}

/** Lets every request the last step started reach its next hold. */
async function flush(): Promise<void> {
  await new Promise(done => setTimeout(done, 0))
}

let clock: VirtualClock

beforeEach(() => {
  __resetReadRequestCacheForTests()
  clock = createVirtualClock()
  __setApprovalClockForTests(clock, seededRandom(16))
})

afterEach(() => {
  __resetHostApprovalSaveForTests()
  __resetReadRequestCacheForTests()
  setGlobalAuthErrorHandler(() => {})
  vi.unstubAllGlobals()
})

describe('per-tool save protocol (spec §6.4)', () => {
  describe('retries', () => {
    it('T1 a spec change between the read and the PUT makes the PUT 409, and the retry keeps that change', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      fake.writeExternal('foo', spec => {
        spec.contextRef = 'c2'
      })
      put.deliverNow()
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(writes(fake).map(entry => entry.response?.status)).toEqual([409, 200])
      // Every PUT carries the version of its own fresh read.
      expect(writes(fake).map(entry => entry.versionSent)).toEqual(reads(fake).map(versionRead))
      expect(fake.stored('foo').spec.contextRef, "the other writer's contextRef").toBe('c2')
      expect(storedApproval(fake)).toEqual({ tools: DRAFT_TOOLS })
    })

    it('T3 a 409 from a status bump retries once and saves', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      fake.bumpVersion('foo', 'status')
      put.deliverNow()
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(writes(fake).map(entry => entry.response?.status)).toEqual([409, 200])
      expect(reads(fake)).toHaveLength(2)
      expect(writes(fake).map(entry => entry.versionSent)).toEqual(reads(fake).map(versionRead))
      expect(storedApproval(fake)).toEqual({ tools: DRAFT_TOOLS })
    })

    it("the save's read of the Host does not join another read of it in flight (R22)", async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const otherHold = fake.hold({ method: 'GET', path: FOO })
      // Another reader of the Host, with no signal: a read without one would join it.
      const other = getHost('foo')
      await otherHold.arrived
      const outcome = await saveTools(toolsSave())

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(
        reads(fake).filter(entry => entry.arrived),
        'GET /hosts/foo arrivals'
      ).toHaveLength(2)
      otherHold.deliverNow()
      await other
    })

    it('three 409s give up with the exact message', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const puts = [1, 2, 3].map(nth => fake.hold({ method: 'PUT', path: FOO, nth }))
      const saving = saveTools(toolsSave())
      for (const put of puts) {
        await put.arrived
        fake.bumpVersion('foo', 'status')
        put.deliverNow()
      }
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'gave_up', message: GAVE_UP })
      expect(writes(fake).map(entry => entry.response?.status)).toEqual([409, 409, 409])
      expect(writes(fake).map(entry => entry.versionSent)).toEqual(reads(fake).map(versionRead))
      expect(reads(fake), 'one read per attempt, none after the last').toHaveLength(3)
      expect(storedApproval(fake)).toEqual({ tools: BASE_TOOLS })
    })
  })

  describe('base check', () => {
    it("T2 an external change to tools since the base stops the save with no PUT and keeps the other writer's tools", async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).tools = {
          json_transform: true,
          shell_exec: false,
        }
      })
      const input = toolsSave()
      const outcome = await saveTools(input)

      expect(outcome).toEqual({ kind: 'conflict' })
      expect(reads(fake), "the save's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
      expect(storedApproval(fake)).toEqual({ tools: { json_transform: true, shell_exec: false } })
      expect(input.draftTools, 'the draft').toEqual(DRAFT_TOOLS)
    })

    it('tools are three-valued: an explicit value another writer reset to the default stops the save', async () => {
      // json_transform's default is Skip, so explicit false and absent run the
      // same, yet they are different stored values (spec decision 13).
      const fake = createFake({ tools: { json_transform: false } })
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).tools = {}
      })
      const outcome = await saveTools(
        toolsSave({
          base: { json_transform: false },
          draftTools: { json_transform: false, system_info: true },
        })
      )

      expect(outcome).toEqual({ kind: 'conflict' })
      expect(reads(fake), "the save's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
      expect(storedApproval(fake)).toEqual({ tools: {} })
    })

    it('already-equal tools count as success', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      // An earlier attempt of this save landed.
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).tools = { ...DRAFT_TOOLS }
      })
      const outcome = await saveTools(toolsSave())

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'reread' })
      expect(reads(fake), "the save's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
    })
  })

  describe('first save', () => {
    it('T10 a first save stops when another writer created the approval block, with no PUT', async () => {
      const fake = createFake(undefined)
      fake.writeExternal('foo', spec => {
        spec.approval = { defaultPolicy: 'cli_only', channels: {} }
      })
      const created = storedApproval(fake)
      const outcome = await saveTools(firstSave())

      expect(outcome).toEqual({ kind: 'created_elsewhere' })
      expect(reads(fake), "the save's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
      expect(storedApproval(fake), 'the block the other writer created').toEqual(created)
    })

    it('T10r a save stops when the approval block it opened with was removed, and does not recreate it', async () => {
      // An empty block: present, so not inheriting, with every value the default.
      const fake = createFake({})
      fake.writeExternal('foo', spec => {
        delete spec.approval
      })
      const outcome = await saveTools(
        toolsSave({ base: undefined, draftTools: { system_info: true } })
      )

      expect(outcome).toEqual({ kind: 'created_elsewhere' })
      expect(reads(fake), "the save's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
      expect(fake.stored('foo').spec).not.toHaveProperty('approval')
    })

    it('a null approval block reads as inheriting, as mcp-host reads it', async () => {
      const fake = createFake(null)
      const outcome = await saveTools(firstSave())

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(storedApproval(fake)).toEqual({
        defaultPolicy: 'cli_only',
        tools: { system_info: true },
      })
    })

    it('T10p the first save carries the chosen defaultPolicy', async () => {
      const fake = createFake(undefined)
      const outcome = await saveTools(firstSave())

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(writes(fake)).toHaveLength(1)
      expect(sentApproval(writes(fake)[0])).toEqual({
        defaultPolicy: 'cli_only',
        tools: { system_info: true },
      })
      expect(writes(fake)[0].versionSent).toBe(versionRead(reads(fake)[0]))
      expect(storedApproval(fake)).toEqual({
        defaultPolicy: 'cli_only',
        tools: { system_info: true },
      })
    })

    it('a first save lists its loosening against the code defaults, the open policy included', async () => {
      const fake = createFake(undefined)
      // shell_exec asks by default; "Any channel user" is the open policy.
      const input = firstSave({
        draftTools: { shell_exec: false },
        firstSavePolicy: 'channel_users',
      })
      const asked = await saveTools(input)

      expect(asked).toEqual({
        kind: 'reconfirm',
        items: [
          { path: 'defaultPolicy', rule: 'policy_open_on_first_save' },
          { path: 'tools.shell_exec', rule: 'tool_to_skip' },
        ],
      })
      expect(writes(fake), 'PUTs before confirming').toEqual([])
      const confirmed = asked.kind === 'reconfirm' ? asked.items : []
      const saved = await saveTools({ ...input, confirmedItems: confirmed })
      expect(saved).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(storedApproval(fake)).toEqual({
        defaultPolicy: 'channel_users',
        tools: { shell_exec: false },
      })
    })

    it('a first-save policy is taken only with a first save', async () => {
      const fake = createFake(undefined)

      await expect(saveTools(firstSave({ firstSavePolicy: undefined }))).rejects.toThrow(
        /needs the chosen firstSavePolicy/
      )
      await expect(saveTools(toolsSave({ firstSavePolicy: 'cli_only' }))).rejects.toThrow(
        /firstSavePolicy is written only by the first save/
      )
      expect(fake.log, 'requests').toEqual([])
    })
  })

  describe('prune check', () => {
    it('T5 v0.12.1: a pruned field is reported with what is live', async () => {
      // The block holds fields the v0.12.1 CRD lacks, as written under a newer
      // CRD; the fake serves seeds as given and prunes on write only. The
      // apiserver prunes on read too (Task 25c checked it on a cluster), so
      // under a v0.12.1 CRD the save's read never shows these fields: the
      // scenario needs the CRD to change between that read and the write.
      // telegram's allowModeChange is pruned too, but its default is the value
      // sent.
      const fake = createFake(
        {
          modeCeiling: 'auto',
          channels: { telegram: { enabled: true, allowModeChange: true } },
          tools: { ...BASE_TOOLS },
        },
        { crd: 'v0.12.1' }
      )
      const outcome = await saveTools(toolsSave())

      expect(outcome).toEqual({
        kind: 'not_stored',
        fields: ['modeCeiling'],
        live: { modeCeiling: 'manual' },
      })
      // The PUT was applied: the tools are stored, and the pruned fields are gone.
      expect(writes(fake).map(entry => entry.applied)).toEqual([true])
      expect(storedApproval(fake)).toEqual({
        channels: { telegram: { enabled: true } },
        tools: DRAFT_TOOLS,
      })
    })

    it('T5d a defaulted value counts as stored', async () => {
      // The current CRD fills allowModeChange in on a present channel block.
      const fake = createFake({
        channels: { telegram: { enabled: true } },
        tools: { ...BASE_TOOLS },
      })
      const outcome = await saveTools(toolsSave())

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(sentApproval(writes(fake)[0]), 'what the PUT sent').toEqual({
        channels: { telegram: { enabled: true } },
        tools: DRAFT_TOOLS,
      })
      expect(storedApproval(fake), 'what the cluster stored').toEqual({
        channels: { telegram: { enabled: true, allowModeChange: true } },
        tools: DRAFT_TOOLS,
      })
    })

    it('reads a PUT answer that carries stale-model warnings as its Host', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      put.applyNow()
      await vi.waitFor(() => expect(writes(fake)[0].applied).toBe(true))
      // control-api answers `{ ...host, warnings }` when a write assigns a stale model.
      const { warnings } = HOST_PUT_WARNINGS.body as { warnings: unknown[] }
      put.respondWith(200, { ...(writes(fake)[0].response?.body as object), warnings })
      const outcome = await saving

      expect(warnings, 'recorded warnings').not.toHaveLength(0)
      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
    })
  })

  describe('re-read after a PUT with no answer', () => {
    it('T15 a PUT that was applied but got no answer is saved from the re-read', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      put.dropResponse()
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'reread' })
      expect(writes(fake).map(entry => [entry.applied, entry.delivered])).toEqual([[true, false]])
      expect(reads(fake), 'the fresh read and the re-read').toHaveLength(2)
      expect(reads(fake)[1].seq).toBeGreaterThan(writes(fake)[0].seq)
    })

    it("T15x a PUT that was applied but answered by the proxy's 504 is saved from the re-read", async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      put.applyNow()
      await vi.waitFor(() => expect(writes(fake)[0].applied).toBe(true))
      put.respondWith(PROXY_504.status, PROXY_504.body)
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'reread' })
      expect(writes(fake).map(entry => entry.response?.status)).toEqual([504])
      expect(reads(fake), 'the fresh read and the re-read').toHaveLength(2)
    })

    it.each([
      ["the proxy's 502", PROXY_502],
      ["control-api's 500", CONTROL_API_500],
    ])('a PUT answered by %s that was not applied may not have applied', async (_name, answer) => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      put.respondWith(answer.status, answer.body)
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'maybe', message: MAYBE })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [false, answer.status],
      ])
      expect(reads(fake), 'the fresh read and the re-read').toHaveLength(2)
      expect(storedApproval(fake)).toEqual({ tools: BASE_TOOLS })
    })

    it('a failed re-read after a PUT with no answer may not have applied', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const reread = fake.hold({ method: 'GET', path: FOO, nth: 2 })
      const saving = saveTools(toolsSave())
      await put.arrived
      put.dropResponse()
      await reread.arrived
      reread.respondWith(CONTROL_API_500.status, CONTROL_API_500.body)
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'maybe', message: MAYBE })
      // The write landed, but nothing this save read could confirm it.
      expect(writes(fake).map(entry => entry.applied)).toEqual([true])
      expect(reads(fake).map(entry => entry.response?.status)).toEqual([200, 500])
    })

    it('T15p a first save whose re-read shows another policy is not success', async () => {
      const fake = createFake(undefined)
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(firstSave())
      await put.arrived
      // Another writer creates the block with the same tools and the open policy.
      fake.writeExternal('foo', spec => {
        spec.approval = { defaultPolicy: 'channel_users', tools: { system_info: true } }
      })
      // control-api refuses the PUT (its read is stale), and the answer is lost.
      put.dropResponse()
      const outcome = await saving

      expect(outcome).toEqual({ kind: 'maybe', message: MAYBE })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [false, 409],
      ])
      expect(reads(fake), 'the fresh read and the re-read').toHaveLength(2)
      expect(storedApproval(fake)).toEqual({
        defaultPolicy: 'channel_users',
        tools: { system_info: true },
      })
    })

    it('a first save whose re-read holds the sent policy is success', async () => {
      const fake = createFake(undefined)
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(firstSave())
      await put.arrived
      put.dropResponse()
      const outcome = await saving

      // The block appeared since the base: it is this save's own.
      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'reread' })
      expect(writes(fake).map(entry => [entry.applied, entry.delivered])).toEqual([[true, false]])
      expect(storedApproval(fake)).toEqual({
        defaultPolicy: 'cli_only',
        tools: { system_info: true },
      })
    })
  })

  describe('loosening at the write', () => {
    it('T21 a ceiling raised between dialog and write asks again', async () => {
      const fake = createFake({ modeCeiling: 'manual', tools: { shell_exec: true } })
      // At the dialog the ceiling was Manual: explicit Required → Default on
      // shell_exec loosened nothing, so no dialog was confirmed.
      expect(
        looseningItems({
          before: { modeCeiling: 'manual', tools: { shell_exec: true } },
          after: { modeCeiling: 'manual', tools: {} },
          ceiling: 'manual',
          firstSave: false,
        })
      ).toEqual([])
      const input = toolsSave({ base: { shell_exec: true }, draftTools: {} })
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).modeCeiling = 'auto'
      })
      const asked = await saveTools(input)

      expect(asked).toEqual({
        kind: 'reconfirm',
        items: [{ path: 'tools.shell_exec', rule: 'explicit_required_to_default_above_manual' }],
      })
      expect(writes(fake), 'PUTs before confirming').toEqual([])
      const confirmed = asked.kind === 'reconfirm' ? asked.items : []
      const saved = await saveTools({ ...input, confirmedItems: confirmed })
      expect(saved).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'auto', tools: {} })
    })

    it('an item confirmed in the dialog and gone by the write does not ask again', async () => {
      const fake = createFake({ modeCeiling: 'auto', tools: { shell_exec: true } })
      const confirmed: LooseningItem[] = [
        { path: 'tools.shell_exec', rule: 'explicit_required_to_default_above_manual' },
      ]
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).modeCeiling = 'manual'
      })
      const outcome = await saveTools(
        toolsSave({ base: { shell_exec: true }, draftTools: {}, confirmedItems: confirmed })
      )

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual', tools: {} })
    })
  })

  describe('errors', () => {
    it('T25 a 403 on the PUT returns its formatted error', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      put.respondWith(HOST_PUT_403.status, HOST_PUT_403.body)
      const outcome = await saving

      const text = JSON.stringify(HOST_PUT_403.body)
      const formatted = formatApiError(
        new Response(text, { status: 403, statusText: 'Forbidden' }),
        text
      )
      expect(outcome).toEqual({ kind: 'error', message: formatted.message })
      expect(formatted.message).toContain((HOST_PUT_403.body as { error: string }).error)
      expect(writes(fake), 'PUTs: no retry').toHaveLength(1)
      expect(reads(fake), 'reads: no re-read').toHaveLength(1)
      expect(storedApproval(fake)).toEqual({ tools: BASE_TOOLS })
    })

    it('a 404 on the PUT returns its formatted error', async () => {
      // control-api's 404 for a PUT of a Host that is gone, as the fake answers it.
      const gone = await createFakeControlApi({
        hosts: {},
        crd: 'current',
        versionRule: true,
      }).fetch(`/control-api${FOO}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: seedHost('foo').spec }),
      })
      const goneText = await gone.text()
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await put.arrived
      put.respondWith(gone.status, JSON.parse(goneText))
      const outcome = await saving

      const formatted = formatApiError(
        new Response(goneText, { status: gone.status, statusText: gone.statusText }),
        goneText
      )
      expect(gone.status).toBe(404)
      expect(outcome).toEqual({ kind: 'error', message: formatted.message })
      expect(writes(fake), 'PUTs: no retry').toHaveLength(1)
      expect(reads(fake), 'reads: no re-read').toHaveLength(1)
    })

    it('a 422 on the PUT is refused with each field and its message', async () => {
      // A model name with no provider: control-api validates the whole spec, so
      // a field the save did not touch refuses it (spec §6.4 step 11).
      const fake = createFake(
        { tools: { ...BASE_TOOLS } },
        { spec: { model: { name: 'claude-sonnet-4-6' } } }
      )
      const outcome = await saveTools(toolsSave())

      expect(outcome).toEqual({
        kind: 'refused',
        errors: (HOST_PUT_422.body as { errors: unknown[] }).errors,
      })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [false, 422],
      ])
      expect(reads(fake), 'reads: no re-read').toHaveLength(1)
    })

    it('a failed read before the PUT keeps the draft', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const read = fake.hold({ method: 'GET', path: FOO })
      const input = toolsSave()
      const saving = saveTools(input)
      await read.arrived
      read.respondWith(CONTROL_API_500.status, CONTROL_API_500.body)
      const outcome = await saving

      // The message the real client gives for the same answer.
      const oracle = fake.hold({ method: 'GET', path: FOO })
      const clientMessage = getHost('foo', { signal: new AbortController().signal }).then(
        () => 'no error',
        (error: unknown) => (error as Error).message
      )
      await oracle.arrived
      oracle.respondWith(CONTROL_API_500.status, CONTROL_API_500.body)
      expect(outcome).toEqual({ kind: 'error', message: await clientMessage })
      expect(await clientMessage).not.toBe('no error')
      expect(writes(fake), 'PUTs').toEqual([])
      expect(input.draftTools, 'the draft').toEqual(DRAFT_TOOLS)
    })

    it('a read before the PUT with no answer in 10 s ends in an error, with no PUT', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const read = fake.hold({ method: 'GET', path: FOO })
      const saving = track(saveTools(toolsSave()))
      await read.arrived
      read.hang()
      clock.advance(9_999)
      await flush()
      expect(saving.settled, 'settled before 10 s').toBe(false)
      clock.advance(1)
      // The abort follows at once, with no real time passing.
      await vi.waitFor(() => expect(saving.settled).toBe(true), { timeout: 1_000 })
      const outcome = await saving.promise

      expect(outcome).toEqual({ kind: 'error', message: REQUEST_TIMED_OUT_MESSAGE })
      expect(reads(fake).map(entry => entry.delivered)).toEqual([false])
      expect(writes(fake), 'PUTs').toEqual([])
      expect(clock.delays, 'the read ran on a 10 s virtual timer').toEqual([10_000])
    })

    it('a read without a resourceVersion is never followed by a PUT', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const read = fake.hold({ method: 'GET', path: FOO })
      const saving = saveTools(toolsSave())
      await read.arrived
      const unversioned = fake.stored('foo')
      delete unversioned.metadata.resourceVersion
      read.respondWith(200, unversioned)
      const outcome = await saving

      // Spec §6.5's refusal for a save with no version to send.
      expect(outcome).toEqual({ kind: 'error', message: 'Reload the page to save' })
      expect(reads(fake).map(entry => entry.delivered)).toEqual([true])
      expect(writes(fake), 'PUTs').toEqual([])
    })

    it('ends a hung per-tool PUT at 10 s on the virtual clock and re-reads', async () => {
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const saving = track(saveTools(toolsSave()))
      await put.arrived
      // control-api applies the write; its answer never comes.
      put.hang()
      put.applyNow()
      await vi.waitFor(() => expect(writes(fake)[0].applied).toBe(true))
      clock.advance(9_999)
      await flush()
      expect(saving.settled, 'settled before 10 s').toBe(false)
      expect(reads(fake), 'reads before 10 s').toHaveLength(1)
      clock.advance(1)
      // The re-read follows the abort at once, with no real time passing.
      await vi.waitFor(() => expect(reads(fake)).toHaveLength(2), { timeout: 1_000 })
      const outcome = await saving.promise

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'reread' })
      expect(writes(fake).map(entry => entry.delivered)).toEqual([false])
      // The fresh read, the PUT and the re-read each ran on a 10 s virtual timer.
      expect(clock.delays).toEqual([10_000, 10_000, 10_000])
      expect(clock.pending(), 'timers left').toBe(0)
    })

    it('routes a 401 on the PUT through the session path and keeps the draft', async () => {
      const onSessionExpired = vi.fn()
      setGlobalAuthErrorHandler(onSessionExpired)
      const fake = createFake({ tools: { ...BASE_TOOLS } })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const input = toolsSave()
      const saving = saveTools(input)
      await put.arrived
      // The session path reads the status only (apiSend), so the answer carries no body.
      put.respondWith(401, undefined)
      const outcome: ToolsSaveOutcome = await saving

      expect(onSessionExpired).toHaveBeenCalledTimes(1)
      expect(outcome).toEqual({ kind: 'error', message: new AuthExpiredError().message })
      expect(writes(fake).map(entry => [entry.applied, entry.delivered])).toEqual([[false, true]])
      expect(reads(fake), 'reads: no re-read').toHaveLength(1)
      expect(input.draftTools, 'the draft').toEqual(DRAFT_TOOLS)
    })
  })

  it('the messages for stops the outcome does not carry are spec §6.4 verbatim', () => {
    expect(TOOLS_CHANGED_MESSAGE).toBe(
      'These settings changed since you opened them. Reload to see the latest.'
    )
    expect(APPROVAL_CREATED_ELSEWHERE_MESSAGE).toBe(
      "This agent's approval settings were just created elsewhere. Reload to see them."
    )
    expect(notStoredMessage(['modeCeiling', 'channels.teams.enabled'])).toBe(
      "This cluster's Host schema is older than this Control UI and did not store: modeCeiling, channels.teams.enabled. Ask your platform team to apply the current CRDs."
    )
  })
})

describe('approval clock', () => {
  it('serves the injected clock until the reset restores the real one', () => {
    const injected = createVirtualClock()
    const random = seededRandom(7)
    __setApprovalClockForTests(injected, random)
    expect(getApprovalClock().clock).toBe(injected)
    expect(getApprovalClock().random).toBe(random)

    __resetHostApprovalSaveForTests()
    expect(getApprovalClock().clock).toBe(realApprovalClock)
    expect(getApprovalClock().random).toBe(Math.random)
  })
})
