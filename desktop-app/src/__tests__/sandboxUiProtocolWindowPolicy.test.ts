import { describe, expect, it } from 'vitest'
import { shouldAcceptSandboxUiProtocolLink } from '../sandboxUiProtocolWindowPolicy.js'

describe('sandbox UI protocol window policy', () => {
  it('accepts valid app protocol links for window handoff', () => {
    expect(
      shouldAcceptSandboxUiProtocolLink(
        'evenfire://app/sandbox-recipes/task-board?path=%2Ftasks&team=team-1'
      )
    ).toBe(true)
  })

  it('rejects malformed app protocol links before a desktop window is requested', () => {
    for (const rawUrl of [
      'evenfire://app/sandbox-recipes/task-board/',
      'evenfire://app/sandbox-recipes/task-board?path=%2Fsafe%2F..%2Fadmin',
      'evenfire://app/sandbox-recipes/task-board?team=other%2Fteam',
      'evenfire://app:444/sandbox-recipes/task-board',
    ]) {
      expect(shouldAcceptSandboxUiProtocolLink(rawUrl)).toBe(false)
    }
  })
})
