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
  options: {
    activeTaskIds?: ReadonlySet<string>
    replaceLegacyTurnlessWindow?: boolean
  } = {}
): ChatMessage[] {
  if (options.replaceLegacyTurnlessWindow) {
    const durableLocalMessages = existing.filter(
      message => message.role === 'system' || message.isError || message.preserveLocal
    )
    return mergeAuthoritativeServerMessages(durableLocalMessages, incoming, {
      activeTaskIds: options.activeTaskIds,
    })
  }

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
  // Side metadata (toolSteps/attachments/tokens via copyLocalMetadata) of a
  // collapsed idle echo, keyed by the authoritative row it merges onto. Kept
  // SEPARATE from localByServerMessage: the collapse is not a positional 1↔1
  // replacement, so it must not drive the local anchor index nor the single-claim
  // filter — it only contributes metadata to a server row that always survives
  // (§6.2, R2-M1).
  const collapsedEchoMetadataByServerMessage = new Map<ChatMessage, ChatMessage>()
  const consumedLocalMessages = new Set<ChatMessage>()

  const markLocalReplacement = (serverMessage: ChatMessage, localMessage: ChatMessage) => {
    const index = existing.indexOf(localMessage)
    if (index < 0 || consumedLocalMessages.has(localMessage)) return
    consumedLocalMessages.add(localMessage)
    removed.push(localMessage)
    removedIndexes.add(index)
    removedIndexByMessage.set(localMessage, index)
    localByServerMessage.set(serverMessage, localMessage)
  }

  // Collapse sibling of markLocalReplacement: evicts a turnless idle echo from the
  // output WITHOUT registering localByServerMessage (no positional 1↔1 anchoring),
  // but DOES merge its side metadata (toolSteps/attachments/tokens via
  // copyLocalMetadata) onto the authoritative row of its slot — the same echoRow
  // its content matched. The server row never changes content or presence, so this
  // can never reintroduce R1-B1 (property #1 still guards every numbered server
  // row, §6.1) and never rewrites content (loss-safety of text, §6.2). It is no
  // longer pure drop-only: it is drop of the local ∩ merge of its metadata into the
  // surviving authoritative row, so toolSteps/attachments the optimistic bubble
  // accumulated are not lost when the reconciled server row lacks them (R2-M1).
  const dropLocalEcho = (localMessage: ChatMessage, echoRow: ChatMessage) => {
    const index = existing.indexOf(localMessage)
    if (index < 0 || consumedLocalMessages.has(localMessage)) return
    consumedLocalMessages.add(localMessage)
    removed.push(localMessage)
    removedIndexes.add(index)
    if (!collapsedEchoMetadataByServerMessage.has(echoRow)) {
      collapsedEchoMetadataByServerMessage.set(echoRow, localMessage)
    }
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

  // A live optimistic bubble is the echo of a server row only when the server
  // scopes exactly one eligible row to the same task and that row is claimed by a
  // single live local — a strict bijection (decision D-1). The only thing dropped
  // is then the local echo, never the server row. Any ambiguity (D-2: two matching
  // rows, or one row contended by two locals) or missing task scope (D-3: history
  // rows arrive unscoped today) preserves every server row; the live local survives
  // as a transient duplicate that a later reconciliation collapses. No server row
  // with a turn number is ever suppressed (invariant §3 / property #1).
  const liveLocalExactMatches = new Map<ChatMessage, ChatMessage[]>()
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
    const exactTaskMatches = authoritative.filter(
      serverMessage =>
        !localByServerMessage.has(serverMessage) &&
        serverMessage.role === message.role &&
        serverMessage.task_id === message.task_id &&
        serverTurnAllowedForTurnlessLocal(serverMessage, message, index)
    )
    liveLocalExactMatches.set(message, exactTaskMatches)
  }

  // Count claimants per server row across every live local so a row contended by
  // two locals (containment) degrades to D-2 and is claimed by neither.
  const exactMatchClaimants = new Map<ChatMessage, number>()
  for (const matches of liveLocalExactMatches.values()) {
    for (const serverMessage of matches) {
      exactMatchClaimants.set(serverMessage, (exactMatchClaimants.get(serverMessage) ?? 0) + 1)
    }
  }

  for (const [message, matches] of liveLocalExactMatches) {
    if (matches.length === 1 && exactMatchClaimants.get(matches[0]!) === 1) {
      markLocalReplacement(matches[0]!, message)
    }
  }

  for (const [index, message] of existing.entries()) {
    if (messageServerTurnNumber(message) !== undefined) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.isError || message.preserveLocal || consumedLocalMessages.has(message)) continue
    if (message.task_id && options.activeTaskIds?.has(message.task_id)) continue

    const authoritativeCandidates = authoritative.filter(
      serverMessage =>
        serverMessage.role === message.role &&
        serverTurnAllowedForTurnlessLocal(serverMessage, message, index)
    )
    const candidateTurns = new Set<number>()
    for (const candidate of authoritativeCandidates) {
      candidateTurns.add(messageServerTurnNumber(candidate)!)
    }

    // Idle echo collapse, gated by content against the AUTHORITATIVE incoming row
    // that fills the neighbour slot (§6.1, R2-H1). When no incoming server row of
    // this role is free to host the idle optimistic (candidateTurns empty) AND it is
    // bracketed on both sides by numbered turns (slot saturation — the core case is
    // the consecutive same-role sandwich Q = P + 1), the bubble is the residual echo
    // of an already-materialised numbered turn. We drop it (drop-only) ONLY when its
    // content matches the AUTHORITATIVE incoming row of the same role that fills the
    // neighbour's (turn, role) slot — NOT the numbered neighbour taken from
    // `existing`, which can be stale: the row that actually lands in that output slot
    // comes from `incoming` (the first loop replaces the disk row with it), and their
    // content can diverge for the same slot (the assistant `response` evolves via
    // streaming / server-side reformat). Comparing against the stale disk neighbour
    // gives a false-equal and drops a local whose text is NOT in the output. Comparing
    // against the incoming row that actually occupies the slot makes the drop safe by
    // construction: that row survives verbatim (prop #1; preferredServerMessage never
    // rewrites content), so L's text is present in the output. We check `next` first
    // (the higher turn, the R2-H1 echo semantics) and fall back to `prev`.
    //
    // We do NOT additionally require Q = P + 1: the content-vs-authoritative gate
    // already makes every drop loss-safe, so narrowing to strict adjacency closes no
    // loss path — and it WOULD reintroduce a permanent duplicate in the saturated-gap
    // case (I-2: Q > P+1 with every in-between slot already numbered), where the echo
    // must still collapse. So the branch stays general over `candidateTurns.size === 0`.
    //
    // The content gate is what makes this safe versus a content-blind positional
    // rule: an orphan of a task that never registered a server turn (cancelled-in-
    // queue, budget-denied, persistTurnStart failure — verified in mcp-host) stays
    // turnless idle non-durable and, with divergent content, is NOT collapsed, so
    // no local text is lost. Declared residual FP: a message whose content is
    // identical to the adjacent same-role AUTHORITATIVE turn AND is an orphan of a
    // turn-less task is dropped as a visual duplicate — but its text still survives
    // verbatim in that authoritative row, so no local text is lost. The residual FP
    // is only the collapse of a duplicate bubble, unavoidable without an identity
    // discriminator the server does not provide.
    if (candidateTurns.size === 0) {
      const previousNumbered = previousNumberedMessages[index]
      const nextNumbered = nextNumberedMessages[index]
      if (previousNumbered && nextNumbered) {
        const authoritativeSlotRow = (neighbour: ChatMessage): ChatMessage | undefined => {
          const neighbourTurn = messageServerTurnNumber(neighbour)
          return authoritative.find(
            server =>
              server.role === message.role && messageServerTurnNumber(server) === neighbourTurn
          )
        }
        const nextAuthoritative = authoritativeSlotRow(nextNumbered)
        const previousAuthoritative = authoritativeSlotRow(previousNumbered)
        // Non-empty content gate (§6.2, R2-M1): strict equality would fire the
        // collapse on '' === '' / undefined === undefined, treating a text-less
        // bubble (e.g. attachment-only) as an echo. A collapse requires truthy
        // content on BOTH the local and the authoritative row — an empty bubble is
        // not a "text echo" and must survive.
        const matchesAuthoritative = (row: ChatMessage | undefined): boolean =>
          Boolean(message.content) && row?.content === message.content
        const echoRow = matchesAuthoritative(nextAuthoritative)
          ? nextAuthoritative
          : matchesAuthoritative(previousAuthoritative)
            ? previousAuthoritative
            : undefined
        if (echoRow) dropLocalEcho(message, echoRow)
      }
      continue
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

  const hydratedReplacements = authoritative.map(message => {
    const local = localByServerMessage.get(message)
    let hydrated = preferredServerMessage(message, local, { copyLocalMetadata: Boolean(local) })
    // Merge the side metadata of a collapsed idle echo onto its authoritative slot
    // row (§6.2, R2-M1). Chained after the positional local so the positional local
    // keeps precedence for any field it supplies; the collapsed echo fills the rest
    // (e.g. toolSteps/attachments the reconciled server row lacks). Content is never
    // rewritten — preferredServerMessage only touches side fields. This does NOT
    // affect localAnchorIndex: the collapse has no positional anchor of its own.
    const collapsedEcho = collapsedEchoMetadataByServerMessage.get(message)
    if (collapsedEcho) {
      hydrated = preferredServerMessage(hydrated, collapsedEcho, { copyLocalMetadata: true })
    }
    return {
      message: hydrated,
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
