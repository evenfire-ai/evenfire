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
  const removedIndexes = new Set<number>()
  const removedIndexByMessage = new Map<ChatMessage, number>()
  for (const [index, message] of existing.entries()) {
    const turn = messageServerTurnNumber(message)
    const numberedInRange = turn !== undefined && turn >= firstTurn && turn <= lastTurn
    const turnlessInRange =
      turn === undefined &&
      (previousTurns[index] ?? Number.NEGATIVE_INFINITY) <= lastTurn &&
      (nextTurns[index] ?? Number.POSITIVE_INFINITY) >= firstTurn
    const replaceableTurnRole = message.role === 'user' || message.role === 'assistant'
    const belongsToActiveTask =
      message.task_id !== undefined && options.activeTaskIds?.has(message.task_id) === true
    const shouldReplace =
      numberedInRange ||
      (turnlessInRange && replaceableTurnRole && !message.isError && !belongsToActiveTask)
    if (shouldReplace) {
      removed.push(message)
      removedIndexes.add(index)
      removedIndexByMessage.set(message, index)
    }
  }

  const availableByRole = new Map<ChatMessage['role'], ChatMessage[]>()
  for (const message of removed) {
    const entries = availableByRole.get(message.role) ?? []
    entries.push(message)
    availableByRole.set(message.role, entries)
  }
  const claimedAuthoritativeSlots = new Set<string>()
  for (const [index, message] of existing.entries()) {
    if (
      messageServerTurnNumber(message) !== undefined ||
      message.task_id === undefined ||
      options.activeTaskIds?.has(message.task_id) !== true ||
      (message.role !== 'user' && message.role !== 'assistant')
    ) {
      continue
    }
    const previous = previousTurns[index] ?? Number.NEGATIVE_INFINITY
    const next = nextTurns[index] ?? Number.POSITIVE_INFINITY
    const matchingServerMessage = authoritative.find(serverMessage => {
      const serverTurn = messageServerTurnNumber(serverMessage)!
      const slot = `${serverTurn}\u0000${serverMessage.role}`
      return (
        serverMessage.role === message.role &&
        serverTurn > previous &&
        serverTurn < next &&
        !claimedAuthoritativeSlots.has(slot)
      )
    })
    if (matchingServerMessage) {
      claimedAuthoritativeSlots.add(
        `${messageServerTurnNumber(matchingServerMessage)}\u0000${matchingServerMessage.role}`
      )
    }
  }
  const replacements = authoritative.filter(
    message =>
      !claimedAuthoritativeSlots.has(`${messageServerTurnNumber(message)}\u0000${message.role}`)
  )
  const consumedRemovedMessages = new Set<ChatMessage>()
  const exactLocalByIncoming = new Map<ChatMessage, ChatMessage>()
  for (const message of replacements) {
    const sameTurn = removed.find(
      local =>
        !consumedRemovedMessages.has(local) &&
        messageServerTurnNumber(local) === messageServerTurnNumber(message) &&
        local.role === message.role
    )
    if (sameTurn) {
      consumedRemovedMessages.add(sameTurn)
      exactLocalByIncoming.set(message, sameTurn)
    }
  }
  const takeFallbackByRole = (role: ChatMessage['role']): ChatMessage | undefined => {
    const entries = availableByRole.get(role)
    while (entries?.length) {
      const candidate = entries.shift()!
      if (consumedRemovedMessages.has(candidate)) continue
      consumedRemovedMessages.add(candidate)
      return candidate
    }
    return undefined
  }
  const hydratedReplacements = replacements.map(message => {
    const local = exactLocalByIncoming.get(message) ?? takeFallbackByRole(message.role)
    return {
      message: preferredServerMessage(message, local),
      localAnchorIndex: local ? removedIndexByMessage.get(local) : undefined,
    }
  })

  const replacementAnchorByTurn = new Map<number, number>()
  for (const replacement of hydratedReplacements) {
    const replacementTurn = messageServerTurnNumber(replacement.message)!
    if (replacement.localAnchorIndex === undefined) continue
    const currentAnchor = replacementAnchorByTurn.get(replacementTurn)
    if (currentAnchor === undefined || replacement.localAnchorIndex < currentAnchor) {
      replacementAnchorByTurn.set(replacementTurn, replacement.localAnchorIndex)
    }
  }
  const replacementBuckets = new Map<number, ChatMessage[]>()
  let minimumAnchorIndex = 0
  for (const replacement of hydratedReplacements) {
    const replacementTurn = messageServerTurnNumber(replacement.message)!
    const exactTurnAnchor = existing.findIndex(
      message => messageServerTurnNumber(message) === replacementTurn
    )
    let anchorIndex = exactTurnAnchor
    if (anchorIndex < 0) {
      anchorIndex = replacementAnchorByTurn.get(replacementTurn) ?? -1
    }
    if (anchorIndex < 0) {
      anchorIndex = existing.findIndex(message => {
        const existingTurn = messageServerTurnNumber(message)
        return existingTurn !== undefined && existingTurn > replacementTurn
      })
    }
    if (anchorIndex < 0) anchorIndex = existing.length
    anchorIndex = Math.max(anchorIndex, minimumAnchorIndex)
    minimumAnchorIndex = anchorIndex
    replacementAnchorByTurn.set(replacementTurn, anchorIndex)
    const bucket = replacementBuckets.get(anchorIndex) ?? []
    bucket.push(replacement.message)
    replacementBuckets.set(anchorIndex, bucket)
  }

  const merged: ChatMessage[] = []
  for (let index = 0; index <= existing.length; index += 1) {
    merged.push(...(replacementBuckets.get(index) ?? []))
    if (index < existing.length && !removedIndexes.has(index)) {
      merged.push(existing[index]!)
    }
  }
  return merged
}
