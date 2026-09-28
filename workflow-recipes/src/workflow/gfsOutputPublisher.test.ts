import { describe, expect, it, vi } from 'vitest'
import { GfsPublishCancelledError, publishWorkflowOutputsToGfs } from './gfsOutputPublisher'

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

    async function publishWith(
      responses: Response[],
      opts: { target?: string; cancelDuringSleep?: boolean } = {}
    ) {
      const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        const next = responses.shift()
        if (!next) throw new Error('unexpected extra fetch')
        return next
      })
      let cancelled = false
      const sleepFn = vi.fn(async (_ms: number) => {
        if (opts.cancelDuringSleep) cancelled = true
      })
      const published = publishWorkflowOutputsToGfs(
        { gfs: { publishTargets: [{ drive: 'main', target: opts.target ?? PARENT_ID }] } },
        { workflowName: 'daily-report' },
        { summarize: { ok: true } },
        {
          env: { ...env, CLERUM_GFSC_BASE_URL: 'http://reader.local' },
          fetchFn: fetchFn as unknown as typeof fetch,
          readFileFn: vi.fn(async () => 'runtime-access') as never,
          sleepFn,
          isCancelled: () => cancelled,
        }
      )
      return { published, fetchFn, sleepFn }
    }

    it('R1-L3: stops the wait and the retry within one second of a cancel', async () => {
      const { published, fetchFn, sleepFn } = await publishWith([agentDenied('7')], {
        cancelDuringSleep: true,
      })

      await expect(published).rejects.toBeInstanceOf(GfsPublishCancelledError)
      // Witness: the wait was entered. The cancel landed in its first second,
      // and the remaining six seconds were not waited.
      expect(sleepFn.mock.calls).toEqual([[1_000]])
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('R1-L3: does not wait at all when the run is already cancelled at the 429', async () => {
      const denied = agentDenied('7')
      const cancel = vi.spyOn(denied.body!, 'cancel')
      const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => denied)
      const sleepFn = vi.fn(async (_ms: number) => {})
      const published = publishWorkflowOutputsToGfs(
        { gfs: { publishTargets: [{ drive: 'main', target: PARENT_ID }] } },
        { workflowName: 'daily-report' },
        { summarize: { ok: true } },
        {
          env: { ...env, CLERUM_GFSC_BASE_URL: 'http://reader.local' },
          fetchFn: fetchFn as unknown as typeof fetch,
          readFileFn: vi.fn(async () => 'runtime-access') as never,
          sleepFn,
          isCancelled: () => true,
        }
      )

      await expect(published).rejects.toBeInstanceOf(GfsPublishCancelledError)
      // Witness: the 429 was received and its body released.
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(sleepFn).not.toHaveBeenCalled()
    })

    it('N5: retries a gfs:// resolve once on an agent_reads 429, then publishes', async () => {
      const { published, fetchFn, sleepFn } = await publishWith(
        [
          agentDenied('2', 'agent_reads'),
          jsonResponse({ data: { resourceId: PARENT_ID } }),
          jsonResponse({ data: { resourceId: 'created-file' } }, 201),
        ],
        { target: 'gfs://main/some-folder' }
      )

      await expect(published).resolves.toBeUndefined()
      expect(sleepFn.mock.calls).toEqual([[1_000], [1_000]])
      expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
        'http://reader.local/v1/resolve?uri=gfs%3A%2F%2Fmain%2Fsome-folder',
        'http://reader.local/v1/resolve?uri=gfs%3A%2F%2Fmain%2Fsome-folder',
        `http://writer.local/v1/resources/${PARENT_ID}/children`,
      ])
    })

    it('N5: fails the resolve with its status after a second agent_reads 429', async () => {
      const { published, fetchFn } = await publishWith(
        [agentDenied('2', 'agent_reads'), agentDenied('2', 'agent_reads')],
        { target: 'gfs://main/some-folder' }
      )

      await expect(published).rejects.toThrow(/GFS output target resolve failed: HTTP 429/)
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('N5: stops without the resolve retry when the run is cancelled during the wait', async () => {
      const { published, fetchFn, sleepFn } = await publishWith([agentDenied('2', 'agent_reads')], {
        target: 'gfs://main/some-folder',
        cancelDuringSleep: true,
      })

      await expect(published).rejects.toBeInstanceOf(GfsPublishCancelledError)
      // Witness: the resolve's wait was entered; the cancel ended it after one second.
      expect(sleepFn.mock.calls).toEqual([[1_000]])
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('waits Retry-After and publishes on the one retry, sending the same request twice', async () => {
      const { published, fetchFn, sleepFn } = await publishWith([
        agentDenied('7'),
        jsonResponse({ data: { resourceId: 'created-file' } }, 201),
      ])

      await expect(published).resolves.toBeUndefined()
      // The 7 s Retry-After is waited in full, one second at a time.
      expect(sleepFn.mock.calls).toEqual(Array.from({ length: 7 }, () => [1_000]))
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
      expect(sleepFn.mock.calls).toEqual([[1_000], [1_000], [1_000]])
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
