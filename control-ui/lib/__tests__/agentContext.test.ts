import { describe, expect, it } from 'vitest'
import { createAgentContextName } from '../agentContext'
import { isValidK8sName } from '../k8sValidation'

describe('createAgentContextName', () => {
  it('keeps the agent name and appends a five-digit implementation suffix', () => {
    const contextName = createAgentContextName('research-agent')

    expect(contextName).toMatch(/^research-agent-[0-9]{5}$/)
    expect(isValidK8sName(contextName)).toBe(true)
  })

  it('caps long agent names so the generated context remains a valid label', () => {
    const contextName = createAgentContextName('a'.repeat(63))

    expect(contextName).toHaveLength(63)
    expect(contextName).toMatch(/^a{57}-[0-9]{5}$/)
    expect(isValidK8sName(contextName)).toBe(true)
  })
})
