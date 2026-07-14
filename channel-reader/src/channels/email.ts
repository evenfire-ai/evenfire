/**
 * Email channel adapter using ImapFlow for receiving and nodemailer for sending.
 */
import { ImapFlow } from 'imapflow'
import * as nodemailer from 'nodemailer'
import { config } from '../config'
import { Attachment, ChannelAdapter, FetchMessagesOptions, Message } from '../types'
import { isAllowedSender } from './base'

export class EmailAdapter implements ChannelAdapter {
  readonly channelType = 'email' as const

  private client: ImapFlow | null = null
  private transporter: nodemailer.Transporter | null = null
  private seenMessageIds: Set<string> = new Set()
  private lastSenderEmail: Map<string, string> = new Map() // messageId -> sender email
  private username: string | null = null
  private password: string | null = null

  async connect(credentials?: { emailUsername?: string; emailPassword?: string }): Promise<void> {
    const username = credentials?.emailUsername?.trim()
    const password = credentials?.emailPassword?.trim()
    if (!config.emailImapHost || !username || !password) {
      console.warn('[Email] IMAP settings not fully configured, skipping')
      return
    }

    this.username = username
    this.password = password

    // Set up IMAP client for receiving
    this.client = new ImapFlow({
      host: config.emailImapHost,
      port: config.emailImapPort,
      secure: true,
      auth: {
        user: username,
        pass: password,
      },
      logger: false,
    })

    try {
      await this.client.connect()
      console.log(`[Email] Connected to IMAP server ${config.emailImapHost}`)
    } catch (err) {
      console.error('[Email] IMAP connection error:', err)
      this.client = null
    }

    // Set up SMTP transporter for sending
    if (config.emailSmtpHost) {
      this.transporter = nodemailer.createTransport({
        host: config.emailSmtpHost,
        port: config.emailSmtpPort,
        secure: config.emailSmtpPort === 465,
        auth: {
          user: username,
          pass: password,
        },
      })
      console.log(`[Email] SMTP transporter configured for ${config.emailSmtpHost}`)
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.logout()
      this.client = null
    }
    if (this.transporter) {
      this.transporter.close()
      this.transporter = null
    }
    this.username = null
    this.password = null
  }

  async fetchMessages(
    channelId: string,
    allowedSenders: Set<string>,
    _options?: FetchMessagesOptions
  ): Promise<Message[]> {
    if (!this.client) {
      console.log('[Email] Not connected, skipping')
      return []
    }

    const messages: Message[] = []
    const mailbox = channelId || 'INBOX'

    try {
      const lock = await this.client.getMailboxLock(mailbox)

      try {
        // Search for unseen messages
        const searchResults = await this.client.search({ seen: false })

        if (!searchResults || searchResults.length === 0) {
          return []
        }

        // Fetch message details
        for await (const msg of this.client.fetch(searchResults, {
          envelope: true,
          source: true,
          uid: true,
        })) {
          const messageId = msg.envelope?.messageId || msg.uid.toString()

          // Skip already seen
          if (this.seenMessageIds.has(messageId)) {
            continue
          }

          // Extract sender email
          const fromAddress = msg.envelope?.from?.[0]?.address
          if (!fromAddress) {
            continue
          }

          // Check if sender is allowed
          if (!isAllowedSender(fromAddress, allowedSenders)) {
            console.log(`[Email] Ignoring message from unauthorized sender ${fromAddress}`)
            continue
          }

          // Get content
          const subject = msg.envelope?.subject || ''
          const body = msg.source?.toString() || ''

          // Extract plain text from source (basic extraction)
          const textBody = this.extractTextBody(body)
          const fullContent = `${subject}\n${textBody}`

          this.seenMessageIds.add(messageId)
          this.lastSenderEmail.set(messageId, fromAddress)
          console.log(`[Email] Received message from ${fromAddress}`)

          const inReplyTo = msg.envelope?.inReplyTo
          messages.push({
            channelType: 'email',
            channelId,
            sender: fromAddress,
            content: fullContent,
            timestamp: msg.envelope?.date || new Date(),
            messageId,
            threadId: typeof inReplyTo === 'string' ? inReplyTo : undefined,
            rawData: { subject, body: textBody },
          })
        }
      } finally {
        lock.release()
      }
    } catch (err) {
      console.error('[Email] Fetch error:', err)
    }

    return messages
  }

  private extractTextBody(rawEmail: string): string {
    // Simple text extraction - look for plain text content
    const lines = rawEmail.split('\n')
    let inBody = false
    let isPlainText = false
    const bodyLines: string[] = []

    for (const line of lines) {
      if (!inBody) {
        // Check for content-type header
        if (line.toLowerCase().startsWith('content-type:')) {
          isPlainText = line.toLowerCase().includes('text/plain')
        }
        // Empty line marks start of body
        if (line.trim() === '') {
          inBody = true
        }
      } else if (isPlainText || !rawEmail.toLowerCase().includes('content-type:')) {
        // Collect body lines
        bodyLines.push(line)
      }
    }

    return bodyLines.join('\n').trim()
  }

  async sendMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
    attachments?: Attachment[]
  ): Promise<string | undefined> {
    if (!this.transporter) {
      console.warn('[Email] SMTP transporter not configured, cannot send message')
      return undefined
    }

    // Get the recipient email from the original message
    const recipientEmail = replyToMessageId ? this.lastSenderEmail.get(replyToMessageId) : undefined

    if (!recipientEmail) {
      console.warn('[Email] Cannot determine recipient email, cannot send reply')
      return undefined
    }

    const finalContent =
      attachments && attachments.length > 0
        ? `${content}\n\n[Note: ${attachments.length} attachment(s) were generated, but attachment delivery is currently enabled only for Telegram.]`
        : content

    try {
      await this.transporter.sendMail({
        from: this.username ?? '',
        to: recipientEmail,
        subject: 'Re: Your message',
        text: finalContent,
        inReplyTo: replyToMessageId,
        references: replyToMessageId,
      })
      console.log(`[Email] Sent reply to ${recipientEmail}`)
      return undefined // Email cannot provide a message ID for editing
    } catch (err) {
      console.error('[Email] Failed to send message:', err)
      throw err
    }
  }

  async editMessage(_channelId: string, _messageId: string, _content: string): Promise<void> {
    // Email messages cannot be edited after sending
  }
}
