import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// The control-ui host-detail view consumes the Host's lifecycle projection
// (status.lifecycle.effectiveMode + reason) and the StatelessEnableRejected
// condition to render the stateless×CommunicationChannel hard-rejection banner
// (issue #791, plan Addendum 6 item 4). This test proves the admin read surface
// serves that status subtree UNFILTERED — it is a raw CRD passthrough, so no
// control-api change is required for the operator-visibility feature.
//
// vi.mock specifiers resolve RELATIVE TO THIS TEST FILE (routes/admin/__tests__/).
// The router imports the same modules via its own relative paths; Vitest matches
// mocks by canonical path, so both resolve to the same module instance.
vi.mock('../../../services/directory/index.js', () => ({
  listUsers: vi.fn().mockResolvedValue([]),
  listAllTeams: vi.fn().mockResolvedValue([]),
  listUsersByAgent: vi.fn().mockResolvedValue([]),
  listTeamsByAgent: vi.fn().mockResolvedValue([]),
}))

vi.mock('../hostSecrets.js', () => ({
  listHostSecrets: vi.fn().mockResolvedValue([]),
}))

// Import AFTER vi.mock so the mocked dependencies wire up.
const { createAdminHostsOverviewRouter } = await import('../hostsOverview.js')

describe('admin hosts read surface — lifecycle status passthrough (issue #791, Addendum 6)', () => {
  function buildApp(gateway: unknown) {
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1', createAdminHostsOverviewRouter(gateway as never))
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET /admin/hosts/:name/detail returns status.lifecycle (effectiveMode + reason) and the StatelessEnableRejected condition unfiltered', async () => {
    const rejectionMessage =
      '2 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle'
    const host = {
      metadata: { name: 'foo', namespace: 'mcp-host', generation: 9 },
      spec: { lifecycle: { stateless: true } },
      status: {
        lifecycle: {
          state: 'active',
          effectiveMode: 'stateful',
          observedGeneration: 9,
          wakeHandledGeneration: 0,
          reason: rejectionMessage,
        },
        conditions: [
          {
            type: 'StatelessEnableRejected',
            status: 'True',
            reason: 'ActiveCommunicationChannels',
            message: rejectionMessage,
          },
        ],
      },
    }
    const gateway = {
      getResource: vi.fn().mockResolvedValue(host),
      listResource: vi.fn().mockResolvedValue([]),
    }
    const app = buildApp(gateway)

    const res = await request(app).get('/api/v1/admin/hosts/foo/detail')

    expect(res.status).toBe(200)
    // Raw CRD passthrough: the Host object is returned exactly as read from the
    // cluster — no DTO projection strips the lifecycle status or conditions.
    expect(res.body.host).toEqual(host)
    // The specific fields the operator banner reads survive the read surface.
    expect(res.body.host.status.lifecycle.effectiveMode).toBe('stateful')
    expect(res.body.host.status.lifecycle.reason).toBe(rejectionMessage)
    expect(res.body.host.status.conditions).toEqual([
      {
        type: 'StatelessEnableRejected',
        status: 'True',
        reason: 'ActiveCommunicationChannels',
        message: rejectionMessage,
      },
    ])
    expect(gateway.getResource).toHaveBeenCalledWith('hosts', 'foo', expect.any(String))
  })

  it('GET /admin/hosts/:name/detail returns a StatelessSuspensionBlocked condition unfiltered', async () => {
    const host = {
      metadata: { name: 'foo', generation: 7 },
      spec: { lifecycle: { stateless: true } },
      status: {
        lifecycle: {
          state: 'active',
          effectiveMode: 'stateless',
          observedGeneration: 7,
          wakeHandledGeneration: 0,
          reason: 'Waiting for the CommunicationChannel cache to synchronize.',
        },
        conditions: [
          {
            type: 'StatelessSuspensionBlocked',
            status: 'True',
            message: 'Communication channel status is reconciling.',
          },
        ],
      },
    }
    const gateway = {
      getResource: vi.fn().mockResolvedValue(host),
      listResource: vi.fn().mockResolvedValue([]),
    }
    const app = buildApp(gateway)

    const res = await request(app).get('/api/v1/admin/hosts/foo/detail')

    expect(res.status).toBe(200)
    expect(res.body.host.status.lifecycle.effectiveMode).toBe('stateless')
    expect(res.body.host.status.conditions).toEqual([
      {
        type: 'StatelessSuspensionBlocked',
        status: 'True',
        message: 'Communication channel status is reconciling.',
      },
    ])
  })
})
