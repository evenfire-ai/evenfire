import { describe, expect, it } from 'vitest'
import { buildMessageGroupChunks } from '../ChatThread'

function group(turn: number, role: 'user' | 'assistant') {
  return {
    groupKey: `${role}-${turn}`,
    items: [{ serverTurnNumber: turn }],
  }
}

function turnGroups(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const turn = start + index
    return [group(turn, 'user'), group(turn, 'assistant')]
  }).flat()
}

describe('buildMessageGroupChunks', () => {
  it('keeps existing server-turn chunk keys stable when a new turn is appended', () => {
    const before = buildMessageGroupChunks(turnGroups(1, 8))
    const after = buildMessageGroupChunks(turnGroups(1, 9))

    expect(before.map(chunk => chunk.chunkKey)).toEqual(['server-turns-0', 'server-turns-1'])
    expect(after.map(chunk => chunk.chunkKey)).toEqual([
      'server-turns-0',
      'server-turns-1',
      'server-turns-2',
    ])
    expect(after.slice(0, before.length).map(chunk => chunk.chunkKey)).toEqual(
      before.map(chunk => chunk.chunkKey)
    )
    expect(after[0]?.groups.map(({ group }) => group.groupKey)).toEqual(
      before[0]?.groups.map(({ group }) => group.groupKey)
    )
    expect(after[1]?.groups.map(({ group }) => group.groupKey)).toEqual(
      before[1]?.groups.map(({ group }) => group.groupKey)
    )
  })
})
