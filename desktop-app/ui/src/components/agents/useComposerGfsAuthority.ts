import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { rendererEntityChangeRegistry } from '@lib/entityChangeRegistry'
import { parseHttpStatus, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'
import { hasExactGfsReadAuthority } from '@lib/gfsReadAuthority'

const PASSIVE_AUTHORITY_TTL_MS = 15_000
const MAX_PICKER_FLIGHTS = 4
const ALWAYS_AUTHORITY_ACTIVE = () => true
const IGNORE_AUTHORITY_FAILURE = () => false

export type ComposerGfsAuthorityStatus =
  | 'checking'
  | 'allowed'
  | 'denied'
  | 'error'
  | 'paused'
  | 'stale'
  | 'invalidated'
  | 'owner-invalid'

type AuthorityRecord = {
  resourceId: string
  status: ComposerGfsAuthorityStatus
  epoch: number
  desired: boolean
  queued: boolean
  dirty: boolean
  retryAt: number | null
  message: string | null
  timer: number | null
  freshUntil: number
}

type PickerOwner = {
  id: number
  sessionId: number
  scope: string
  generation: number | null
  live: boolean
  pauseUntil: number
  resumeRequired: boolean
}

type QueuedPermission = { owner: PickerOwner; resourceId: string; epoch: number }
type PhysicalPermission = { owner: PickerOwner; resourceId: string; epoch: number }

let nextPickerOwnerId = 1

function effectiveStatus(record: AuthorityRecord): ComposerGfsAuthorityStatus {
  return record.dirty && record.status === 'allowed' ? 'invalidated' : record.status
}

function retryDeadline(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (parseHttpStatus(message) !== 429) return null
  const seconds = parseRetryAfterSeconds(message)
  return Date.now() + (seconds === null ? 60_000 : Math.min(60_000, seconds * 1_000))
}

/** Picker-local permission flights; shared QueryClient affordances are never adopted. */
export function useComposerGfsAuthority(
  entries: readonly GfsBrowserChild[],
  pickerSessionId: number,
  sessionScope: string,
  sessionGeneration: number | null,
  sessionAuthorityActive = true,
  isSessionAuthorityActive: () => boolean = ALWAYS_AUTHORITY_ACTIVE,
  handleAuthorityFailure: (message: string) => boolean = IGNORE_AUTHORITY_FAILURE
) {
  const initialOwner = useRef<PickerOwner | null>(null)
  if (!initialOwner.current) {
    initialOwner.current = {
      id: nextPickerOwnerId++,
      sessionId: pickerSessionId,
      scope: sessionScope,
      generation: sessionGeneration,
      live: true,
      pauseUntil: 0,
      resumeRequired: false,
    }
  }
  const ownerRef = initialOwner
  const recordsRef = useRef(new Map<string, AuthorityRecord>())
  const physicalRef = useRef(new Set<PhysicalPermission>())
  const queueRef = useRef<QueuedPermission[]>([])
  const mountedRef = useRef(true)
  const lifecycleGenerationRef = useRef(0)
  const [revision, render] = useState(0)
  const pumpRef = useRef<() => void>(() => undefined)
  const publishRef = useRef<() => void>(() => undefined)
  const enqueueRef = useRef<(owner: PickerOwner, record: AuthorityRecord) => void>(() => undefined)

  const currentIdentityMatches =
    ownerRef.current?.live === true &&
    ownerRef.current.sessionId === pickerSessionId &&
    ownerRef.current.scope === sessionScope &&
    ownerRef.current.generation === sessionGeneration

  publishRef.current = () => {
    if (mountedRef.current && ownerRef.current?.live) render(value => value + 1)
  }

  pumpRef.current = () => {
    while (
      mountedRef.current &&
      isSessionAuthorityActive() &&
      ownerRef.current?.pauseUntil !== undefined &&
      !ownerRef.current.resumeRequired &&
      ownerRef.current.pauseUntil <= Date.now() &&
      physicalRef.current.size < MAX_PICKER_FLIGHTS &&
      queueRef.current.length > 0
    ) {
      const next = queueRef.current.shift()!
      const owner = next.owner
      const record = recordsRef.current.get(next.resourceId)
      if (!record || record.epoch !== next.epoch || !record.queued) continue
      record.queued = false
      if (!owner.live || owner !== ownerRef.current || !record.desired) continue
      record.dirty = false
      const flight: PhysicalPermission = {
        owner,
        resourceId: next.resourceId,
        epoch: next.epoch,
      }
      physicalRef.current.add(flight)
      record.status = 'checking'
      record.message = null
      publishRef.current()

      void Promise.resolve()
        .then(() => {
          const reader = window.clerum?.gfs?.affordances
          if (typeof reader !== 'function') throw new Error('Exact resource permission unavailable')
          return reader(next.resourceId, 'main')
        })
        .then(value => {
          if (!mountedRef.current || !owner.live || owner !== ownerRef.current) return
          const current = recordsRef.current.get(next.resourceId)
          if (!current || !current.desired) return
          current.status = hasExactGfsReadAuthority(value) ? 'allowed' : 'denied'
          current.message = null
          current.retryAt = null
          current.freshUntil = Date.now() + PASSIVE_AUTHORITY_TTL_MS
          if (current.timer !== null) window.clearTimeout(current.timer)
          current.timer = window.setTimeout(() => {
            current.timer = null
            if (
              !mountedRef.current ||
              !owner.live ||
              owner !== ownerRef.current ||
              !current.desired
            )
              return
            if (current.status === 'allowed' && Date.now() >= current.freshUntil) {
              current.epoch += 1
              current.status = 'stale'
              enqueueRef.current(owner, current)
              publishRef.current()
              pumpRef.current()
            }
          }, PASSIVE_AUTHORITY_TTL_MS)
        })
        .catch(error => {
          if (!mountedRef.current || !owner.live || owner !== ownerRef.current) return
          const message = error instanceof Error ? error.message : String(error)
          if (handleAuthorityFailure(message)) {
            invalidate()
            return
          }
          const current = recordsRef.current.get(next.resourceId)
          const deadline = retryDeadline(error)
          if (deadline !== null) {
            owner.pauseUntil = Math.max(owner.pauseUntil, deadline)
            owner.resumeRequired = true
            for (const queued of recordsRef.current.values()) {
              if (
                queued.queued &&
                queued.desired &&
                ['checking', 'invalidated', 'stale'].includes(queued.status)
              ) {
                queued.status = 'paused'
                queued.retryAt = owner.pauseUntil
              }
            }
          }
          if (!current) return
          if (current.epoch !== flight.epoch && deadline === null) return
          current.status = deadline === null ? 'error' : 'paused'
          current.retryAt = deadline === null ? null : owner.pauseUntil
          current.message = message
          if (deadline !== null) {
            if (current.timer !== null) window.clearTimeout(current.timer)
            current.timer = window.setTimeout(
              () => {
                current.timer = null
                if (
                  mountedRef.current &&
                  owner.live &&
                  owner === ownerRef.current &&
                  current.desired
                ) {
                  publishRef.current()
                }
              },
              Math.max(0, deadline - Date.now())
            )
          }
        })
        .finally(() => {
          physicalRef.current.delete(flight)
          const current = recordsRef.current.get(flight.resourceId)
          if (
            mountedRef.current &&
            owner.live &&
            owner === ownerRef.current &&
            current?.desired &&
            current.dirty &&
            !current.queued
          ) {
            current.epoch += 1
            if (!isSessionAuthorityActive()) {
              current.status = 'invalidated'
              current.retryAt = null
            } else if (owner.resumeRequired || owner.pauseUntil > Date.now()) {
              current.status = 'paused'
              current.retryAt = owner.pauseUntil
            } else {
              current.status = 'checking'
              enqueueRef.current(owner, current)
            }
          }
          if (mountedRef.current && owner.live && owner === ownerRef.current) publishRef.current()
          pumpRef.current()
        })
    }
  }

  const enqueue = (owner: PickerOwner, record: AuthorityRecord) => {
    if (
      !mountedRef.current ||
      !isSessionAuthorityActive() ||
      !owner.live ||
      owner !== ownerRef.current ||
      !record.desired ||
      record.queued
    )
      return
    queueRef.current = queueRef.current.filter(
      entry => entry.owner !== owner || entry.resourceId !== record.resourceId
    )
    record.queued = true
    queueRef.current.push({ owner, resourceId: record.resourceId, epoch: record.epoch })
  }
  enqueueRef.current = enqueue

  useEffect(() => {
    const previous = ownerRef.current
    if (
      previous &&
      (previous.sessionId !== pickerSessionId ||
        previous.scope !== sessionScope ||
        previous.generation !== sessionGeneration)
    ) {
      previous.live = false
      for (const record of recordsRef.current.values()) {
        if (record.timer !== null) window.clearTimeout(record.timer)
      }
      recordsRef.current = new Map()
      queueRef.current = []
      ownerRef.current = {
        id: nextPickerOwnerId++,
        sessionId: pickerSessionId,
        scope: sessionScope,
        generation: sessionGeneration,
        live: true,
        pauseUntil: 0,
        resumeRequired: false,
      }
      publishRef.current()
    }
  }, [pickerSessionId, sessionGeneration, sessionScope])

  useEffect(() => {
    mountedRef.current = true
    const lifecycleGeneration = ++lifecycleGenerationRef.current
    return () => {
      mountedRef.current = false
      queueMicrotask(() => {
        if (mountedRef.current || lifecycleGenerationRef.current !== lifecycleGeneration) return
        const owner = ownerRef.current
        if (!owner) return
        owner.live = false
        queueRef.current = queueRef.current.filter(entry => entry.owner !== owner)
        for (const record of recordsRef.current.values()) {
          if (record.timer !== null) window.clearTimeout(record.timer)
        }
        recordsRef.current.clear()
      })
    }
  }, [])

  const resourceIds = useMemo(
    () => Array.from(new Set(entries.map(entry => entry.resourceId))),
    [entries]
  )
  const invalidate = useCallback(() => {
    const owner = ownerRef.current
    if (!mountedRef.current || !owner?.live) return
    queueRef.current = queueRef.current.filter(entry => entry.owner !== owner)
    for (const record of recordsRef.current.values()) {
      record.epoch += 1
      record.queued = false
      record.status = 'invalidated'
      record.message = null
      record.retryAt = null
      record.dirty = Array.from(physicalRef.current).some(
        flight => flight.owner === owner && flight.resourceId === record.resourceId
      )
    }
    publishRef.current()
  }, [])

  useEffect(() => {
    const owner = ownerRef.current
    if (
      !mountedRef.current ||
      !owner?.live ||
      owner.sessionId !== pickerSessionId ||
      owner.scope !== sessionScope ||
      owner.generation !== sessionGeneration
    )
      return
    if (!sessionAuthorityActive) {
      invalidate()
      return
    }
    const wanted = new Set(resourceIds)
    for (const record of recordsRef.current.values()) record.desired = wanted.has(record.resourceId)
    for (const resourceId of resourceIds) {
      let record = recordsRef.current.get(resourceId)
      if (!record) {
        record = {
          resourceId,
          status: owner.resumeRequired || owner.pauseUntil > Date.now() ? 'paused' : 'checking',
          epoch: 0,
          desired: true,
          queued: false,
          dirty: false,
          retryAt: owner.resumeRequired || owner.pauseUntil > Date.now() ? owner.pauseUntil : null,
          message: null,
          timer: null,
          freshUntil: 0,
        }
        recordsRef.current.set(resourceId, record)
        enqueueRef.current(owner, record)
      } else {
        record.desired = true
        if (record.status === 'allowed' && Date.now() >= record.freshUntil) {
          record.status = 'stale'
        }
        if (record.status === 'invalidated' || record.status === 'stale') {
          const flightPending = Array.from(physicalRef.current).some(
            flight => flight.owner === owner && flight.resourceId === resourceId
          )
          const paused = owner.resumeRequired || owner.pauseUntil > Date.now()
          record.status = paused ? 'paused' : 'checking'
          record.retryAt = paused ? owner.pauseUntil : null
          if (flightPending) {
            record.dirty = true
          } else {
            record.dirty = false
            enqueueRef.current(owner, record)
          }
        }
        if (
          record.status === 'checking' &&
          !record.queued &&
          !Array.from(physicalRef.current).some(
            flight => flight.owner === owner && flight.resourceId === resourceId
          )
        ) {
          if (owner.resumeRequired || owner.pauseUntil > Date.now()) {
            record.status = 'paused'
            record.retryAt = owner.pauseUntil
          }
          enqueueRef.current(owner, record)
        }
      }
    }
    publishRef.current()
    pumpRef.current()
  }, [
    invalidate,
    handleAuthorityFailure,
    isSessionAuthorityActive,
    pickerSessionId,
    resourceIds,
    sessionAuthorityActive,
    sessionGeneration,
    sessionScope,
  ])

  useEffect(() => {
    return rendererEntityChangeRegistry.subscribe(['gfs', 'authorization'], event => {
      const owner = ownerRef.current
      if (!mountedRef.current || !owner?.live) return
      if (event.type === 'scope.invalidated' || event.type === 'resync_required') {
        for (const record of recordsRef.current.values()) {
          record.queued = false
          record.epoch += 1
          record.status = owner.resumeRequired ? 'paused' : 'invalidated'
          record.message = null
          record.retryAt = owner.resumeRequired ? owner.pauseUntil : null
          if (
            Array.from(physicalRef.current).some(
              flight => flight.owner === owner && flight.resourceId === record.resourceId
            )
          ) {
            record.dirty = true
          } else if (record.desired) {
            enqueueRef.current(owner, record)
          }
        }
        publishRef.current()
        pumpRef.current()
      }
    })
  }, [])

  const retry = useCallback((resourceId: string) => {
    const owner = ownerRef.current
    const record = recordsRef.current.get(resourceId)
    if (!mountedRef.current || !owner?.live || !record?.desired) return false
    if (!['denied', 'error', 'paused'].includes(record.status)) return false
    if (owner.resumeRequired && Date.now() < owner.pauseUntil) return false
    const queuedEpoch = record.epoch
    record.epoch += 1
    record.status = 'checking'
    record.retryAt = null
    record.message = null
    if (owner.resumeRequired) owner.resumeRequired = false
    owner.pauseUntil = 0
    for (const queued of recordsRef.current.values()) {
      if (queued.queued && queued.desired && queued.status === 'paused') {
        queued.status = 'checking'
        queued.retryAt = null
      }
    }
    if (record.queued) {
      const queued = queueRef.current.find(
        entry =>
          entry.owner === owner &&
          entry.resourceId === record.resourceId &&
          entry.epoch === queuedEpoch
      )
      if (queued) {
        queued.epoch = record.epoch
      } else {
        record.queued = false
        enqueueRef.current(owner, record)
      }
    } else {
      enqueueRef.current(owner, record)
    }
    publishRef.current()
    pumpRef.current()
    return true
  }, [])

  const authorityByResourceId = useMemo(() => {
    if (!currentIdentityMatches || !sessionAuthorityActive)
      return new Map<string, ComposerGfsAuthorityStatus>()
    return new Map(
      Array.from(recordsRef.current.entries()).map(([id, record]) => [id, effectiveStatus(record)])
    )
  }, [
    currentIdentityMatches,
    entries,
    pickerSessionId,
    revision,
    sessionAuthorityActive,
    sessionGeneration,
    sessionScope,
  ])

  const isCurrentlyAllowed = useCallback(
    (resourceId: string) => {
      const owner = ownerRef.current
      const record = recordsRef.current.get(resourceId)
      return Boolean(
        mountedRef.current &&
        isSessionAuthorityActive() &&
        owner?.live &&
        owner.sessionId === pickerSessionId &&
        owner.scope === sessionScope &&
        owner.generation === sessionGeneration &&
        record?.desired &&
        effectiveStatus(record) === 'allowed' &&
        Date.now() < record.freshUntil
      )
    },
    [isSessionAuthorityActive, pickerSessionId, sessionGeneration, sessionScope]
  )

  return { authorityByResourceId, invalidate, isCurrentlyAllowed, retry }
}
