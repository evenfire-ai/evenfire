import type { ChatMessage } from './types.js'

export function messageServerTurnNumber(message: Pick<ChatMessage, 'id' | 'serverTurnNumber'>) {
  if (message.serverTurnNumber !== undefined) return message.serverTurnNumber
  const match = /^turn-(\d+)-(?:user|assistant)$/.exec(message.id)
  return match ? Number(match[1]) : undefined
}

function roleRank(message: Pick<ChatMessage, 'role'>): number {
  return message.role === 'user' ? 0 : message.role === 'assistant' ? 1 : 2
}

function serverSlotKey(message: Pick<ChatMessage, 'id' | 'role' | 'serverTurnNumber'>): string {
  return `${messageServerTurnNumber(message)}\u0000${message.role}`
}

function preferredServerMessage(
  server: ChatMessage,
  local: ChatMessage | undefined,
  options: { copyLocalMetadata: boolean }
): ChatMessage {
  if (!local || !options.copyLocalMetadata) return server
  return {
    ...server,
    task_id: local.task_id ?? server.task_id,
    attachments: server.attachments?.length ? server.attachments : local.attachments,
    toolSteps: server.toolSteps?.length ? server.toolSteps : local.toolSteps,
  }
}

function insertUnmatchedTurnlessIncoming(
  mergedMessages: ChatMessage[],
  incoming: ChatMessage[],
  removedIds: ReadonlySet<string>
): ChatMessage[] {
  const merged = [...mergedMessages]
  const mergedIds = new Set(merged.map(message => message.id))

  for (const [incomingIndex, message] of incoming.entries()) {
    if (
      messageServerTurnNumber(message) !== undefined ||
      mergedIds.has(message.id) ||
      removedIds.has(message.id)
    ) {
      continue
    }

    let previousTurn: number | undefined
    for (let index = incomingIndex - 1; index >= 0; index -= 1) {
      previousTurn = messageServerTurnNumber(incoming[index]!)
      if (previousTurn !== undefined) break
    }

    let nextTurn: number | undefined
    for (let index = incomingIndex + 1; index < incoming.length; index += 1) {
      nextTurn = messageServerTurnNumber(incoming[index]!)
      if (nextTurn !== undefined) break
    }

    let insertionIndex = merged.length
    if (previousTurn !== undefined) {
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        if (messageServerTurnNumber(merged[index]!) === previousTurn) {
          insertionIndex = index + 1
          break
        }
      }
    } else if (nextTurn !== undefined) {
      const nextIndex = merged.findIndex(item => messageServerTurnNumber(item) === nextTurn)
      if (nextIndex >= 0) insertionIndex = nextIndex
    }

    merged.splice(insertionIndex, 0, message)
    mergedIds.add(message.id)
  }

  return merged
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

  const previousNumberedMessages: Array<ChatMessage | undefined> = []
  let previousNumberedMessage: ChatMessage | undefined
  for (const message of existing) {
    previousNumberedMessages.push(previousNumberedMessage)
    if (messageServerTurnNumber(message) !== undefined) previousNumberedMessage = message
  }
  const nextNumberedMessages: Array<ChatMessage | undefined> = new Array(existing.length)
  let nextNumberedMessage: ChatMessage | undefined
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    nextNumberedMessages[index] = nextNumberedMessage
    if (messageServerTurnNumber(existing[index]!) !== undefined) {
      nextNumberedMessage = existing[index]
    }
  }

  const removed: ChatMessage[] = []
  const removedIndexes = new Set<number>()
  const removedIndexByMessage = new Map<ChatMessage, number>()
  const localByServerMessage = new Map<ChatMessage, ChatMessage>()
  const consumedLocalMessages = new Set<ChatMessage>()
  const suppressedServerMessages = new Set<ChatMessage>()

  const markLocalReplacement = (serverMessage: ChatMessage, localMessage: ChatMessage) => {
    const index = existing.indexOf(localMessage)
    if (index < 0 || consumedLocalMessages.has(localMessage)) return
    consumedLocalMessages.add(localMessage)
    removed.push(localMessage)
    removedIndexes.add(index)
    removedIndexByMessage.set(localMessage, index)
    localByServerMessage.set(serverMessage, localMessage)
  }

  for (const serverMessage of authoritative) {
    const slot = serverSlotKey(serverMessage)
    const sameSlot = existing.find(
      local =>
        !consumedLocalMessages.has(local) &&
        messageServerTurnNumber(local) !== undefined &&
        serverSlotKey(local) === slot
    )
    if (sameSlot) markLocalReplacement(serverMessage, sameSlot)
  }

  const serverTurnAllowedForTurnlessLocal = (
    serverMessage: ChatMessage,
    localMessage: ChatMessage,
    localIndex: number
  ): boolean => {
    const serverTurn = messageServerTurnNumber(serverMessage)!
    const previous = previousNumberedMessages[localIndex]
    const previousTurn =
      previous !== undefined
        ? (messageServerTurnNumber(previous) ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY
    const next = nextNumberedMessages[localIndex]
    const nextTurn =
      next !== undefined
        ? (messageServerTurnNumber(next) ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY
    const lowerBoundAllows =
      serverTurn > previousTurn ||
      (serverTurn === previousTurn && previous?.role !== localMessage.role)
    const upperBoundAllows =
      serverTurn < nextTurn || (serverTurn === nextTurn && next?.role !== localMessage.role)
    return lowerBoundAllows && upperBoundAllows
  }

  for (const [index, message] of existing.entries()) {
    if (
      messageServerTurnNumber(message) !== undefined ||
      message.task_id === undefined ||
      options.activeTaskIds?.has(message.task_id) !== true
    ) {
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.isError || message.preserveLocal || consumedLocalMessages.has(message)) continue
    const eligibleServerMessages = authoritative.filter(
      serverMessage =>
        !localByServerMessage.has(serverMessage) &&
        !suppressedServerMessages.has(serverMessage) &&
        serverMessage.role === message.role &&
        serverTurnAllowedForTurnlessLocal(serverMessage, message, index)
    )
    // A live local bubble remains authoritative for the UI until the server can
    // identify the same task. Current server history rows are usually unscoped,
    // so suppress one only when its role and position identify a single slot.
    const exactTaskMatches = eligibleServerMessages.filter(
      serverMessage => serverMessage.task_id === message.task_id
    )
    if (exactTaskMatches.length === 1) {
      markLocalReplacement(exactTaskMatches[0]!, message)
      continue
    }

    const unscopedCandidates = eligibleServerMessages.filter(
      serverMessage => serverMessage.task_id === undefined
    )
    const candidateTurns = new Set(
      unscopedCandidates.map(serverMessage => messageServerTurnNumber(serverMessage)!)
    )
    if (candidateTurns.size === 1 && unscopedCandidates.length === 1) {
      suppressedServerMessages.add(unscopedCandidates[0]!)
    }
  }

  for (const [index, message] of existing.entries()) {
    if (messageServerTurnNumber(message) !== undefined) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.isError || message.preserveLocal || consumedLocalMessages.has(message)) continue
    if (message.task_id && options.activeTaskIds?.has(message.task_id)) continue

    const authoritativeCandidates = authoritative.filter(
      serverMessage =>
        !suppressedServerMessages.has(serverMessage) &&
        serverMessage.role === message.role &&
        serverTurnAllowedForTurnlessLocal(serverMessage, message, index)
    )
    const candidateTurns = new Set<number>()
    for (const candidate of authoritativeCandidates) {
      candidateTurns.add(messageServerTurnNumber(candidate)!)
    }
    if (candidateTurns.size !== 1) continue

    const candidates = authoritativeCandidates.filter(
      serverMessage =>
        !localByServerMessage.has(serverMessage) &&
        serverTurnAllowedForTurnlessLocal(serverMessage, message, index)
    )
    if (!candidates.length) continue
    markLocalReplacement(candidates[0]!, message)
  }

  const hydratedReplacements = authoritative
    .filter(message => !suppressedServerMessages.has(message))
    .map(message => {
      const local = localByServerMessage.get(message)
      return {
        message: preferredServerMessage(message, local, { copyLocalMetadata: Boolean(local) }),
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
    const exactSlotAnchor = existing.findIndex(
      message =>
        messageServerTurnNumber(message) === replacementTurn &&
        message.role === replacement.message.role
    )
    const exactTurnAnchor = existing.findIndex(
      message => messageServerTurnNumber(message) === replacementTurn
    )
    let anchorIndex = exactSlotAnchor >= 0 ? exactSlotAnchor : exactTurnAnchor
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
  return insertUnmatchedTurnlessIncoming(
    merged,
    incoming,
    new Set(removed.map(message => message.id))
  )
}
