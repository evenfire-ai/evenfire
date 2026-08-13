import { describe, expect, it } from 'vitest'
import { buildTeamsAppCreateCommand, canGenerateTeamsCommand } from '../teamsSetup'

describe('canGenerateTeamsCommand', () => {
  it('accepts an absolute https URL', () => {
    expect(canGenerateTeamsCommand('https://webhook.dev.example.com/webhooks/teams/x')).toBe(true)
  })

  it('rejects a bare path, which is what a non-app deployment produces', () => {
    expect(canGenerateTeamsCommand('/webhooks/teams/x')).toBe(false)
  })

  it('rejects null', () => {
    expect(canGenerateTeamsCommand(null)).toBe(false)
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
})
