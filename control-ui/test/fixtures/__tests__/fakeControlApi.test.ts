import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { materializeHostResource } from '../contextResource'
import {
  type FakeControlApi,
  type FakePoint,
  type HostObject,
  createFakeControlApi,
} from '../fakeControlApi'

const HOST_URL = '/control-api/api/v1/admin/hosts/foo'
const HOST_PATH = '/api/v1/admin/hosts/foo'

type WireAnswer = { status: number; body: unknown }

/** A control-api producer wire file (control-api/test/fixtures/wire). */
function readControlApiWire<T>(file: string): T {
  return JSON.parse(
    readFileSync(resolve(__dirname, '../../../../control-api/test/fixtures/wire', file), 'utf8')
  ) as T
}

// control-api's recorded GET /admin/llm-models answer.
const LLM_MODELS_WIRE = readControlApiWire<{ list: WireAnswer }>('llmModelsSetupEnsure.wire.json')
// control-api's recorded Host PUT answers (control-api/test/routes.hostPut.fakeContract.test.ts).
const HOST_PUT_409 = readControlApiWire<WireAnswer>('host-put-409.wire.json')
const HOST_PUT_WARNINGS = readControlApiWire<WireAnswer>('host-put-warnings.wire.json')

type FakeOptions = Parameters<typeof createFakeControlApi>[0]

function seedHost(approval?: Record<string, unknown>): HostObject {
  return materializeHostResource({
    metadata: { name: 'foo' },
    spec: {
      host: 'foo',
      contextRef: 'ctx-a',
      secretRef: 'foo-llm',
      channels: [],
      model: { provider: 'claude', name: 'claude-sonnet-4-6' },
      ...(approval ? { approval } : {}),
    },
  })
}

function createFake(options: Partial<FakeOptions> = {}): FakeControlApi {
  return createFakeControlApi({
    hosts: { foo: seedHost() },
    crd: 'current',
    versionRule: false,
    ...options,
  })
}

function putHost(fake: FakeControlApi, body: unknown, init: RequestInit = {}) {
  return fake.fetch(HOST_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

function settledState(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false }
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  )
  return state
}

describe('fake control-api: Host PUT', () => {
  it('versioned PUT with a stale version answers 409', async () => {
    const fake = createFake()
    const read = fake.stored('foo')
    const version = read.metadata.resourceVersion

    const accepted = await putHost(fake, {
      metadata: { resourceVersion: version },
      spec: { ...read.spec, contextRef: 'ctx-b' },
    })
    expect(accepted.status).toBe(200)

    const stale = await putHost(fake, {
      metadata: { resourceVersion: version },
      spec: { ...read.spec, contextRef: 'ctx-c' },
    })
    expect(stale.status).toBe(HOST_PUT_409.status)
    expect(stale.statusText).toBe('Conflict')
    expect(await stale.json()).toEqual(HOST_PUT_409.body)
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-b')
    expect(
      fake.log.map(entry => [entry.versionSent, entry.applied, entry.response?.status])
    ).toEqual([
      [version, true, 200],
      [version, false, 409],
    ])
  })

  it('every accepted PUT moves the version, even with an unchanged spec', async () => {
    const fake = createFake()
    const read = fake.stored('foo')

    const versioned = await putHost(fake, {
      metadata: { resourceVersion: read.metadata.resourceVersion },
      spec: read.spec,
    })
    const afterVersioned = (await versioned.json()) as HostObject
    const versionless = await putHost(fake, { spec: read.spec })
    const afterVersionless = (await versionless.json()) as HostObject

    expect([versioned.status, versionless.status]).toEqual([200, 200])
    const versions = [
      read.metadata.resourceVersion,
      afterVersioned.metadata.resourceVersion,
      afterVersionless.metadata.resourceVersion,
    ]
    expect(new Set(versions).size).toBe(3)
    expect(fake.stored('foo').spec).toEqual(read.spec)
  })

  it('a PUT with an unchanged spec answers a version its post-write patch has already moved past', async () => {
    const fake = createFake()
    const read = fake.stored('foo')

    const changed = await putHost(fake, { spec: { ...read.spec, contextRef: 'ctx-b' } })
    const changedAnswer = (await changed.json()) as HostObject
    expect(changed.status).toBe(200)
    expect(fake.stored('foo').metadata.resourceVersion).toBe(changedAnswer.metadata.resourceVersion)

    const unchanged = await putHost(fake, { spec: changedAnswer.spec })
    const unchangedAnswer = (await unchanged.json()) as HostObject
    expect(unchanged.status).toBe(200)
    expect(unchangedAnswer.metadata.resourceVersion).not.toBe(
      changedAnswer.metadata.resourceVersion
    )
    expect(fake.stored('foo').metadata.resourceVersion).not.toBe(
      unchangedAnswer.metadata.resourceVersion
    )

    const fromAnswer = await putHost(fake, {
      metadata: { resourceVersion: unchangedAnswer.metadata.resourceVersion },
      spec: changedAnswer.spec,
    })
    expect(fromAnswer.status).toBe(HOST_PUT_409.status)
    expect(await fromAnswer.json()).toEqual(HOST_PUT_409.body)
  })

  it('a PUT that newly assigns a stale model answers the warnings control-api records', async () => {
    const recorded = HOST_PUT_WARNINGS.body as HostObject & { warnings: unknown[] }
    const staleModel = recorded.spec.model as { provider: string; name: string }
    const fake = createFake({
      staleModels: [{ provider: staleModel.provider, model: staleModel.name }],
    })
    const read = fake.stored('foo')
    expect(read.spec.model).not.toEqual(staleModel)

    const assigned = await putHost(fake, { spec: { ...read.spec, model: staleModel } })
    expect(assigned.status).toBe(HOST_PUT_WARNINGS.status)
    expect(((await assigned.json()) as { warnings?: unknown }).warnings).toEqual(recorded.warnings)
    expect(fake.stored('foo').spec.model).toEqual(staleModel)

    // The stored spec now references it: a live reference is not revalidated.
    const kept = await putHost(fake, {
      spec: { ...read.spec, model: staleModel, contextRef: 'ctx-b' },
    })
    expect(kept.status).toBe(200)
    const keptBody = (await kept.json()) as HostObject
    expect(keptBody.spec.contextRef).toBe('ctx-b')
    expect(keptBody).not.toHaveProperty('warnings')
  })

  it('version-less PUT is last-write-wins', async () => {
    const approval = { defaultPolicy: 'cli_only', channels: {} }
    const fake = createFake({ hosts: { foo: seedHost(approval) } })
    const formRead = fake.stored('foo')

    fake.writeExternal('foo', spec => {
      spec.contextRef = 'ctx-external'
    })
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-external')
    expect(fake.stored('foo').metadata.resourceVersion).not.toBe(formRead.metadata.resourceVersion)

    const response = await putHost(fake, {
      spec: { ...formRead.spec, approval: { ...approval, tools: { shell_exec: false } } },
    })

    expect(response.status).toBe(200)
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-a')
    expect(fake.stored('foo').spec.approval).toEqual({ ...approval, tools: { shell_exec: false } })
    expect(fake.log[0]).toMatchObject({ method: 'PUT', applied: true })
    expect(fake.log[0].versionSent).toBeUndefined()
  })

  describe('with versionRule: true', () => {
    const approval = { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'manual' }

    it('version-less PUT that changes spec.approval answers 409 approval_requires_version', async () => {
      const fake = createFake({ versionRule: true, hosts: { foo: seedHost(approval) } })
      const before = fake.stored('foo')

      const refused = await putHost(fake, {
        spec: { ...before.spec, approval: { ...approval, modeCeiling: 'allow_all' } },
      })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toEqual({
        error: 'conflict',
        reason: 'approval_requires_version',
      })
      expect(fake.stored('foo')).toEqual(before)

      const versioned = await putHost(fake, {
        metadata: { resourceVersion: before.metadata.resourceVersion },
        spec: { ...before.spec, approval: { ...approval, modeCeiling: 'allow_all' } },
      })
      expect(versioned.status).toBe(200)
      expect(fake.stored('foo').spec.approval).toEqual({ ...approval, modeCeiling: 'allow_all' })
    })

    it('unchanged approval is accepted', async () => {
      const fake = createFake({ versionRule: true, hosts: { foo: seedHost(approval) } })
      const before = fake.stored('foo')
      const reordered = { modeCeiling: 'manual', channels: {}, defaultPolicy: 'cli_only' }

      const response = await putHost(fake, {
        spec: { ...before.spec, contextRef: 'ctx-b', approval: reordered },
      })

      expect(response.status).toBe(200)
      expect(fake.stored('foo').spec.contextRef).toBe('ctx-b')
    })
  })

  it('v0.12.1 crd prunes modeCeiling on write', async () => {
    const fake = createFake({ crd: 'v0.12.1' })
    const read = fake.stored('foo')

    const response = await putHost(fake, {
      spec: { ...read.spec, approval: { modeCeiling: 'manual', tools: { shell_exec: true } } },
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as HostObject).spec.approval).toEqual({
      tools: { shell_exec: true },
    })
    expect(fake.stored('foo').spec.approval).toEqual({ tools: { shell_exec: true } })

    fake.writeExternal('foo', spec => {
      spec.approval = { modeCeiling: 'auto', defaultPolicy: 'open' }
    })
    expect(fake.stored('foo').spec.approval).toEqual({ defaultPolicy: 'open' })
  })

  it('current crd defaults allowModeChange on a created channel block', async () => {
    const fake = createFake({ crd: 'current' })
    const read = fake.stored('foo')

    const response = await putHost(fake, {
      spec: { ...read.spec, approval: { channels: { telegram: { enabled: true } } } },
    })

    const defaulted = { channels: { telegram: { enabled: true, allowModeChange: true } } }
    expect(((await response.json()) as HostObject).spec.approval).toEqual(defaulted)
    expect(fake.stored('foo').spec.approval).toEqual(defaulted)
  })

  it('a structural 422 stores nothing, before any version check', async () => {
    const fake = createFake()
    const before = fake.stored('foo')

    const refused = await putHost(fake, {
      metadata: { resourceVersion: 'not-the-stored-version' },
      spec: { ...before.spec, model: { name: 'claude-sonnet-4-6' } },
    })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({
      errors: [
        {
          field: 'spec.model.provider',
          message: 'spec.model.provider is required when spec.model.name is set',
        },
      ],
    })
    const blankName = await putHost(fake, {
      spec: { ...before.spec, model: { provider: 'claude', name: ' ' } },
    })
    expect(blankName.status).toBe(422)
    expect(await blankName.json()).toEqual({
      errors: [{ field: 'spec.model.name', message: 'spec.model.name must be a non-empty string' }],
    })
    expect(fake.stored('foo')).toEqual(before)

    const accepted = await putHost(fake, {
      spec: { ...before.spec, model: { provider: 'claude', name: 'claude-opus-4-1' } },
    })
    expect(accepted.status).toBe(200)
    expect(fake.stored('foo').spec.model).toEqual({ provider: 'claude', name: 'claude-opus-4-1' })
  })

  it('bumpVersion moves the version without changing the spec', async () => {
    const fake = createFake()
    const before = fake.stored('foo')

    fake.bumpVersion('foo', 'status')

    expect(fake.stored('foo').metadata.resourceVersion).not.toBe(before.metadata.resourceVersion)
    expect(fake.stored('foo').spec).toEqual(before.spec)
    const response = await putHost(fake, {
      metadata: { resourceVersion: before.metadata.resourceVersion },
      spec: before.spec,
    })
    expect(response.status).toBe(409)
  })
})

describe('fake control-api: Host reads', () => {
  it('detail answers the stored Host in the detail bundle, and 404 for a missing Host', async () => {
    const fake = createFake()

    const detail = await fake.fetch(`${HOST_URL}/detail`)
    expect(await detail.json()).toEqual({
      host: fake.stored('foo'),
      contexts: [],
      secrets: [],
      users: [],
      teams: [],
      agentUsers: [],
      agentTeams: [],
    })

    const missing = await fake.fetch('/control-api/api/v1/admin/hosts/nobody')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: 'hosts/nobody not found in namespace mcp-host',
      correlationId: expect.any(String),
    })
  })

  it('reads a Host whose name needs encoding by its decoded name', async () => {
    const spaced = materializeHostResource({
      metadata: { name: 'a b' },
      spec: {
        host: 'a b',
        contextRef: 'ctx-a',
        secretRef: 'a-b-llm',
        channels: [],
        model: { provider: 'claude', name: 'claude-sonnet-4-6' },
      },
    })
    const fake = createFake({ hosts: { 'a b': spaced } })

    const response = await fake.fetch(
      `/control-api/api/v1/admin/hosts/${encodeURIComponent('a b')}`
    )

    expect(response.status).toBe(200)
    expect(((await response.json()) as HostObject).metadata.name).toBe('a b')
    expect(fake.log[0].path).toBe('/api/v1/admin/hosts/a%20b')
  })
})

describe('fake control-api: arrival, apply and delivery', () => {
  it('a held read returns the store as of arrival even if a write applies before delivery', async () => {
    const fake = createFake()
    const before = fake.stored('foo')
    const hold = fake.hold({ method: 'GET', path: HOST_PATH })

    const read = fake.fetch(HOST_URL)
    await hold.arrived
    const write = await putHost(fake, { spec: { ...before.spec, contextRef: 'ctx-b' } })
    expect(write.status).toBe(200)
    hold.deliverNow()

    expect(await (await read).json()).toEqual(before)
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-b')
  })

  it('a held versioned write applied after a later write answers 409', async () => {
    const fake = createFake()
    const read = fake.stored('foo')
    const version = read.metadata.resourceVersion
    const hold = fake.hold({ method: 'PUT', path: HOST_PATH })

    const first = putHost(fake, {
      metadata: { resourceVersion: version },
      spec: { ...read.spec, contextRef: 'ctx-first' },
    })
    await hold.arrived
    const later = await putHost(fake, {
      metadata: { resourceVersion: version },
      spec: { ...read.spec, contextRef: 'ctx-later' },
    })
    expect(later.status).toBe(200)
    hold.deliverNow()

    const response = await first
    expect(response.status).toBe(HOST_PUT_409.status)
    expect(await response.json()).toEqual(HOST_PUT_409.body)
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-later')
    expect(fake.log.map(entry => [entry.seq, entry.applied, entry.response?.status])).toEqual([
      [1, false, 409],
      [2, true, 200],
    ])
  })

  it('an aborted held request rejects with AbortError', async () => {
    const fake = createFake()
    const read = fake.stored('foo')
    const hold = fake.hold({ method: 'PUT', path: HOST_PATH })
    const controller = new AbortController()

    const pending = putHost(
      fake,
      { spec: { ...read.spec, contextRef: 'ctx-b' } },
      { signal: controller.signal }
    )
    await hold.arrived
    controller.abort()

    const error = (await pending.catch((reason: unknown) => reason)) as DOMException
    expect(error.name).toBe('AbortError')
    expect(error.message).toBe('The operation was aborted.')

    // control-api can still finish the write the browser abandoned.
    hold.deliverNow()
    await vi.waitFor(() => expect(fake.stored('foo').spec.contextRef).toBe('ctx-b'))
    expect(fake.log[0]).toMatchObject({ applied: true, delivered: false })

    // A signal aborted before the call never reaches control-api.
    const aborted = new AbortController()
    aborted.abort()
    const early = (await fake
      .fetch(HOST_URL, { signal: aborted.signal })
      .catch((reason: unknown) => reason)) as DOMException
    expect(early.name).toBe('AbortError')
    expect(fake.log).toHaveLength(1)
  })

  it('dropResponse rejects with TypeError after the write applied', async () => {
    const fake = createFake()
    const read = fake.stored('foo')
    const hold = fake.hold({ method: 'PUT', path: HOST_PATH })

    const pending = putHost(fake, { spec: { ...read.spec, contextRef: 'ctx-b' } })
    await hold.arrived
    hold.dropResponse()

    const error = await pending.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe('Failed to fetch')
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-b')
    expect(fake.log[0]).toMatchObject({
      applied: true,
      delivered: false,
      response: { status: 200 },
    })
  })

  it('hang leaves the promise pending', async () => {
    const fake = createFake()
    const read = fake.stored('foo')
    const hold = fake.hold({ method: 'PUT', path: HOST_PATH })
    const controller = new AbortController()

    const pending = putHost(
      fake,
      { spec: { ...read.spec, contextRef: 'ctx-b' } },
      { signal: controller.signal }
    )
    const outcome = settledState(pending)
    await hold.arrived
    hold.applyNow()
    hold.hang()
    await vi.waitFor(() => expect(fake.log[0].applied).toBe(true))
    await new Promise(resolveTimer => setTimeout(resolveTimer, 20))

    expect(outcome.settled).toBe(false)
    expect(fake.log[0].delivered).toBe(false)
    expect(() => hold.deliverNow()).toThrow(/after hang/)

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('respondWith answers instead of the store, and a late apply still lands', async () => {
    const fake = createFake()
    const read = fake.stored('foo')
    const hold = fake.hold({ method: 'PUT', path: HOST_PATH })
    const injectedAnswer = { marker: 'injected' }

    const pending = putHost(fake, { spec: { ...read.spec, contextRef: 'ctx-b' } })
    await hold.arrived
    hold.respondWith(504, injectedAnswer)

    const response = await pending
    expect([response.status, response.statusText]).toEqual([504, 'Gateway Timeout'])
    expect(await response.json()).toEqual(injectedAnswer)
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-a')

    hold.applyNow()
    await vi.waitFor(() => expect(fake.stored('foo').spec.contextRef).toBe('ctx-b'))
    expect(fake.log[0]).toMatchObject({
      applied: true,
      delivered: true,
      response: { status: 504, body: injectedAnswer },
    })
  })

  it('a hold with nth holds the nth matching request after the hold call', async () => {
    const fake = createFake()
    await fake.fetch(HOST_URL)
    const hold = fake.hold({ method: 'GET', path: HOST_URL, nth: 2 })

    await fake.fetch(HOST_URL)
    const third = fake.fetch(HOST_URL)
    await hold.arrived
    expect(fake.log.map(entry => entry.delivered)).toEqual([true, true, false])

    hold.deliverNow()
    expect((await third).status).toBe(200)
    expect(fake.log[2].delivered).toBe(true)
  })

  it('schedule is awaited at arrival, apply and delivery in that order', async () => {
    const calls: string[] = []
    const releases: Array<() => void> = []
    const schedule = (point: FakePoint, entry: { method: string }) => {
      calls.push(`${point} ${entry.method}`)
      return new Promise<void>(release => releases.push(release))
    }
    const fake = createFake({ schedule })
    const read = fake.stored('foo')

    const pending = putHost(fake, { spec: { ...read.spec, contextRef: 'ctx-b' } })
    const entry = fake.log[0]
    await vi.waitFor(() => expect(calls).toEqual(['arrival PUT']))
    expect(entry).toMatchObject({ arrived: false, applied: false, delivered: false })

    releases[0]()
    await vi.waitFor(() => expect(calls).toEqual(['arrival PUT', 'apply PUT']))
    expect(entry).toMatchObject({ arrived: true, applied: false })
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-a')

    releases[1]()
    await vi.waitFor(() => expect(calls).toEqual(['arrival PUT', 'apply PUT', 'delivery PUT']))
    expect(entry).toMatchObject({ applied: true, delivered: false })
    expect(fake.stored('foo').spec.contextRef).toBe('ctx-b')

    releases[2]()
    expect((await pending).status).toBe(200)
    expect(entry.delivered).toBe(true)
  })
})

describe('fake control-api: unmodelled paths', () => {
  it('an unmodelled path answers its recorded default', async () => {
    const fake = createFake({ defaults: { '/api/v1/admin/llm-models': LLM_MODELS_WIRE.list } })

    const response = await fake.fetch('/control-api/api/v1/admin/llm-models')

    expect(response.status).toBe(LLM_MODELS_WIRE.list.status)
    expect(await response.json()).toEqual(LLM_MODELS_WIRE.list.body)
    expect(fake.log).toEqual([
      expect.objectContaining({ kind: 'read', method: 'GET', path: '/api/v1/admin/llm-models' }),
    ])
  })

  it('an unmodelled path with no default answers 404 and is logged', async () => {
    const fake = createFake()

    const response = await fake.fetch('/control-api/api/v1/admin/users?q=')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not Found' })
    expect(fake.log).toEqual([
      expect.objectContaining({
        seq: 1,
        kind: 'read',
        method: 'GET',
        path: '/api/v1/admin/users',
        delivered: true,
        response: { status: 404, body: { error: 'Not Found' } },
      }),
    ])
  })
})
