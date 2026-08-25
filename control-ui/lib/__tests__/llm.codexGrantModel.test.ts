import { describe, expect, it } from 'vitest'
import {
  HOST_MODEL_NAME_REQUIRED,
  hostModelNameError,
  resolveCodexGrantModel,
  resolveDefaultModel,
} from '../llm'

describe('resolveCodexGrantModel', () => {
  it('keeps a named draft that is already in the grant catalog', () => {
    expect(resolveDefaultModel('codex-subscription', ['gpt-5.1'])).toBe('')
    expect(resolveCodexGrantModel('gpt-5.1', ['gpt-5.1', 'gpt-5.2'])).toBe('gpt-5.1')
  })

  it('seeds the first offered grant model when the draft is empty', () => {
    expect(resolveCodexGrantModel('', ['gpt-5.1', 'gpt-5.2'])).toBe('gpt-5.1')
    expect(resolveCodexGrantModel('   ', ['gpt-5.1'])).toBe('gpt-5.1')
  })

  it('replaces a named draft that is not in the offered grant list', () => {
    expect(resolveCodexGrantModel('gpt-5.4-mini', ['gpt-5.6-luna', 'gpt-5.6-sol'])).toBe(
      'gpt-5.6-luna'
    )
  })

  it('invents nothing when the grant catalog is empty', () => {
    expect(resolveCodexGrantModel('gpt-5.4-mini', [])).toBe('')
    expect(resolveCodexGrantModel('', [])).toBe('')
  })
})

describe('hostModelNameError', () => {
  it('blocks the empty spec.model.name that the API rejects with 422', () => {
    expect(hostModelNameError('')).toBe(HOST_MODEL_NAME_REQUIRED)
    expect(hostModelNameError('   ')).toBe(HOST_MODEL_NAME_REQUIRED)
    expect(hostModelNameError('gpt-5.1')).toBeNull()
  })
})
