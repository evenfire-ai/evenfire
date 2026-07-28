import type { ChatMessage } from './types.js'

export function messageServerTurnNumber(message: Pick<ChatMessage, 'id' | 'serverTurnNumber'>) {
  if (message.serverTurnNumber !== undefined) return message.serverTurnNumber
  const match = /^turn-(\d+)-(?:user|assistant)$/.exec(message.id)
  return match ? Number(match[1]) : undefined
}

function roleRank(message: Pick<ChatMessage, 'role'>): number {
  return message.role === 'user' ? 0 : message.role === 'assistant' ? 1 : 2
}

function preferredServerMessage(server: ChatMessage, local: ChatMessage | undefined): ChatMessage {
  if (!local) return server
  return {
    ...server,
    task_id: local.task_id ?? server.task_id,
    attachments: server.attachments?.length ? server.attachments : local.attachments,
  }
}

/**
 * Replace the authoritative server-turn range as a unit.
 *
 * Turnless optimistic messages positioned inside that range are paired by role
 * and replaced even when content or clocks differ. Only task IDs explicitly
 * reported as active remain; a persisted task_id alone does not prove liveness
 * because completed local echoes retain it. Orphaned optimistic messages are
 * evicted, while non-turn roles and durable errors remain untouched.
 */
export function mergeAuthoritativeServerMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
  options: { activeTaskIds?: ReadonlySet<string> } = {}
): ChatMessage[] {
  const authoritative = incoming
    .filter(message => messageServerTurnNumber(message) !== undefined)
    .sort((left, right) => {
      const turnDelta =
        (messageServerTurnNumber(left) ?? Number.MAX_SAFE_INTEGER) -
        (messageServerTurnNumber(right) ?? Number.MAX_SAFE_INTEGER)
      return turnDelta || roleRank(left) - roleRank(right)
    })
  if (!authoritative.length) {
    const incomingIds = new Set(incoming.map(message => message.id))
    return [...existing.filter(message => !incomingIds.has(message.id)), ...incoming]
  }

  const firstTurn = messageServerTurnNumber(authoritative[0]!)!
  const lastTurn = messageServerTurnNumber(authoritative.at(-1)!)!
  const previousTurns: Array<number | undefined> = []
  let previousTurn: number | undefined
  for (const message of existing) {
    previousTurns.push(previousTurn)
    previousTurn = messageServerTurnNumber(message) ?? previousTurn
  }
  const nextTurns: Array<number | undefined> = new Array(existing.length)
  let nextTurn: number | undefined
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    nextTurns[index] = nextTurn
    nextTurn = messageServerTurnNumber(existing[index]!) ?? nextTurn
  }

  const removed: ChatMessage[] = []
  const kept: ChatMessage[] = []
  let insertionIndex: number | undefined
  for (const [index, message] of existing.entries()) {
    const turn = messageServerTurnNumber(message)
    const numberedInRange = turn !== undefined && turn >= firstTurn && turn <= lastTurn
    const turnlessInRange =
      turn === undefined &&
      (previousTurns[index] ?? Number.NEGATIVE_INFINITY) < firstTurn &&
      (nextTurns[index] ?? Number.POSITIVE_INFINITY) >= firstTurn
    const replaceableTurnRole = message.role === 'user' || message.role === 'assistant'
    const belongsToActiveTask =
      message.task_id !== undefined && options.activeTaskIds?.has(message.task_id) === true
    const shouldReplace =
      numberedInRange ||
      (turnlessInRange && replaceableTurnRole && !message.isError && !belongsToActiveTask)
    if (shouldReplace) {
      insertionIndex ??= kept.length
      removed.push(message)
    } else {
      kept.push(message)
    }
  }

  if (insertionIndex === undefined) {
    const nextNumberedIndex = kept.findIndex(message => {
      const turn = messageServerTurnNumber(message)
      return turn !== undefined && turn > lastTurn
    })
    insertionIndex = nextNumberedIndex < 0 ? kept.length : nextNumberedIndex
  }

  const availableByRole = new Map<ChatMessage['role'], ChatMessage[]>()
  for (const message of removed) {
    const entries = availableByRole.get(message.role) ?? []
    entries.push(message)
    availableByRole.set(message.role, entries)
  }
  const replacements = authoritative.map(message => {
    const sameTurn = removed.find(
      local =>
        messageServerTurnNumber(local) === messageServerTurnNumber(message) &&
        local.role === message.role
    )
    const local = sameTurn ?? availableByRole.get(message.role)?.shift()
    return preferredServerMessage(message, local)
  })

  kept.splice(insertionIndex, 0, ...replacements)
  return kept
}
