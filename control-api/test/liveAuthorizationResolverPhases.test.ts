import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { resolveLiveActionAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  type TripwireQueryResult,
  installAccessTransactionTripwire,
} from './helpers/accessTransactionTripwire.js'
import {
  contextObject,
  createFakeOperationalGateway,
  hostObject,
  workflowRecipeObject,
} from './helpers/fakeOperationalGateway.js'

// Merge plan v2 §2.8: phase K1 (Kubernetes, no transaction), phase P (one
// read-only transaction), phase K2 (exact GETs, no transaction), and the
// caller-transaction guard (T-L7). Every case runs the T-L8 tripwire.

const environmentId = canonicalEnvironmentId()
const userId = '10000000-0000-4000-8000-000000000001'
const session = Object.freeze({
  contract: 'v2' as const,
  userId,
  sid: '20000000-0000-4000-8000-000000000002',
  jti: '30000000-0000-4000-8000-000000000003',
  sessionVersion: 1,
})
const runId = '60000000-0000-4000-8000-000000000006'
const notificationId = '70000000-0000-4000-8000-000000000007'

const hostResource = canonicalResourceIdentity({
  environmentId,
  type: 'host',
  logicalId: `${config.hostsNamespace}/host-a`,
})
const runResource = canonicalResourceIdentity({
  environmentId,
  type: 'workflow_run',
  logicalId: runId,
})
const notificationResource = canonicalResourceIdentity({
  environmentId,
  type: 'notification',
  logicalId: notificationId,
})

function rows(values: Record<string, unknown>[]): TripwireQueryResult {
  return { rows: values, rowCount: values.length }
}

function statements(options: { runRecipe?: string } = {}) {
  const seen: string[] = []
  const handler = (text: string): TripwireQueryResult => {
    if (text.startsWith('SET TRANSACTION') || text.includes("set_config('statement_timeout'")) {
      seen.push('configure')
      return rows([])
    }
    if (text.includes('AS session_live')) {
      seen.push('snapshot')
      return rows([
        { user_id: userId, session_live: true, session_revision: '1:current', memberships: [] },
      ])
    }
    if (text.includes('FROM token_budgets') || text.includes('FROM llm_allowed_models')) {
      seen.push('policy')
      return rows([])
    }
    if (text.includes('SELECT DISTINCT ON (context_id)')) return rows([])
    if (text.includes('SELECT recipe_namespace, recipe_name')) {
      seen.push('run-recipe-preread')
      return rows([{ recipe_namespace: config.sandboxNamespace, recipe_name: 'report' }])
    }
    if (text.includes("$2::text = 'workflow_run'")) {
      seen.push('database-candidates')
      const [namespace, name] = (options.runRecipe ?? `${config.sandboxNamespace}/report`).split(
        '/'
      )
      return rows([
        {
          kind: 'direct',
          grant_id: `workflow_runs:user:${runId}`,
          team_id: null,
          current_role: null,
          permissions: null,
          recipe_namespace: namespace,
          recipe_name: name,
          valid_until: null,
          related_team: null,
          usage_team: null,
          drive: null,
          parent_resource: null,
        },
      ])
    }
    if (text.includes('WITH candidates AS')) {
      seen.push('operational-candidates')
      return rows([
        {
          kind: 'direct',
          grant_id: `user_agents:${userId}:host-a`,
          team_id: null,
          current_role: null,
        },
      ])
    }
    throw new Error(`Unexpected query: ${text.slice(0, 120)}`)
  }
  return { handler, seen }
}

function objects() {
  return {
    hosts: [hostObject('host-a')],
    contexts: [contextObject('ctx-a')],
    workflowrecipes: [workflowRecipeObject('report', { contextRef: 'ctx-a' })],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolver phases K1, P, K2 (T-L8)', () => {
  it('reads Kubernetes before the transaction and re-reads bindings after it', async () => {
    const db = statements()
    const tripwire = installAccessTransactionTripwire(db.handler)
    const fake = createFakeOperationalGateway({ objects: objects(), tripwire })
    const result = await resolveLiveActionAuthorization(
      {
        session,
        operationId: 'host.status.read',
        resource: hostResource,
        operationTarget: { hostRef: hostResource.logicalId },
      },
      { gateway: fake.gateway }
    )
    expect(result.status, JSON.stringify(result)).toBe('allowed')
    const begin = tripwire.events.indexOf('BEGIN')
    const commit = tripwire.events.indexOf('COMMIT')
    expect(begin).toBeGreaterThan(-1)
    expect(commit).toBeGreaterThan(begin)
    const k1 = tripwire.events.slice(0, begin).filter(event => event.startsWith('call:'))
    const k2 = tripwire.events.slice(commit).filter(event => event.startsWith('call:'))
    expect(k1).toEqual(
      expect.arrayContaining([
        'call:getResourceExact:hosts/host-a',
        'call:listResourcePage:contexts',
      ])
    )
    expect(k2).toEqual(['call:getResourceExact:hosts/host-a'])
    expect(tripwire.events.slice(begin, commit).some(event => event.startsWith('call:'))).toBe(
      false
    )
    expect(db.seen).toEqual([
      'configure',
      'configure',
      'snapshot',
      'policy',
      'policy',
      'operational-candidates',
    ])
    expect(tripwire.openTransactions()).toBe(0)
  })

  it('loads a resume recipe graph before the transaction and asserts it inside', async () => {
    const db = statements()
    const tripwire = installAccessTransactionTripwire(db.handler)
    const fake = createFakeOperationalGateway({ objects: objects(), tripwire })
    const result = await resolveLiveActionAuthorization(
      {
        session,
        operationId: 'workflow.run.manage',
        resource: runResource,
        operationTarget: { runId, action: 'resume' },
      },
      { gateway: fake.gateway }
    )
    expect(result.status, JSON.stringify(result)).toBe('allowed')
    const begin = tripwire.events.indexOf('BEGIN')
    expect(tripwire.events.indexOf('autocommit')).toBeLessThan(begin)
    expect(tripwire.events.slice(0, begin)).toContain(
      'call:getResourceExact:workflowrecipes/report'
    )
    expect(db.seen).toContain('run-recipe-preread')
    expect(db.seen).toContain('database-candidates')
    if (result.status !== 'allowed') return
    expect(result.operationalBindings.map(binding => binding.resourceType).sort()).toEqual([
      'context',
      'workflow_recipe',
    ])
  })

  it('fails a resume closed when the run names another recipe inside the transaction', async () => {
    const db = statements({ runRecipe: `${config.sandboxNamespace}/other` })
    const tripwire = installAccessTransactionTripwire(db.handler)
    const fake = createFakeOperationalGateway({ objects: objects(), tripwire })
    const result = await resolveLiveActionAuthorization(
      {
        session,
        operationId: 'workflow.run.manage',
        resource: runResource,
        operationTarget: { runId, action: 'resume' },
      },
      { gateway: fake.gateway }
    )
    expect(result).toEqual({
      status: 'unavailable',
      dependencyClass: 'authorization_store',
      retryable: true,
    })
    // Witness: K1 loaded report, and P read the run's candidates.
    expect(tripwire.externalCalls).toContain('getResourceExact:workflowrecipes/report')
    expect(db.seen).toContain('database-candidates')
    expect(tripwire.openTransactions()).toBe(0)
  })
})

describe('fail-closed results through the resolver (T-L3)', () => {
  it('answers not_found for a root GET 404', async () => {
    const tripwire = installAccessTransactionTripwire(statements().handler)
    const fake = createFakeOperationalGateway({ objects: objects(), tripwire })
    const missing = canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: `${config.hostsNamespace}/missing`,
    })
    await expect(
      resolveLiveActionAuthorization(
        {
          session,
          operationId: 'host.status.read',
          resource: missing,
          operationTarget: { hostRef: missing.logicalId },
        },
        { gateway: fake.gateway }
      )
    ).resolves.toEqual({ status: 'not_found', code: 'not_found' })
    expect(tripwire.externalCalls).toContain('getResourceExact:hosts/missing')
  })

  it('answers unavailable for a LIST error', async () => {
    const tripwire = installAccessTransactionTripwire(statements().handler)
    const fake = createFakeOperationalGateway({
      objects: objects(),
      tripwire,
      fail: call =>
        call.method === 'listResourcePage'
          ? Object.assign(new Error('forbidden'), { statusCode: 403 })
          : undefined,
    })
    await expect(
      resolveLiveActionAuthorization(
        {
          session,
          operationId: 'host.status.read',
          resource: hostResource,
          operationTarget: { hostRef: hostResource.logicalId },
        },
        { gateway: fake.gateway }
      )
    ).resolves.toEqual({
      status: 'unavailable',
      dependencyClass: 'operational_resource_store',
      retryable: true,
    })
    expect(tripwire.externalCalls).toContain('listResourcePage:contexts')
  })

  it('answers unavailable with the capacity class when the loader exhausts the budget', async () => {
    const tripwire = installAccessTransactionTripwire(statements().handler)
    const many = Array.from({ length: 1_001 }, (_, index) => contextObject(`ctx-${index}`))
    const fake = createFakeOperationalGateway({
      objects: { ...objects(), contexts: many },
      tripwire,
    })
    const budget = AccessExecutionBudget.create('action')
    try {
      await expect(
        resolveLiveActionAuthorization(
          {
            session,
            operationId: 'host.status.read',
            resource: hostResource,
            operationTarget: { hostRef: hostResource.logicalId },
          },
          { gateway: fake.gateway, budget }
        )
      ).resolves.toEqual({ status: 'unavailable', dependencyClass: 'capacity', retryable: true })
      expect(budget.remaining('objects')).toBe(0)
    } finally {
      budget.close()
    }
  })
})

describe('caller-held transactions (T-L7)', () => {
  function callerTransaction(handler: (text: string) => TripwireQueryResult) {
    const query = vi.fn(async (text: string) => handler(text))
    const transaction = vi.fn(async <T>(work: (db: DbClient) => Promise<T>) =>
      work({ query } as unknown as DbClient)
    )
    return { query, transaction }
  }

  it('refuses an operational resource before any Kubernetes read', async () => {
    const db = statements()
    const tripwire = installAccessTransactionTripwire(db.handler)
    const fake = createFakeOperationalGateway({ objects: objects(), tripwire })
    const caller = callerTransaction(db.handler)
    await expect(
      resolveLiveActionAuthorization(
        {
          session,
          operationId: 'host.status.read',
          resource: hostResource,
          operationTarget: { hostRef: hostResource.logicalId },
        },
        { gateway: fake.gateway, transaction: caller.transaction, configureTransaction: false }
      )
    ).resolves.toEqual({
      status: 'unavailable',
      dependencyClass: 'operational_resource_store',
      retryable: true,
    })
    expect(fake.calls).toHaveLength(0)
    expect(caller.transaction).not.toHaveBeenCalled()
  })

  it('refuses a resume, whose recipe graph needs Kubernetes, in a caller transaction', async () => {
    const db = statements()
    const tripwire = installAccessTransactionTripwire(db.handler)
    const fake = createFakeOperationalGateway({ objects: objects(), tripwire })
    const caller = callerTransaction(db.handler)
    await expect(
      resolveLiveActionAuthorization(
        {
          session,
          operationId: 'workflow.run.manage',
          resource: runResource,
          operationTarget: { runId, action: 'resume' },
        },
        { gateway: fake.gateway, transaction: caller.transaction, configureTransaction: false }
      )
    ).resolves.toMatchObject({ status: 'unavailable' })
    expect(fake.calls).toHaveLength(0)
    expect(tripwire.events).not.toContain('autocommit')
    expect(caller.transaction).not.toHaveBeenCalled()
  })

  it('validates input before the guard (witness that the resolver was entered)', async () => {
    const db = statements()
    const tripwire = installAccessTransactionTripwire(db.handler)
    const fake = createFakeOperationalGateway({ objects: objects(), tripwire })
    const caller = callerTransaction(db.handler)
    await expect(
      resolveLiveActionAuthorization(
        {
          session,
          operationId: 'host.status.read',
          resource: hostResource,
          operationTarget: { hostRef: hostResource.logicalId },
          requestedAccessPathId: 'not-a-path-handle',
        },
        { gateway: fake.gateway, transaction: caller.transaction, configureTransaction: false }
      )
    ).resolves.toEqual({ status: 'invalid', code: 'invalid_operation_target' })
    expect(fake.calls).toHaveLength(0)
  })

  it('still resolves a Postgres-only resource inside the caller transaction', async () => {
    const db = statements()
    installAccessTransactionTripwire(db.handler)
    const caller = callerTransaction(text => {
      if (text.includes("$2::text = 'notification'") && text.includes('WITH candidates AS')) {
        return rows([
          {
            kind: 'direct',
            grant_id: `notifications:user:${notificationId}`,
            team_id: null,
            current_role: null,
            permissions: null,
            recipe_namespace: null,
            recipe_name: null,
            valid_until: null,
            related_team: null,
            usage_team: null,
            drive: null,
            parent_resource: null,
          },
        ])
      }
      return db.handler(text)
    })
    const result = await resolveLiveActionAuthorization(
      {
        session,
        operationId: 'notification.read',
        resource: notificationResource,
        operationTarget: { notificationId },
      },
      { transaction: caller.transaction, configureTransaction: false }
    )
    expect(result.status, JSON.stringify(result)).toBe('allowed')
    expect(caller.transaction).toHaveBeenCalledTimes(1)
    expect(caller.query.mock.calls.length).toBeGreaterThan(0)
  })
})
