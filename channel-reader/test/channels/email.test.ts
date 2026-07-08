import { beforeEach, describe, expect, it, vi } from 'vitest'
// ── Import under test ─────────────────────────────────────────────────────────

import { EmailAdapter } from '../../src/channels/email.js'

// ── Hoisted shared state ──────────────────────────────────────────────────────

const imapState = vi.hoisted(() => ({
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    getMailboxLock: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    fetch: ReturnType<typeof vi.fn>
  }>,
  // Controls whether search returns message UIDs
  searchResults: [] as number[],
  // Messages returned by fetch async generator
  fetchMessages: [] as Array<{
    uid: number
    envelope?: {
      messageId?: string
      from?: Array<{ address?: string }>
      subject?: string
      date?: Date
    }
    source?: Buffer
  }>,
}))

const transporterState = vi.hoisted(() => ({
  sendMailFn: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
  closeFn: vi.fn(),
}))

const mockCfg = vi.hoisted(
  () =>
    ({
      emailImapHost: 'imap.example.com' as string | undefined,
      emailImapPort: 993,
      // mockCfg retains emailImapHost + SMTP settings because email.ts still
      // imports `config` for infrastructure fields. Bot credentials (username,
      // password) are now passed to connect() directly — see TEST_USERNAME /
      // TEST_PASSWORD below.
      emailUsername: 'user@example.com' as string | undefined,
      emailSmtpHost: 'smtp.example.com' as string | undefined,
      emailSmtpPort: 587,
    }) as {
      emailImapHost: string | undefined
      emailImapPort: number
      emailUsername: string | undefined
      emailSmtpHost: string | undefined
      emailSmtpPort: number
    }
)

const TEST_USERNAME = 'user@example.com'
const TEST_PASSWORD = 'secret'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('imapflow', () => ({
  // Must use `function` for constructor mocking with `new`
  ImapFlow: vi.fn().mockImplementation(function () {
    // Returns an async iterable from the fetch mock using imapState.fetchMessages
    const instance = {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockImplementation(() => Promise.resolve(imapState.searchResults)),
      // fetch returns an async generator yielding imapState.fetchMessages
      fetch: vi.fn().mockImplementation(async function* () {
        for (const msg of imapState.fetchMessages) {
          yield msg
        }
      }),
    }
    imapState.instances.push(instance)
    return instance
  }),
}))

vi.mock('nodemailer', () => ({
  createTransport: vi.fn().mockImplementation(function () {
    return {
      sendMail: transporterState.sendMailFn,
      close: transporterState.closeFn,
    }
  }),
}))

vi.mock('../../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  imapState.instances.length = 0
  imapState.searchResults = []
  imapState.fetchMessages = []
  transporterState.sendMailFn.mockClear()
  transporterState.closeFn.mockClear()

  // Restore full config between tests
  mockCfg.emailImapHost = 'imap.example.com'
  mockCfg.emailUsername = 'user@example.com'
  mockCfg.emailSmtpHost = 'smtp.example.com'
})

// ── connect() ─────────────────────────────────────────────────────────────────

describe('EmailAdapter — connect()', () => {
  it('creates an ImapFlow client and connects', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    expect(imapState.instances).toHaveLength(1)
    expect(imapState.instances[0]!.connect).toHaveBeenCalledOnce()
  })

  it('skips connection when emailImapHost is not configured', async () => {
    mockCfg.emailImapHost = undefined

    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    expect(imapState.instances).toHaveLength(0)
  })

  it('skips connection when emailUsername is not configured', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: undefined, emailPassword: TEST_PASSWORD })

    expect(imapState.instances).toHaveLength(0)
  })

  it('skips connection when emailPassword is not configured', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: undefined })

    expect(imapState.instances).toHaveLength(0)
  })

  it('handles IMAP connection errors gracefully', async () => {
    const adapter = new EmailAdapter()

    // Make connect() throw
    const instance = { connect: vi.fn().mockRejectedValue(new Error('IMAP down')) }
    // Override what ImapFlow returns for just this test
    imapState.instances.push(instance as never)
    // The real constructor has to return something that throws on connect()
    const { ImapFlow } = await import('imapflow')
    vi.mocked(ImapFlow).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockRejectedValue(new Error('IMAP down')),
        logout: vi.fn(),
        getMailboxLock: vi.fn(),
        search: vi.fn(),
        fetch: vi.fn(),
      } as never
    })

    // Should not throw even when IMAP fails
    await expect(
      adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })
    ).resolves.toBeUndefined()
  })
})

// ── disconnect() ──────────────────────────────────────────────────────────────

describe('EmailAdapter — disconnect()', () => {
  it('calls logout() on the IMAP client', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    const imap = imapState.instances[0]!
    await adapter.disconnect()

    expect(imap.logout).toHaveBeenCalledOnce()
  })

  it('is safe to call disconnect() before connect()', async () => {
    const adapter = new EmailAdapter()
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })

  it('nullifies internal client after disconnect (double-disconnect is safe)', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })
    await adapter.disconnect()
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })

  it('closes the nodemailer transporter', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })
    await adapter.disconnect()

    expect(transporterState.closeFn).toHaveBeenCalledOnce()
  })
})

// ── fetchMessages() ───────────────────────────────────────────────────────────

describe('EmailAdapter — fetchMessages()', () => {
  it('returns empty array when not connected', async () => {
    const adapter = new EmailAdapter()
    // No connect()

    const messages = await adapter.fetchMessages('INBOX', new Set(['user@allowed.com']))
    expect(messages).toEqual([])
  })

  it('returns empty array when no unseen messages', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    imapState.searchResults = [] // no results
    const messages = await adapter.fetchMessages('INBOX', new Set(['user@allowed.com']))
    expect(messages).toEqual([])
  })

  it('returns messages from allowed senders', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    imapState.searchResults = [1]
    imapState.fetchMessages = [
      {
        uid: 1,
        envelope: {
          messageId: '<msg-1@example.com>',
          from: [{ address: 'sender@allowed.com' }],
          subject: 'Hello',
          date: new Date('2024-01-01T10:00:00Z'),
        },
        source: Buffer.from('Content-Type: text/plain\n\nHello there'),
      },
    ]

    const messages = await adapter.fetchMessages('INBOX', new Set(['sender@allowed.com']))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sender).toBe('sender@allowed.com')
    expect(messages[0]!.channelType).toBe('email')
    expect(messages[0]!.channelId).toBe('INBOX')
    expect(messages[0]!.content).toContain('Hello')
  })

  it('ignores messages from unauthorized senders', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    imapState.searchResults = [1]
    imapState.fetchMessages = [
      {
        uid: 1,
        envelope: {
          messageId: '<msg-1@example.com>',
          from: [{ address: 'spammer@evil.com' }],
          subject: 'Spam',
        },
        source: Buffer.from('Content-Type: text/plain\n\nBuy now!'),
      },
    ]

    const messages = await adapter.fetchMessages('INBOX', new Set(['allowed@example.com']))
    expect(messages).toHaveLength(0)
  })

  it('deduplicates messages using seenMessageIds', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    imapState.searchResults = [1]
    imapState.fetchMessages = [
      {
        uid: 1,
        envelope: {
          messageId: '<msg-1@example.com>',
          from: [{ address: 'sender@allowed.com' }],
          subject: 'Once',
        },
        source: Buffer.from('Content-Type: text/plain\n\nOnce'),
      },
    ]

    // First poll: message arrives
    const first = await adapter.fetchMessages('INBOX', new Set(['sender@allowed.com']))
    expect(first).toHaveLength(1)

    // Second poll: same UID → should be deduplicated
    const second = await adapter.fetchMessages('INBOX', new Set(['sender@allowed.com']))
    expect(second).toHaveLength(0)
  })

  it('maps messageId, channelId, and timestamp correctly', async () => {
    const adapter = new EmailAdapter()
    await adapter.connect({ emailUsername: TEST_USERNAME, emailPassword: TEST_PASSWORD })

    const expectedDate = new Date('2024-06-15T12:00:00Z')
    imapState.searchResults = [42]
    imapState.fetchMessages = [
      {
        uid: 42,
        envelope: {
          messageId: '<unique-id-42@example.com>',
          from: [{ address: 'alice@example.com' }],
          subject: 'Field test',
          date: expectedDate,
        },
        source: Buffer.from('Content-Type: text/plain\n\nField content'),
      },
    ]

    const [msg] = await adapter.fetchMessages('MyMailbox', new Set(['alice@example.com']))
    expect(msg!.messageId).toBe('<unique-id-42@example.com>')
    expect(msg!.channelId).toBe('MyMailbox')
    expect(msg!.timestamp).toEqual(expectedDate)
  })
})

// ── channelType ───────────────────────────────────────────────────────────────

describe('EmailAdapter — channelType', () => {
  it('reports channelType as email', () => {
    const adapter = new EmailAdapter()
    expect(adapter.channelType).toBe('email')
  })
})
