/**
 * The intended approval change on the administrative intent event (spec
 * 2026-11-24-control-ui-approval-settings §6.8): the `summary` of the intent
 * event written for each Host request. No migration, no new event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import {
  type HostApprovalChange,
  MAX_APPROVAL_CHANGE_SUMMARY_LENGTH,
  serializeApprovalChangeSummary,
} from '../src/services/hostApprovalAudit.js'
import { ControlApiAdministrativeOperationService } from '../src/services/tracing/adminOperationService.js'
import { AdministrativeEventService } from '../src/services/tracing/administrativeEvents.js'
import { projectTraceSafeFields } from '../src/services/tracing/traceSafeFieldProjection.js'
import {
  type HarnessAllowedModel,
  type HarnessObject,
  type HostRouteHarness,
  buildHostRouteHarness,
} from './helpers/hostRouteHarness.js'

const ALLOWED_MODELS: HarnessAllowedModel[] = [
  { provider: 'claude', model: 'claude-sonnet-4-6', enabled: true, stale: false },
]
const HOSTS_PATH = '/api/v1/admin/hosts'
const HOST_PATH = `${HOSTS_PATH}/foo`
const APPROVER_ONE = 'seeded-approver-aaa'
const APPROVER_TWO = 'seeded-approver-bbb'
const SEED: HarnessObject = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'Host',
  metadata: { name: 'foo' },
  spec: {
    host: 'foo',
    contextRef: 'ctx-a',
    secretRef: 'foo-llm',
    channels: [],
    model: { provider: 'claude', name: 'claude-sonnet-4-6' },
    approval: {
      defaultPolicy: 'designated_approvers',
      channels: { telegram: { enabled: true, approvers: [APPROVER_ONE] } },
      modeCeiling: 'manual',
    },
  },
  status: { lifecycle: { state: 'active', effectiveMode: 'stateful', observedGeneration: 1 } },
}

function change(overrides: Partial<HostApprovalChange> = {}): HostApprovalChange {
  return {
    fields: {},
    tools: {},
    toolsTruncated: 0,
    approvers: {},
    blockRemoved: false,
    inheritedBefore: false,
    ...overrides,
  }
}

describe('serializeApprovalChangeSummary', () => {
  it('serializes the change as JSON when it fits', () => {
    const text = serializeApprovalChangeSummary(
      change({ fields: { modeCeiling: { old: 'manual', new: 'allow_all' } } })
    )
    expect(JSON.parse(text)).toEqual({
      fields: { modeCeiling: { old: 'manual', new: 'allow_all' } },
      tools: {},
      toolsTruncated: 0,
      approvers: {},
      blockRemoved: false,
      inheritedBefore: false,
    })
  })

  it('an oversized change drops tool entries into toolsTruncated and still parses', () => {
    const tools: HostApprovalChange['tools'] = {}
    for (let index = 0; index < 50; index += 1) {
      tools[`${String(index).padStart(2, '0')}-${'t'.repeat(61)}`] = { old: null, new: true }
    }
    const input = change({ tools, toolsTruncated: 3 })
    expect(JSON.stringify(input).length).toBeGreaterThan(MAX_APPROVAL_CHANGE_SUMMARY_LENGTH)

    const text = serializeApprovalChangeSummary(input)

    expect(text.length).toBeLessThanOrEqual(MAX_APPROVAL_CHANGE_SUMMARY_LENGTH)
    const parsed = JSON.parse(text) as HostApprovalChange
    const kept = Object.keys(parsed.tools)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(50)
    // Entries go from the end: the kept ones are the first, in order.
    expect(kept).toEqual(Object.keys(tools).slice(0, kept.length))
    expect(parsed.toolsTruncated).toBe(3 + (50 - kept.length))
  })

  it('falls back to a counts-only object that parses when no tool entries are left to drop', () => {
    const fields: HostApprovalChange['fields'] = {}
    for (let index = 0; index < 60; index += 1) {
      fields[`f${index}-${'k'.repeat(120)}`] = { old: 'o'.repeat(128), new: 'n'.repeat(128) }
    }
    const tools: HostApprovalChange['tools'] = { a: { old: null, new: true } }
    const approvers = { 'channels.telegram': { added: 2, removed: 1 } }
    const input = change({ fields, tools, toolsTruncated: 4, approvers, inheritedBefore: true })

    const text = serializeApprovalChangeSummary(input)

    expect(text.length).toBeLessThanOrEqual(MAX_APPROVAL_CHANGE_SUMMARY_LENGTH)
    expect(JSON.parse(text)).toEqual({
      truncated: true,
      fieldCount: 60,
      toolCount: 5,
      approverChannelCount: 1,
      approversAdded: 2,
      approversRemoved: 1,
      blockRemoved: false,
      inheritedBefore: true,
    })
  })
})

describe('persistHostIntent summary', () => {
  let append: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    append = vi
      .spyOn(AdministrativeEventService.prototype, 'append')
      .mockResolvedValue(undefined as never)
  })
  afterEach(() => vi.restoreAllMocks())

  const service = () =>
    new ControlApiAdministrativeOperationService({ transaction: vi.fn() } as never)
  const persistedPayload = () =>
    (append.mock.calls[0] as unknown[])[2] as { payload: Record<string, unknown> }

  it('writes the summary into the intent event payload', async () => {
    await service().persistHostIntent({
      action: 'update',
      namespace: 'mcp-host',
      name: 'foo',
      operatorSub: 'op-1',
      requestId: null,
      summary: '{"fields":{}}',
    })
    expect(append).toHaveBeenCalledTimes(1)
    expect(persistedPayload().payload).toEqual({
      resource_class: 'Host',
      status: 'attempted',
      summary: '{"fields":{}}',
    })
  })

  it('writes no summary key when none is given', async () => {
    await service().persistHostIntent({
      action: 'update',
      namespace: 'mcp-host',
      name: 'foo',
      operatorSub: 'op-1',
      requestId: null,
    })
    expect(append).toHaveBeenCalledTimes(1)
    expect(persistedPayload().payload).toEqual({ resource_class: 'Host', status: 'attempted' })
  })
})

describe('the intent event of a Host request', () => {
  let harness: HostRouteHarness | undefined

  beforeEach(() => {
    harness = buildHostRouteHarness({ allowedModels: ALLOWED_MODELS })
    harness.store.seed('hosts', SEED)
  })
  afterEach(() => {
    harness?.dispose()
    harness = undefined
    vi.restoreAllMocks()
  })

  const intents = () =>
    harness!.adminOperations.flatMap(call => (call.method === 'persistHostIntent' ? [call] : []))

  async function readHost(): Promise<{ spec: Record<string, unknown>; resourceVersion: string }> {
    const read = await request(harness!.app).get(HOST_PATH)
    expect(read.status).toBe(200)
    return { spec: read.body.spec, resourceVersion: read.body.metadata.resourceVersion }
  }

  it("the intent event's summary holds the capped approval change", async () => {
    const { spec, resourceVersion } = await readHost()
    const approval = spec.approval as Record<string, unknown>

    const res = await request(harness!.app)
      .put(HOST_PATH)
      .send({
        metadata: { resourceVersion },
        spec: {
          ...spec,
          approval: {
            ...approval,
            modeCeiling: 'allow_all',
            channels: { telegram: { enabled: true, approvers: [APPROVER_ONE, APPROVER_TWO] } },
          },
        },
      })

    expect(res.status).toBe(200)
    expect(intents()).toHaveLength(1)
    const summary = intents()[0].input.summary
    expect(typeof summary).toBe('string')
    expect(summary!.length).toBeLessThanOrEqual(MAX_APPROVAL_CHANGE_SUMMARY_LENGTH)
    const parsed = JSON.parse(summary!) as HostApprovalChange
    expect(parsed.fields.modeCeiling).toEqual({ old: 'manual', new: 'allow_all' })
    expect(parsed.approvers['channels.telegram']).toEqual({ added: 1, removed: 0 })
    expect(parsed.inheritedBefore).toBe(false)
    // The summary names no approver, only counts.
    expect(summary).not.toContain(APPROVER_ONE)
    expect(summary).not.toContain(APPROVER_TWO)
    expect(summary).not.toMatch(/seeded-approver/)
  })

  it('no summary when approval is unchanged', async () => {
    // The apiserver prunes and defaults the approval block on every write; one
    // write first settles the stored block.
    const seeded = await readHost()
    const settle = await request(harness!.app).put(HOST_PATH).send({ spec: seeded.spec })
    expect(settle.status).toBe(200)
    const { spec } = await readHost()
    const before = intents().length

    const res = await request(harness!.app)
      .put(HOST_PATH)
      .send({ spec: { ...spec, contextRef: 'ctx-b' } })

    expect(res.status).toBe(200)
    // The partner test above proves a changed approval puts a summary on the
    // intent; here the intent is written and carries none.
    expect(intents()).toHaveLength(before + 1)
    expect(intents()[before].input.summary).toBeUndefined()
  })

  it('create records the change with inheritedBefore', async () => {
    const res = await request(harness!.app)
      .post(HOSTS_PATH)
      .send({
        metadata: { name: 'bar' },
        spec: {
          ...(SEED.spec as Record<string, unknown>),
          host: 'bar',
          approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'auto' },
        },
      })

    expect(res.status).toBe(201)
    const create = intents().find(call => call.input.action === 'create')
    expect(create).toBeDefined()
    const parsed = JSON.parse(create!.input.summary!) as HostApprovalChange
    expect(parsed.inheritedBefore).toBe(true)
    expect(parsed.fields.modeCeiling).toEqual({ old: null, new: 'auto' })
  })
})

describe('the administrative trace read profile', () => {
  it('the administrative trace read returns summary', () => {
    const summary = serializeApprovalChangeSummary(
      change({ fields: { modeCeiling: { old: 'manual', new: 'allow_all' } } })
    )
    expect(
      projectTraceSafeFields(
        { resource_class: 'Host', status: 'attempted', summary },
        'administrative'
      )
    ).toEqual({ resource_class: 'Host', status: 'attempted', summary })
  })

  it('an administrative event without summary reads as before', () => {
    expect(
      projectTraceSafeFields({ resource_class: 'Host', status: 'attempted' }, 'administrative')
    ).toEqual({ resource_class: 'Host', status: 'attempted' })
  })

  it('drops a summary that is not a string of at most the cap', () => {
    const tooLong = 'x'.repeat(MAX_APPROVAL_CHANGE_SUMMARY_LENGTH + 1)
    expect(
      projectTraceSafeFields({ status: 'attempted', summary: tooLong }, 'administrative')
    ).toEqual({
      status: 'attempted',
    })
    expect(projectTraceSafeFields({ status: 'attempted', summary: 7 }, 'administrative')).toEqual({
      status: 'attempted',
    })
  })

  it('does not widen any other profile', () => {
    for (const profile of ['infrastructure', 'session'] as const) {
      expect(projectTraceSafeFields({ status: 'ok', summary: '{}' }, profile)).not.toHaveProperty(
        'summary'
      )
    }
  })
})
