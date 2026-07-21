import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockQuery = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  withTransaction: vi.fn(),
}))

vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.header('x-test-auth') !== 'operator') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  },
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: vi.fn(),
}))

const RESOURCE_ID = '11111111-1111-4111-8111-111111111111'

async function buildApp() {
  const [{ registerGfsGrantRoutes }, { registerGfsShareRoutes }] = await Promise.all([
    import('../src/routes/gfs/grants.js'),
    import('../src/routes/gfs/shares.js'),
  ])
  const router = express.Router()
  registerGfsGrantRoutes(router)
  registerGfsShareRoutes(router)
  const app = express()
  app.use(express.json())
  app.use(router)
  return app
}

describe('Control UI GFS permission read routes', () => {
  beforeEach(() => mockQuery.mockReset())

  it.each(['/gfs/grants', '/gfs/shares'])('requires Control UI auth for GET %s', async path => {
    const response = await request(await buildApp())
      .get(path)
      .query({
        drive: 'main',
        resourceId: RESOURCE_ID,
      })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['/gfs/grants', {}, 'drive_required'],
    ['/gfs/shares', { drive: 'main' }, 'resource_invalid'],
    ['/gfs/grants', { drive: 'main', resourceId: 'not-a-uuid' }, 'resource_invalid'],
  ])('rejects an incomplete or invalid filter on %s', async (path, query, error) => {
    const response = await request(await buildApp())
      .get(path)
      .set('x-test-auth', 'operator')
      .query(query)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('lists only grants for the requested drive and resource', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          drive: 'main',
          resource_id: RESOURCE_ID,
          subject_type: 'host',
          subject_id: '1st:mcp-host/standalone',
          permissions: ['read', 'write'],
          inherit: true,
        },
      ],
    })

    const response = await request(await buildApp())
      .get('/gfs/grants')
      .set('x-test-auth', 'operator')
      .query({ drive: 'main', resourceId: RESOURCE_ID })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          drive: 'main',
          resourceId: RESOURCE_ID,
          subject: { type: 'host', id: '1st:mcp-host/standalone' },
          permissions: ['read', 'write'],
          inherit: true,
        },
      ],
    })
    expect(String(mockQuery.mock.calls[0]?.[0])).toContain(
      'WHERE drive = $1 AND resource_id = $2::uuid'
    )
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(['main', RESOURCE_ID])
  })

  it('lists only shares for the requested drive and resource', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          drive: 'archive',
          resource_id: RESOURCE_ID,
          subject_type: 'operator',
          subject_id: '',
          permissions: ['read'],
          include_descendants: false,
        },
      ],
    })

    const response = await request(await buildApp())
      .get('/gfs/shares')
      .set('x-test-auth', 'operator')
      .query({ drive: 'archive', resourceId: RESOURCE_ID })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          drive: 'archive',
          resourceId: RESOURCE_ID,
          subject: { type: 'operator' },
          permissions: ['read'],
          includeDescendants: false,
        },
      ],
    })
    expect(String(mockQuery.mock.calls[0]?.[0])).toContain(
      'WHERE drive = $1 AND resource_id = $2::uuid'
    )
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(['archive', RESOURCE_ID])
  })
})
