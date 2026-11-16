import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TeamsAdapter,
  isAllowedTeamsFileUploadUrl,
  isAllowedTeamsServiceUrl,
} from '../../src/channels/teams.js'

vi.mock('../../src/config.js', () => ({
  config: {
    attachmentMaxBytes: 1024 * 1024,
    attachmentMaxCount: 4,
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TeamsAdapter serviceUrl validation', () => {
  it('allows Microsoft Bot Framework service hosts', () => {
    expect(isAllowedTeamsServiceUrl('https://smba.trafficmanager.net/amer/')).toBe(true)
    expect(isAllowedTeamsServiceUrl('https://api.botframework.com')).toBe(true)
  })

  it('rejects non-Microsoft or non-HTTPS service URLs', () => {
    expect(isAllowedTeamsServiceUrl('https://attacker.example.com')).toBe(false)
    expect(isAllowedTeamsServiceUrl('http://smba.trafficmanager.net/amer/')).toBe(false)
  })
})

describe('TeamsAdapter workflow result files', () => {
  it('allows only Microsoft file upload hosts', () => {
    expect(isAllowedTeamsFileUploadUrl('https://tenant.sharepoint.com/upload/session')).toBe(true)
    expect(isAllowedTeamsFileUploadUrl('https://files.1drv.com/upload/session')).toBe(true)
    expect(isAllowedTeamsFileUploadUrl('https://attacker.example.com/upload')).toBe(false)
    expect(isAllowedTeamsFileUploadUrl('http://tenant.sharepoint.com/upload')).toBe(false)
  })

  it('sends a file consent card bound to the workflow run', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'consent-card-1' }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })
    adapter.rememberConversation('conversation-1', 'https://smba.trafficmanager.net/amer/')

    await adapter.sendFileConsent(
      'conversation-1',
      {
        id: 'artifact-1',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: 'base64',
        dataBase64: Buffer.from('pdf bytes').toString('base64'),
        filename: 'result.pdf',
      },
      {
        workflowRunId: '11111111-2222-3333-4444-555555555555',
        artifactName: 'result.pdf',
      }
    )

    const activityRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
    const activity = JSON.parse(String(activityRequest.body)) as Record<string, unknown>
    expect(activity).toMatchObject({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.card.file.consent',
          name: 'result.pdf',
          content: {
            sizeInBytes: 9,
            acceptContext: {
              workflowRunId: '11111111-2222-3333-4444-555555555555',
              artifactName: 'result.pdf',
            },
          },
        },
      ],
    })
  })

  it('uploads an accepted file and sends the Teams file info card', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-card-1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })
    adapter.rememberConversation('conversation-1', 'https://smba.trafficmanager.net/amer/')

    await adapter.uploadConsentedFile(
      'conversation-1',
      {
        id: 'artifact-1',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: 'base64',
        dataBase64: Buffer.from('pdf bytes').toString('base64'),
        filename: 'result.pdf',
      },
      {
        contentUrl: 'https://tenant.sharepoint.com/result.pdf',
        uploadUrl: 'https://tenant.sharepoint.com/upload/session',
        uniqueId: 'file-1',
        name: 'result.pdf',
        fileType: 'pdf',
      }
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://tenant.sharepoint.com/upload/session')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' })
    const activityRequest = fetchMock.mock.calls[2]?.[1] as RequestInit
    const activity = JSON.parse(String(activityRequest.body)) as Record<string, unknown>
    expect(activity).toMatchObject({
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.card.file.info',
          contentUrl: 'https://tenant.sharepoint.com/result.pdf',
          name: 'result.pdf',
          content: { uniqueId: 'file-1', fileType: 'pdf' },
        },
      ],
    })
  })
})

describe('TeamsAdapter text format', () => {
  async function connectedAdapter() {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
      )
      .mockImplementation(
        async () => new Response(JSON.stringify({ id: 'activity-1' }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })
    adapter.rememberConversation('conversation-1', 'https://smba.trafficmanager.net/amer/')
    return { adapter, fetchMock }
  }

  function activityBodies(fetchMock: ReturnType<typeof vi.fn>, method: string) {
    // Activity requests only: the token request goes to the login host.
    return fetchMock.mock.calls
      .filter(call => String(call[0]).includes('/v3/conversations/'))
      .map(call => call[1] as RequestInit)
      .filter(init => init.method === method)
      .map(init => JSON.parse(String(init.body)) as Record<string, unknown>)
  }

  const TEXT = 'Delete these files permanently:\n- upload: "<b>a_b</b>.txt"'

  it('TA1 sends a text activity as plain text only when asked', async () => {
    const { adapter, fetchMock } = await connectedAdapter()
    await adapter.sendMessage('conversation-1', TEXT, undefined, undefined, {
      teamsTextFormat: 'plain',
    })
    await adapter.sendMessage('conversation-1', TEXT)

    const bodies = activityBodies(fetchMock, 'POST')
    // Witness: both activities were posted with the same text.
    expect(bodies.map(body => body.text)).toEqual([TEXT, TEXT])
    expect(bodies[0]).toMatchObject({ type: 'message', textFormat: 'plain' })
    expect(bodies[0]).not.toHaveProperty('attachments')
    expect(bodies[1]).not.toHaveProperty('textFormat')
  })

  it('TA2 edits a text activity as plain text only when asked', async () => {
    const { adapter, fetchMock } = await connectedAdapter()
    await adapter.editMessage('conversation-1', 'activity-1', TEXT, { teamsTextFormat: 'plain' })
    await adapter.editMessage('conversation-1', 'activity-1', TEXT)

    const bodies = activityBodies(fetchMock, 'PUT')
    // Witness: both edits were sent with the same text.
    expect(bodies.map(body => body.text)).toEqual([TEXT, TEXT])
    expect(bodies[0]).toEqual({ type: 'message', text: TEXT, attachments: [], textFormat: 'plain' })
    expect(bodies[1]).toEqual({ type: 'message', text: TEXT, attachments: [] })
  })

  it('TA3 keeps a message with actions a card, without a text format', async () => {
    const { adapter, fetchMock } = await connectedAdapter()
    await adapter.sendMessage('conversation-1', TEXT, undefined, undefined, {
      teamsActions: [{ title: 'Approve', value: 'tool:a:abc' }],
      teamsTextFormat: 'plain',
    })

    const bodies = activityBodies(fetchMock, 'POST')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ type: 'message', summary: TEXT })
    expect(bodies[0]!.attachments).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('textFormat')
    expect(bodies[0]).not.toHaveProperty('text')
  })
})
