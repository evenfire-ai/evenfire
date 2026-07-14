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
})
