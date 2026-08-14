import { describe, expect, it } from 'vitest'
import {
  LOCAL_TEAMS_ENDPOINT_ORIGIN,
  TEAMS_APP_NAME_MAX_LENGTH,
  buildTeamsAppCreateCommand,
  buildTeamsSupportsFilesCommand,
  canGenerateTeamsCommand,
  teamsAppNameError,
  teamsPlaceholderEndpoint,
} from '../teamsSetup'

describe('canGenerateTeamsCommand', () => {
  it('accepts an absolute https URL', () => {
    expect(canGenerateTeamsCommand('https://webhook.dev.example.com/webhooks/teams/x')).toBe(true)
  })

  it('rejects an http origin, which Microsoft cannot use as a messaging endpoint', () => {
    // Mirrored from the Slack helper, which accepts http. Teams requires a
    // publicly reachable HTTPS endpoint, so an http origin has to render the
    // invalid-origin warning rather than a command that registers a dead bot.
    expect(canGenerateTeamsCommand('http://webhook.dev.example.com/webhooks/teams/x')).toBe(false)
  })

  it('rejects a bare path, which is what a non-app deployment produces', () => {
    expect(canGenerateTeamsCommand('/webhooks/teams/x')).toBe(false)
  })

  it('rejects null', () => {
    expect(canGenerateTeamsCommand(null)).toBe(false)
  })
})

describe('teamsPlaceholderEndpoint', () => {
  it('prefixes a bare path with the marker origin', () => {
    expect(teamsPlaceholderEndpoint('/webhooks/teams/x')).toBe(
      `${LOCAL_TEAMS_ENDPOINT_ORIGIN}/webhooks/teams/x`
    )
  })

  it('drops the origin of a rejected http URL instead of concatenating onto it', () => {
    // Now that canGenerateTeamsCommand rejects http, this branch also receives
    // ABSOLUTE urls. Concatenation would render
    // https://<public-webhook-origin>http://webhook.example.com/webhooks/teams/x.
    expect(teamsPlaceholderEndpoint('http://webhook.example.com/webhooks/teams/x')).toBe(
      `${LOCAL_TEAMS_ENDPOINT_ORIGIN}/webhooks/teams/x`
    )
  })
})

describe('teamsAppNameError', () => {
  it('accepts a free-form display name with spaces and capitals', () => {
    // The CRD declares appName with no pattern and control-api checks only
    // emptiness and length, so this is a legitimate stored value.
    expect(teamsAppNameError('My Bot')).toBeNull()
  })

  it('accepts a kebab-cased name too', () => {
    expect(teamsAppNameError('evenfire-bot')).toBeNull()
  })

  it('rejects an empty name', () => {
    expect(teamsAppNameError('')).toBe('Teams bot name is required.')
    expect(teamsAppNameError('   ')).toBe('Teams bot name is required.')
  })

  it('accepts a name of exactly the server limit', () => {
    expect(teamsAppNameError('a'.repeat(TEAMS_APP_NAME_MAX_LENGTH))).toBeNull()
  })

  it('rejects a name past the server limit', () => {
    expect(teamsAppNameError('a'.repeat(TEAMS_APP_NAME_MAX_LENGTH + 1))).toBe(
      'Teams bot name must be 80 characters or fewer.'
    )
  })
})

describe('buildTeamsAppCreateCommand', () => {
  it('renders the command with the bot name and endpoint', () => {
    const cmd = buildTeamsAppCreateCommand({
      botName: 'evenfire-bot',
      endpoint: 'https://webhook.dev.example.com/webhooks/teams/x',
    })
    expect(cmd).toContain('--name "evenfire-bot"')
    expect(cmd).toContain('--endpoint "https://webhook.dev.example.com/webhooks/teams/x"')
    expect(cmd).toContain('--env .env')
  })

  it('quotes a display name with spaces, so it survives as one argument', () => {
    const cmd = buildTeamsAppCreateCommand({
      botName: 'My Bot',
      endpoint: 'https://webhook.dev.example.com/webhooks/teams/x',
    })
    expect(cmd).toContain('--name "My Bot"')
  })
})

describe('buildTeamsAppCreateCommand sign-in audience', () => {
  it('pins the single-tenant audience, because channel-reader uses a tenant-scoped token URL', () => {
    const cmd = buildTeamsAppCreateCommand({
      botName: 'Evenfire Bot',
      endpoint: 'https://webhook.example.com/webhooks/teams/x',
    })
    expect(cmd).toContain('--sign-in-audience myOrg')
  })
})

describe('buildTeamsSupportsFilesCommand', () => {
  it('includes --yes, without which the update silently does nothing', () => {
    expect(buildTeamsSupportsFilesCommand('abc-123')).toBe(
      "teams app manifest update abc-123 --set-json 'bots[0].supportsFiles=true' --yes"
    )
  })

  it('falls back to a placeholder app id', () => {
    // Never an angle-bracket placeholder: `<appId>` is a redirect in sh and zsh,
    // so pasting the command unedited fails with "no such file or directory".
    const cmd = buildTeamsSupportsFilesCommand()
    expect(cmd).toContain('YOUR_CLIENT_ID')
    expect(cmd).not.toContain('<')
    expect(cmd).not.toContain('>')
  })
})
