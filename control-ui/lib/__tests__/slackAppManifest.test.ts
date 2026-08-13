import { describe, expect, it } from 'vitest'
import { canGenerateSlackAppManifest, slackAppManifest } from '../slackAppManifest'

const URL = 'https://webhook.example.com/webhooks/slack/slack%3AeyJ4IjoxfQ'

/**
 * The emitted `      - <value>` items under a list header. Matching values against the whole
 * document instead lets one entry stand in for another: `app_mentions:read` (a scope) satisfies
 * a search for `app_mention` (the event), and `mpim:read` satisfies `im:read`. Three of the
 * seventeen required values were unpinned that way.
 */
function listItemsUnder(yaml: string, header: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.findIndex(line => line.trim() === header)
  expect(start).toBeGreaterThanOrEqual(0)
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+- (.+)$/.exec(line)
    if (!item) break
    items.push(item[1])
  }
  return items
}

/**
 * The two lines that carry the app name, whole. `toContain('name: Evenfire')` is
 * satisfied by an unquoted scalar, by a suffixed one, and by only one of the two
 * lines being right.
 */
function nameLines(yaml: string): string[] {
  return yaml.split('\n').filter(line => /^\s+(name|display_name):/.test(line))
}

describe('slackAppManifest', () => {
  const yaml = slackAppManifest('Evenfire', URL)

  it('sets BOTH request URLs to the same value', () => {
    const occurrences = yaml.split(URL).length - 1
    expect(occurrences).toBe(2)
    expect(yaml).toContain('event_subscriptions:')
    expect(yaml).toContain('interactivity:')
    // Counting occurrences alone still passes when one URL merely has something appended, so
    // pin the whole line. Events-only setup is the mistake this manifest exists to prevent:
    // Slack blocks the button click client-side and nothing reaches the cluster.
    const requestUrlLines = yaml.split('\n').filter(line => line.trim().startsWith('request_url:'))
    expect(requestUrlLines).toEqual([`    request_url: ${URL}`, `    request_url: ${URL}`])
  })

  it('subscribes to every bot event the reader handles', () => {
    const events = listItemsUnder(yaml, 'bot_events:')
    for (const event of [
      'app_mention',
      'message.channels',
      'message.groups',
      'message.im',
      'message.mpim',
    ]) {
      expect(events).toContain(event)
    }
    expect(events).toHaveLength(5)
  })

  it('requests every scope the platform calls', () => {
    const scopes = listItemsUnder(yaml, 'bot:')
    for (const scope of [
      'app_mentions:read',
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
      'channels:read',
      'groups:read',
      'im:read',
      'mpim:read',
      'chat:write',
      'files:write',
      'users:read',
    ]) {
      expect(scopes).toContain(scope)
    }
    expect(scopes).toHaveLength(12)
  })

  it('disables socket mode, which this platform does not use', () => {
    expect(yaml).toContain('socket_mode_enabled: false')
  })

  it('uses the app name given', () => {
    expect(nameLines(yaml)).toEqual(['  name: "Evenfire"', '    display_name: "Evenfire"'])
  })

  it('quotes an app name that would otherwise break the YAML', () => {
    const quoted = slackAppManifest('Acme: support bot', URL)
    expect(nameLines(quoted)).toEqual([
      '  name: "Acme: support bot"',
      '    display_name: "Acme: support bot"',
    ])
  })

  it('quotes an app name YAML would otherwise read as a boolean or a number', () => {
    // Unquoted, `no` is YAML 1.1 false and `123` is an integer, so Slack receives
    // a manifest whose app name is not a string at all.
    expect(nameLines(slackAppManifest('no', URL))).toEqual([
      '  name: "no"',
      '    display_name: "no"',
    ])
    expect(nameLines(slackAppManifest('123', URL))).toEqual([
      '  name: "123"',
      '    display_name: "123"',
    ])
  })

  it('escapes a newline in the app name instead of emitting a second line', () => {
    // A raw newline inside a quoted scalar would split the value across lines and
    // make the rest of the manifest unparseable.
    expect(nameLines(slackAppManifest('Acme\nBot', URL))).toEqual([
      '  name: "Acme\\nBot"',
      '    display_name: "Acme\\nBot"',
    ])
  })
})

describe('slackAppManifest — direct messages', () => {
  const yaml = slackAppManifest('Evenfire', URL)

  // Slack defaults messages_tab_enabled to false, and an app installed from a
  // manifest that says nothing about app_home has DMs switched off: the member
  // sees "Sending messages to this app has been turned off." That breaks the
  // documented enrolment path, which tells people to send `verify 123456` as a
  // DM, and it contradicts this same manifest asking for im:history and im:read.
  it('enables the messages tab so the app can be DMed', () => {
    expect(yaml).toContain('app_home:')
    expect(yaml).toMatch(/messages_tab_enabled:\s*true/)
  })

  it('does not make the messages tab read-only', () => {
    // Read-only leaves the tab visible but still refuses the member's message,
    // which looks identical to the bug it is meant to fix.
    expect(yaml).toMatch(/messages_tab_read_only_enabled:\s*false/)
  })

  it('keeps the DM scopes it already requests meaningful', () => {
    const scopes = listItemsUnder(yaml, 'bot:')
    expect(scopes).toContain('im:history')
    expect(scopes).toContain('im:read')
  })
})

describe('canGenerateSlackAppManifest', () => {
  it('accepts an absolute request URL', () => {
    expect(canGenerateSlackAppManifest(URL)).toBe(true)
    expect(canGenerateSlackAppManifest('http://webhook.example.com/webhooks/slack/x')).toBe(true)
  })

  it('refuses a bare path, which Slack rejects as a request_url', () => {
    expect(canGenerateSlackAppManifest('/webhooks/slack/slack%3AeyJ4IjoxfQ')).toBe(false)
  })

  it('refuses a channel with no Slack webhook at all', () => {
    expect(canGenerateSlackAppManifest(null)).toBe(false)
    expect(canGenerateSlackAppManifest(undefined)).toBe(false)
    expect(canGenerateSlackAppManifest('')).toBe(false)
  })
})
