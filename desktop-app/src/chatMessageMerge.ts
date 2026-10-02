import type { ChatMessage, ChatMessageAttachment } from './types.js'

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

function attachmentName(attachment: ChatMessageAttachment): string {
  return (attachment.filename || attachment.label).trim()
}

type AttachmentRule = { identified: 'enrich' | 'server'; contentEcho: 'unique' | 'retain' }

/** Mirrors work-tracker/specs/attachment-reconciliation-provenance.md. */
const ATTACHMENT_RULES: Record<ChatMessageAttachment['type'], AttachmentRule> = {
  uploaded_file: { identified: 'enrich', contentEcho: 'retain' },
  global_file: { identified: 'enrich', contentEcho: 'retain' },
  agent_file: { identified: 'enrich', contentEcho: 'retain' },
  response_file: { identified: 'enrich', contentEcho: 'unique' },
  plugin: { identified: 'server', contentEcho: 'retain' },
  connector: { identified: 'server', contentEcho: 'retain' },
}

function attachmentIdentitiesConflict(
  server: ChatMessageAttachment,
  local: ChatMessageAttachment
): boolean {
  if (server.type === 'global_file' && local.type === 'global_file') {
    return Boolean(
      (server.gfsUri && local.gfsUri && server.gfsUri !== local.gfsUri) ||
      (server.version !== undefined &&
        local.version !== undefined &&
        server.version !== local.version)
    )
  }
  if (server.type === 'agent_file' && local.type === 'agent_file') {
    return Boolean(
      server.filesystemName &&
      local.filesystemName &&
      server.path &&
      local.path &&
      (server.filesystemName !== local.filesystemName || server.path !== local.path)
    )
  }
  return false
}

function sameStructuredAttachmentIdentity(
  server: ChatMessageAttachment,
  local: ChatMessageAttachment
): boolean {
  if (server.type === 'global_file' && local.type === 'global_file') {
    return Boolean(server.gfsUri && server.gfsUri === local.gfsUri)
  }
  if (server.type === 'agent_file' && local.type === 'agent_file') {
    return Boolean(
      server.filesystemName &&
      server.path &&
      server.filesystemName === local.filesystemName &&
      server.path === local.path
    )
  }
  return false
}

function enrichIdentifiedAttachment(
  server: ChatMessageAttachment,
  local: ChatMessageAttachment
): ChatMessageAttachment {
  if (server.type === 'global_file') {
    if (
      !local.gfsUri ||
      !Number.isSafeInteger(local.version) ||
      !Number.isSafeInteger(local.bytes) ||
      (server.version !== undefined && server.version !== local.version)
    ) {
      return server
    }
    return {
      ...server,
      gfsUri: server.gfsUri ?? local.gfsUri,
      drive: server.drive ?? local.drive,
      resourceId: server.resourceId ?? local.resourceId,
      version: server.version ?? local.version,
      bytes: server.bytes ?? local.bytes,
    }
  }
  if (server.type === 'agent_file') {
    if (!local.filesystemName || !local.path) return server
    return {
      ...server,
      filesystemName: server.filesystemName ?? local.filesystemName,
      path: server.path ?? local.path,
    }
  }
  if (!local.dataBase64) return server
  return {
    ...server,
    filename: server.filename ?? local.filename,
    mimeType: server.mimeType ?? local.mimeType,
    encoding: server.encoding ?? local.encoding,
    dataBase64: server.dataBase64 ?? local.dataBase64,
    sizeBytes: server.sizeBytes ?? local.sizeBytes,
  }
}

/** Keep server chips in order while pairing names only within an identified turn. */
function mergeAttachmentChips(
  server: ChatMessageAttachment[] | undefined,
  local: ChatMessageAttachment[] | undefined
): ChatMessageAttachment[] | undefined {
  if (!server?.length) return local
  if (!local?.length) return server

  const matchedLocalIndexes = new Set<number>()
  const localIndexByServerIndex = new Map<number, number>()
  const pair = (serverIndex: number, predicate: (attachment: ChatMessageAttachment) => boolean) => {
    const localIndex = local.findIndex(
      (attachment, index) =>
        !matchedLocalIndexes.has(index) &&
        ATTACHMENT_RULES[attachment.type].identified === 'enrich' &&
        !attachmentIdentitiesConflict(server[serverIndex]!, attachment) &&
        predicate(attachment)
    )
    if (localIndex < 0) return
    matchedLocalIndexes.add(localIndex)
    localIndexByServerIndex.set(serverIndex, localIndex)
  }

  // Stable IDs win even when the server changes a display label.
  server.forEach((attachment, index) => {
    pair(index, candidate => candidate.type === attachment.type && candidate.id === attachment.id)
  })
  server.forEach((attachment, index) => {
    if (localIndexByServerIndex.has(index)) return
    pair(index, candidate => sameStructuredAttachmentIdentity(attachment, candidate))
  })
  // Parsed server IDs differ from optimistic IDs. Pair the remaining chips by
  // type + name in order, including collisions such as two "photo.png" images.
  server.forEach((attachment, index) => {
    if (localIndexByServerIndex.has(index)) return
    const name = attachmentName(attachment)
    if (name) {
      pair(
        index,
        candidate => candidate.type === attachment.type && attachmentName(candidate) === name
      )
    }
  })

  const merged = server.map((attachment, index) => {
    const localIndex = localIndexByServerIndex.get(index)
    const match = localIndex === undefined ? undefined : local[localIndex]
    return match ? enrichIdentifiedAttachment(attachment, match) : attachment
  })
  return [
    ...merged,
    ...local.filter(
      (attachment, index) =>
        !matchedLocalIndexes.has(index) && ATTACHMENT_RULES[attachment.type].identified === 'enrich'
    ),
  ]
}

function contentEchoIsUnique(
  local: ChatMessage,
  authoritative: ChatMessage[],
  existing: ChatMessage[]
): boolean {
  const serverSlots = new Map<string, ChatMessage>()
  for (const row of [...existing, ...authoritative]) {
    if (messageServerTurnNumber(row) !== undefined) serverSlots.set(serverSlotKey(row), row)
  }
  const matchingSlots = [...serverSlots.values()].filter(
    row => row.role === local.role && row.content === local.content
  )
  const matchingLocals = existing.filter(
    row =>
      messageServerTurnNumber(row) === undefined &&
      row.role === local.role &&
      row.content === local.content &&
      !row.isError &&
      !row.preserveLocal
  )
  return matchingSlots.length === 1 && matchingLocals.length === 1
}

function contentEchoMayCollapse(local: ChatMessage, unique: boolean): boolean {
  if (
    local.attachments?.some(
      attachment => ATTACHMENT_RULES[attachment.type].contentEcho === 'retain' || !unique
    )
  ) {
    return false
  }
  return unique || !local.toolSteps?.length
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
    attachments: mergeAttachmentChips(server.attachments, local.attachments),
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
  const identifiedServerMessages = new Set<ChatMessage>()
  // Eligible output artifacts and tool steps from a uniquely owned idle echo.
  // A content-only collapse cannot establish attachment or task identity.
  const collapsedEchoMetadataByServerMessage = new Map<ChatMessage, ChatMessage>()
  const consumedLocalMessages = new Set<ChatMessage>()

  const markLocalReplacement = (
    serverMessage: ChatMessage,
    localMessage: ChatMessage,
    identified: boolean
  ) => {
    const index = existing.indexOf(localMessage)
    if (index < 0 || consumedLocalMessages.has(localMessage)) return
    consumedLocalMessages.add(localMessage)
    removed.push(localMessage)
    removedIndexes.add(index)
    removedIndexByMessage.set(localMessage, index)
    localByServerMessage.set(serverMessage, localMessage)
    if (identified) identifiedServerMessages.add(serverMessage)
  }

  // Remove a proven unique text echo without treating it as an identified
  // replacement. Only attachment classes allowed by the decision table reach
  // this path; its metadata cannot become a positional anchor or a task ID.
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
    if (sameSlot) markLocalReplacement(serverMessage, sameSlot, true)
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
      markLocalReplacement(matches[0]!, message, true)
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
    // of an already-materialised numbered turn. We collapse it ONLY when its
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
        if (
          echoRow &&
          contentEchoMayCollapse(message, contentEchoIsUnique(message, authoritative, existing))
        ) {
          dropLocalEcho(message, echoRow)
        }
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
    // A free positional slot can dedupe plain optimistic text, but it does
    // not establish ownership for attachments or tool steps.
    if (message.attachments?.length || message.toolSteps?.length) continue
    markLocalReplacement(candidates[0]!, message, false)
  }

  const hydratedReplacements = authoritative.map(message => {
    const local = localByServerMessage.get(message)
    let hydrated = preferredServerMessage(message, local, {
      copyLocalMetadata: identifiedServerMessages.has(message),
    })
    // A unique content-only collapse may carry output artifacts and tool steps.
    // Images and input references never reach this path, and no task ID or
    // positional anchor is copied from the echo.
    const collapsedEcho = collapsedEchoMetadataByServerMessage.get(message)
    if (collapsedEcho) {
      hydrated = {
        ...hydrated,
        attachments: mergeAttachmentChips(hydrated.attachments, collapsedEcho.attachments),
        toolSteps: hydrated.toolSteps?.length ? hydrated.toolSteps : collapsedEcho.toolSteps,
      }
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
