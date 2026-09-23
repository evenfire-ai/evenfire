import { describe, expect, it, vi } from 'vitest'
import { publishWorkflowOutputsToGfs } from './gfsOutputPublisher'

const PARENT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('publishWorkflowOutputsToGfs', () => {
  it('creates a deterministic workflow output file under a resource-id target', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ data: { resourceId: 'created-file' } }, 201)
    }) as unknown as typeof fetch

    await publishWorkflowOutputsToGfs(
      { gfs: { publishTargets: [{ drive: 'main', target: PARENT_ID }] } },
      { workflowName: 'daily-report' },
      { summarize: { ok: true } },
      {
        env: {
          GFS_ACCESS_FILE: '/var/run/workflow/gfs',
          CLERUM_WORKFLOW_RUN_ID: 'run-123',
          CLERUM_GFSC_WRITER_BASE_URL: 'http://writer.local',
        },
        fetchFn,
        readFileFn: vi.fn(async () => 'runtime-access') as never,
      }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`http://writer.local/v1/resources/${PARENT_ID}/children`)
    expect(calls[0].init?.method).toBe('POST')
    const body = JSON.parse(String(calls[0].init?.body)) as {
      name: string
      kind: string
      content: string
    }
    expect(body).toMatchObject({ name: 'workflow-output-run-123.json', kind: 'file' })
    expect(JSON.parse(body.content)).toEqual({
      workflowName: 'daily-report',
      workflowRunId: 'run-123',
      outputs: { summarize: { ok: true } },
    })
  })

  it('resolves gfs uri publish targets before creating the output file', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { resourceId: PARENT_ID } }))
      .mockResolvedValueOnce(jsonResponse({ data: { resourceId: 'created-file' } }, 201))

    await publishWorkflowOutputsToGfs(
      { gfs: { publishTargets: [{ drive: 'main', target: 'gfs://main/some-folder' }] } },
      { workflowName: 'daily-report' },
      { summarize: 'done' },
      {
        env: {
          GFS_ACCESS_FILE: '/var/run/workflow/gfs',
          CLERUM_GFSC_BASE_URL: 'http://reader.local',
          CLERUM_GFSC_WRITER_BASE_URL: 'http://writer.local',
        },
        fetchFn: fetchFn as unknown as typeof fetch,
        readFileFn: vi.fn(async () => 'runtime-access') as never,
      }
    )

    expect(String(fetchFn.mock.calls[0][0])).toBe(
      'http://reader.local/v1/resolve?uri=gfs%3A%2F%2Fmain%2Fsome-folder'
    )
    expect(String(fetchFn.mock.calls[1][0])).toBe(
      `http://writer.local/v1/resources/${PARENT_ID}/children`
    )
  })

  it('fails closed when a recipe declares publish targets without the mounted access file', async () => {
    await expect(
      publishWorkflowOutputsToGfs(
        { gfs: { publishTargets: [{ drive: 'main', target: PARENT_ID }] } },
        { workflowName: 'daily-report' },
        {},
        { env: {}, fetchFn: vi.fn() as unknown as typeof fetch }
      )
    ).rejects.toThrow(/GFS_ACCESS_FILE is required/)
  })

  it('fails closed when GFSC denies the write', async () => {
    await expect(
      publishWorkflowOutputsToGfs(
        { gfs: { publishTargets: [{ drive: 'main', target: PARENT_ID }] } },
        { workflowName: 'daily-report' },
        {},
        {
          env: { GFS_ACCESS_FILE: '/var/run/workflow/gfs' },
          fetchFn: vi.fn(
            async () => new Response('denied', { status: 403 })
          ) as unknown as typeof fetch,
          readFileFn: vi.fn(async () => 'runtime-access') as never,
        }
      )
    ).rejects.toThrow(/HTTP 403/)
  })

  describe('a 429 from the gfsc agent limiter', () => {
    const env = {
      GFS_ACCESS_FILE: '/var/run/workflow/gfs',
      CLERUM_WORKFLOW_RUN_ID: 'run-123',
      CLERUM_GFSC_WRITER_BASE_URL: 'http://writer.local',
    }

    function agentDenied(retryAfter: string, scope = 'agent_writes'): Response {
      return new Response(JSON.stringify({ error: { code: 'rate_limited', limit: scope } }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': retryAfter,
          'x-gfs-ratelimit-scope': scope,
        },
      })
    }

    async function publishWith(responses: Response[]) {
      const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        const next = responses.shift()
        if (!next) throw new Error('unexpected extra fetch')
        return next
      })
      const sleepFn = vi.fn(async (_ms: number) => {})
      const published = publishWorkflowOutputsToGfs(
        { gfs: { publishTargets: [{ drive: 'main', target: PARENT_ID }] } },
        { workflowName: 'daily-report' },
        { summarize: { ok: true } },
        {
          env,
          fetchFn: fetchFn as unknown as typeof fetch,
          readFileFn: vi.fn(async () => 'runtime-access') as never,
          sleepFn,
        }
      )
      return { published, fetchFn, sleepFn }
    }

    it('waits Retry-After and publishes on the one retry, sending the same request twice', async () => {
      const { published, fetchFn, sleepFn } = await publishWith([
        agentDenied('7'),
        jsonResponse({ data: { resourceId: 'created-file' } }, 201),
      ])

      await expect(published).resolves.toBeUndefined()
      expect(sleepFn.mock.calls).toEqual([[7_000]])
      expect(fetchFn).toHaveBeenCalledTimes(2)
      const [first, second] = fetchFn.mock.calls
      expect(String(second![0])).toBe(String(first![0]))
      expect(String(first![0])).toBe(`http://writer.local/v1/resources/${PARENT_ID}/children`)
      expect(second![1]?.method).toBe('POST')
      expect(second![1]?.body).toBe(first![1]?.body)
      expect(second![1]?.headers).toEqual(first![1]?.headers)
    })

    it('cancels the denied response body before the retry, so its connection is released', async () => {
      const denied = agentDenied('7')
      const cancel = vi.spyOn(denied.body!, 'cancel')
      const { published, fetchFn } = await publishWith([
        denied,
        jsonResponse({ data: { resourceId: 'created-file' } }, 201),
      ])

      await expect(published).resolves.toBeUndefined()
      // Witness: the retry happened, so the path that must cancel was taken.
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(fetchFn.mock.invocationCallOrder[1]!)
    })

    it('fails with the status after a second 429, making exactly two requests', async () => {
      const { published, fetchFn, sleepFn } = await publishWith([
        agentDenied('3'),
        agentDenied('3'),
      ])

      await expect(published).rejects.toThrow(/GFS output publish failed: HTTP 429/)
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(sleepFn.mock.calls).toEqual([[3_000]])
    })

    it('does not retry an upload-quota 429', async () => {
      const { published, fetchFn, sleepFn } = await publishWith([
        agentDenied('3', 'active_sessions_subject'),
      ])

      await expect(published).rejects.toThrow(/GFS output publish failed: HTTP 429/)
      // Witness: the one request was made and its 429 surfaced.
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(sleepFn).not.toHaveBeenCalled()
    })

    it.each(['61', '0', '', '1.5', '3600'])(
      'does not retry when Retry-After is %j (outside 1..60 s)',
      async retryAfter => {
        const { published, fetchFn, sleepFn } = await publishWith([agentDenied(retryAfter)])

        await expect(published).rejects.toThrow(/GFS output publish failed: HTTP 429/)
        expect(fetchFn).toHaveBeenCalledTimes(1)
        expect(sleepFn).not.toHaveBeenCalled()
      }
    )
  })
})
