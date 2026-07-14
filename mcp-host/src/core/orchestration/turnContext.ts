/**
 * T2.2 — `<turn-context>` block.
 *
 * Volatile per-turn data (date, channel, sender, cron) moves out of the
 * system prompt (which we want byte-stable across turns for prompt caching)
 * and into a fenced block prepended to the user message. Format from
 * `.specs/mcp-hermes/aclaraciones/system-prompt-tiers.md` §76-84:
 *
 *     <turn-context>
 *     date: 2026-05-19T14:30:00Z
 *     channel: telegram
 *     sender: jane@example.com
 *     </turn-context>
 *
 *     <original user message>
 *
 * For cron-originated turns we append two extra lines (`cron_job` /
 * `scheduled_for`) — see P1-004.
 */

export interface TurnContextChannel {
  type: string
  sender?: string | null
}

export interface TurnContextCron {
  jobId: string
  scheduledFor: string
}

export interface TurnContextInput {
  date: Date
  channel: TurnContextChannel
  cron?: TurnContextCron
}

export function buildTurnContextBlock(input: TurnContextInput): string {
  const lines: string[] = [`date: ${input.date.toISOString()}`, `channel: ${input.channel.type}`]
  if (input.channel.sender) {
    lines.push(`sender: ${input.channel.sender}`)
  }
  if (input.cron) {
    lines.push(`cron_job: ${input.cron.jobId}`)
    lines.push(`scheduled_for: ${input.cron.scheduledFor}`)
  }
  return `<turn-context>\n${lines.join('\n')}\n</turn-context>\n\n`
}
