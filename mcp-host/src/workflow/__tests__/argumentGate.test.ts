import { describe, expect, it } from 'vitest'
import { checkToolArguments } from '../argumentGate'
import type { InternalToolDefinition } from '../types'

/** A tool whose schema is a new object on every build, as the GFS and capability tools are. */
function rebuilt(): InternalToolDefinition {
  return {
    name: 'clerum__rebuilt',
    description: 'test',
    parameters: {
      $id: 'https://clerum.test/rebuilt',
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'number' }, mode: { type: 'string', default: 'fast' } },
    },
    execute: async () => ({ success: true }),
  }
}

describe('the argument check shared by chat and workflow steps', () => {
  it('validates a schema built anew for each conversation, without keeping the old ones', () => {
    // A schema Ajv kept would make the next one with the same $id fail to
    // compile, and its calls would go through unchecked.
    for (let i = 0; i < 3; i++) {
      expect(checkToolArguments(rebuilt(), { count: 'one' })).toEqual({
        ok: false,
        error: 'Invalid arguments: data/count must be number',
      })
      expect(checkToolArguments(rebuilt(), { count: 1 })).toEqual({
        ok: true,
        input: { count: 1, mode: 'fast' },
      })
    }
  })

  it('reads a null sent for an unset optional argument as unset, and leaves the arguments as sent', () => {
    const args = { count: 2, mode: null }
    expect(checkToolArguments(rebuilt(), args)).toEqual({
      ok: true,
      input: { count: 2, mode: 'fast' },
    })
    expect(args).toEqual({ count: 2, mode: null })
  })
})
