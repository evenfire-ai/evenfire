import { describe, expect, it } from 'vitest'
import { buildTurnContextBlock } from '../turnContext'

describe('buildTurnContextBlock (T2.2)', () => {
  it('includes date and channel; omits sender when not provided', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'telegram' },
    })
    expect(block).toBe(
      '<turn-context>\ndate: 2026-05-19T14:30:00.000Z\nchannel: telegram\n</turn-context>\n\n'
    )
  })

  it('includes sender when present', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'telegram', sender: 'jane@example.com' },
    })
    expect(block).toContain('sender: jane@example.com')
  })

  it('includes cron_job and scheduled_for when cron is set', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'cron' },
      cron: { jobId: 'morning-digest', scheduledFor: '2026-05-19T08:00:00Z' },
    })
    expect(block).toContain('cron_job: morning-digest')
    expect(block).toContain('scheduled_for: 2026-05-19T08:00:00Z')
  })

  it('produces the canonical fence shape (open/close + double newline trailer)', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'rpc', sender: 'jose' },
    })
    expect(block.startsWith('<turn-context>\n')).toBe(true)
    expect(block.endsWith('</turn-context>\n\n')).toBe(true)
  })
})
