import { describe, expect, it, vi } from 'vitest'
import { BasicSafety } from '../../core/safety'
import { APPROVAL_INPUT_PREVIEW_BYTES, projectApprovalInputPreview } from '../approvalInputPreview'
import { SseProgressReporter } from '../sseProgressReporter'
import type { ProgressEvent } from '../types'

describe('approval input preview', () => {
  it('keeps the complete shell command without changing the approved parameters', () => {
    const parameters = {
      command: 'node -e "console.log(1)"',
      headers: { other: 'not-for-preview' },
    }
    const original = structuredClone(parameters)
    expect(projectApprovalInputPreview('shell_exec', parameters, text => text)).toEqual({
      text: parameters.command,
      truncated: false,
    })
    expect(parameters).toEqual(original)
    expect(projectApprovalInputPreview('http_request', parameters, text => text)).toBeUndefined()
  })

  it.each([(text: string) => text.slice(0, 4), (text: string) => text.replace(/\n/g, ' ')])(
    'marks shortening or normalization by a projection redactor as incomplete',
    redact => {
      expect(
        projectApprovalInputPreview(
          'shell_exec',
          { command: 'printf first\nprintf second' },
          redact
        )
      ).toMatchObject({ truncated: true })
    }
  )

  it('redacts the whole command before applying the UTF-8 preview limit', () => {
    const protectedText = 'UNIT_ONLY_PROTECTED_VALUE'
    const command = `${'x'.repeat(APPROVAL_INPUT_PREVIEW_BYTES - 3)}${protectedText}`
    const redact = vi.fn((text: string) => text.replace(protectedText, '[REDACTED]'))
    const preview = projectApprovalInputPreview('shell_exec', { command }, redact)!
    expect(redact).toHaveBeenCalledWith(command)
    expect(preview.truncated).toBe(true)
    expect(preview.text).not.toContain('UNI')
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(APPROVAL_INPUT_PREVIEW_BYTES)
    const unicode = projectApprovalInputPreview(
      'shell_exec',
      { command: '🌴'.repeat(20_000) },
      text => text
    )!
    expect(unicode.truncated).toBe(true)
    expect(unicode.text).not.toContain('\uFFFD')
    expect(Buffer.byteLength(unicode.text)).toBeLessThanOrEqual(APPROVAL_INPUT_PREVIEW_BYTES)
  })

  it('publishes only the sanitized command before tool_start and replays that same safe suspension', () => {
    // Unit-only value registered with the real safety boundary; never an access grant.
    const protectedText = 'UNIT_ONLY_PROTECTED_VALUE'
    const safety = new BasicSafety(() => [{ name: 'UNIT_ONLY_PROTECTED', value: protectedText }])
    const reporter = new SseProgressReporter('preview-task', undefined, safety)
    const events: ProgressEvent[] = []
    const parameters = {
      command: `node -e "console.log('${protectedText}')"`,
      headers: { authorization: protectedText },
      token: protectedText,
    }
    const original = structuredClone(parameters)
    reporter.subscribe(event => events.push(event))
    reporter.emitSuspended('Shell', 'preview-request', { toolName: 'shell_exec', parameters })

    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event.type).toBe('suspended')
    if (event.type !== 'suspended') throw new Error('expected approval suspension')
    expect(event.data.requestId).toBe('preview-request')
    expect(event.data.inputPreview?.text).toContain('node')
    expect(event.data.inputPreview?.text).not.toContain(protectedText)
    expect(event.data.inputPreview?.truncated).toBe(true)
    expect(event.data).not.toHaveProperty('parameters')
    expect(event.data).not.toHaveProperty('toolName')
    expect(JSON.stringify(event)).not.toContain('authorization')
    expect(JSON.stringify(event)).not.toContain(protectedText)
    expect(parameters).toEqual(original)

    const replay: ProgressEvent[] = []
    reporter.subscribe(value => replay.push(value))
    expect(replay).toEqual([event])
    reporter.dispose()
  })
})
