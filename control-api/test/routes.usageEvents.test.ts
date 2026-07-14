import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const VALID_EVENT = {
  request_id: '11111111-1111-4111-8111-111111111111',
  ts: '2026-04-29T10:00:00.000Z',
  host_ref: 'trader',
  context_ref: 'trader-context',
  team_id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai',
  model: 'gpt-4o',
  llm_secret_name: 'openai-key',
  source_kind: 'desktop',
  user_id: '22222222-2222-4222-8222-222222222222',
  sender: null,
  channel_type: null,
  recipe_name: null,
  cron_job_id: null,
  task_id: 'task-1',
  iteration: 0,
  input_tokens: 120,
  output_tokens: 80,
}

const WORKFLOW_TASK_ID = '00000000-0000-4000-8000-000000000001:my-recipe:2026-05-09T00:00:00.000Z'
const WORKFLOW_RUN_ID = '00000000-0000-4000-8000-000000000001'
const WORKFLOW_TEAM_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKFLOW_TEAM_ID = '33333333-3333-4333-8333-333333333333'
const ADMIN_USAGE_TEAM_ID = 'control-plane-admin-ui'
const ADMIN_USER_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_ADMIN_USER_ID = '55555555-5555-4555-8555-555555555555'

function authedPost(
  app: ReturnType<typeof createApp>,
  binding:
    | { kind: 'sentinel'; hostName?: string }
    | { kind: 'recipe'; namespace: string; name: string } = { kind: 'sentinel' }
) {
  let token: string
  if (binding.kind === 'sentinel') {
    const hostName = binding.hostName ?? 'trader'
    token = issueMcpHostAccessJwt('mcp-host', 'standalone', [hostName]).token
  } else {
    token = issueMcpHostAccessJwt(binding.namespace, binding.name).token
  }
  return request(app)
    .post('/api/v1/internal/usage/llm/events')
    .set('Authorization', `Bearer ${token}`)
}

function workflowRunBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: WORKFLOW_RUN_ID,
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'my-recipe',
    actor_type: 'autonomous',
    actor_id: null,
    usage_team_id: WORKFLOW_TEAM_ID,
    ...overrides,
  }
}

function mockWorkflowBindingThenIngest(
  binding: Record<string, unknown> = workflowRunBinding(),
  ingestRowCount = 1
) {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [binding], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: ingestRowCount })
}

describe('POST /api/v1/internal/usage/llm/events', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 })
  })

  it('rejects unauthenticated requests with 401', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app)
      .post('/api/v1/internal/usage/llm/events')
      .send({ events: [VALID_EVENT] })
      .expect(401)
  })

  it('rejects requests with a non-mcp-host bearer token', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app)
      .post('/api/v1/internal/usage/llm/events')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .send({ events: [VALID_EVENT] })
      .expect(401)
  })

  it('rejects requests missing the events array', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await authedPost(app).send({}).expect(400)
  })

  it('rejects batches over 1000 events', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    const events = Array.from({ length: 1001 }, (_, i) => ({
      ...VALID_EVENT,
      request_id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    }))
    const res = await authedPost(app).send({ events }).expect(400)
    expect(res.body.error).toBe('batch_too_large')
  })

  it('returns the ingest counts on the happy path', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 })
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await authedPost(app)
      .send({ events: [VALID_EVENT] })
      .expect(200)
    expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
  })

  it('counts ON CONFLICT skips as duplicates', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await authedPost(app)
      .send({ events: [VALID_EVENT] })
      .expect(200)
    expect(res.body).toEqual({ accepted: 0, duplicates: 1, rejected: 0 })
  })

  it('reports schema-rejected events separately', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await authedPost(app)
      .send({ events: [{ bogus: true }] })
      .expect(200)
    expect(res.body).toEqual({ accepted: 0, duplicates: 0, rejected: 1 })
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  describe('claim-to-body binding', () => {
    it('rejects sentinel-token events tagged with a recipe_name', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = { ...VALID_EVENT, recipe_name: 'victim-recipe' }
      const res = await authedPost(app, { kind: 'sentinel' })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.reason).toBe('sentinel_token_with_recipe_name')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects sentinel-token events with source_kind=workflow', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = { ...VALID_EVENT, source_kind: 'workflow' }
      const res = await authedPost(app, { kind: 'sentinel' })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.reason).toBe('sentinel_token_with_workflow_source')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects recipe-token events whose recipe_name does not match the JWT', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'someone-elses-recipe',
        source_kind: 'workflow',
        task_id: WORKFLOW_TASK_ID,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.reason).toBe('recipe_token_recipe_name_mismatch')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects recipe-token events with non-workflow source_kind', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = { ...VALID_EVENT, recipe_name: 'my-recipe', source_kind: 'channel' }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.reason).toBe('recipe_token_non_workflow_source')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects recipe-token workflow events without canonical run-backed task_id', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: 'my-recipe:2026-05-09T00:00:00.000Z',
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.reason).toBe('recipe_token_missing_canonical_task_id')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects recipe-token workflow events without llm_secret_name', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: WORKFLOW_TASK_ID,
        llm_secret_name: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.reason).toBe('recipe_token_missing_llm_secret_name')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects tokens whose recipeNamespace is neither hosts nor sandbox', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'random-ns',
        name: 'whatever',
      })
        .send({ events: [VALID_EVENT] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.reason).toBe('unrecognized_token_binding')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects the whole batch when one event violates binding (no partial ingest)', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const goodEvent = { ...VALID_EVENT }
      const forgedEvent = {
        ...VALID_EVENT,
        request_id: '22222222-2222-4222-8222-222222222222',
        recipe_name: 'victim-recipe',
      }
      const res = await authedPost(app, { kind: 'sentinel' })
        .send({ events: [goodEvent, forgedEvent] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.index).toBe(1)
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects sentinel-token events whose host_ref does not match hostRefs[0]', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = { ...VALID_EVENT, host_ref: 'chatllm' } // sentinel token issued for "trader"
      const res = await authedPost(app, { kind: 'sentinel', hostName: 'trader' })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.reason).toBe('sentinel_token_host_ref_mismatch')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects recipe-token events whose host_ref claims a 1st-party host', async () => {
      // A WRC pod with a valid recipe token tries to forge events tagged
      // with host_ref="chatllm" — must be rejected even though
      // recipe_name and source_kind are correct.
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        task_id: WORKFLOW_TASK_ID,
        host_ref: 'chatllm',
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('claim_binding_mismatch')
      expect(res.body.reason).toBe('recipe_token_host_ref_mismatch')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('accepts recipe-token events whose host_ref equals namespace/name', async () => {
      // The shape mcp-host's WorkflowService emits:
      // host_ref = `${claims.recipeNamespace}/${claims.recipeName}`.
      mockWorkflowBindingThenIngest()
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: WORKFLOW_TASK_ID,
        user_id: null,
        sender: null,
        channel_type: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(200)
      expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
    })

    it('rejects recipe-token workflow events without a matching workflow run', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: WORKFLOW_TASK_ID,
        user_id: null,
        sender: null,
        channel_type: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('workflow_usage_binding_mismatch')
      expect(res.body.reason).toBe('workflow_run_not_found')
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('rejects recipe-token workflow events whose run belongs to another recipe', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [workflowRunBinding({ recipe_name: 'other-recipe' })],
        rowCount: 1,
      })
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: WORKFLOW_TASK_ID,
        user_id: null,
        sender: null,
        channel_type: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('workflow_usage_binding_mismatch')
      expect(res.body.reason).toBe('workflow_run_recipe_mismatch')
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('rejects recipe-token workflow events whose team_id does not match the run usage_team_id', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [workflowRunBinding({ usage_team_id: OTHER_WORKFLOW_TEAM_ID })],
        rowCount: 1,
      })
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: WORKFLOW_TASK_ID,
        team_id: WORKFLOW_TEAM_ID,
        user_id: null,
        sender: null,
        channel_type: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('workflow_usage_binding_mismatch')
      expect(res.body.reason).toBe('workflow_run_team_mismatch')
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('accepts recipe-token workflow events for admin-triggered runs using the admin usage bucket', async () => {
      mockWorkflowBindingThenIngest(
        workflowRunBinding({
          actor_type: 'admin',
          actor_id: ADMIN_USER_ID,
          usage_team_id: ADMIN_USAGE_TEAM_ID,
        })
      )
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: WORKFLOW_TASK_ID,
        team_id: ADMIN_USAGE_TEAM_ID,
        user_id: `admin-ui/${ADMIN_USER_ID}`,
        sender: null,
        channel_type: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(200)
      expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
      expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    })

    it('rejects recipe-token workflow events that spoof another admin user bucket', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          workflowRunBinding({
            actor_type: 'admin',
            actor_id: ADMIN_USER_ID,
            usage_team_id: ADMIN_USAGE_TEAM_ID,
          }),
        ],
        rowCount: 1,
      })
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        host_ref: 'sandbox-recipes/my-recipe',
        task_id: WORKFLOW_TASK_ID,
        team_id: ADMIN_USAGE_TEAM_ID,
        user_id: `admin-ui/${OTHER_ADMIN_USER_ID}`,
        sender: null,
        channel_type: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(403)
      expect(res.body.error).toBe('workflow_usage_binding_mismatch')
      expect(res.body.reason).toBe('workflow_run_user_mismatch')
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('routes events with non-string host_ref to schema-rejection (not binding-rejection)', async () => {
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = { ...VALID_EVENT, host_ref: 42 as unknown as string }
      const res = await authedPost(app, { kind: 'sentinel', hostName: 'trader' })
        .send({ events: [event] })
        .expect(200)
      expect(res.body).toEqual({ accepted: 0, duplicates: 0, rejected: 1 })
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('accepts sentinel-token events whose trimmed host_ref matches hostRefs[0]', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 })
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = { ...VALID_EVENT, host_ref: '  trader  ' } // whitespace tolerated by trim
      const res = await authedPost(app, { kind: 'sentinel', hostName: 'trader' })
        .send({ events: [event] })
        .expect(200)
      expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
    })

    it('accepts a recipe-token batch where every event matches the JWT recipeName', async () => {
      mockWorkflowBindingThenIngest()
      const app = createApp(new MockGateway('mcp-server') as never)
      const event = {
        ...VALID_EVENT,
        recipe_name: 'my-recipe',
        source_kind: 'workflow',
        task_id: WORKFLOW_TASK_ID,
        // Recipe events also need host_ref to match hostRefs[0]
        // (`${recipeNamespace}/${recipeName}`) — see new host_ref binding rule.
        host_ref: 'sandbox-recipes/my-recipe',
        user_id: null,
        sender: null,
        channel_type: null,
      }
      const res = await authedPost(app, {
        kind: 'recipe',
        namespace: 'sandbox-recipes',
        name: 'my-recipe',
      })
        .send({ events: [event] })
        .expect(200)
      expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
    })
  })
})
