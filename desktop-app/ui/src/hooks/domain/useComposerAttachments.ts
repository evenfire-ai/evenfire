import { useCallback, useEffect, useRef, useState } from 'react'
import { COMPOSER_MAX_IMAGE_ATTACHMENTS } from '@constants/attachments'
import { clearComposerDraft, clearComposerDraftAfterSend } from '@lib/composerDraftStore'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '../../uiTypes'

export interface ComposerImageMergeOutcome {
  /** The reconciled composer set (existing + accepted incoming, in order). */
  next: ComposerImageAttachment[]
  /** Incoming attachments that took a slot in the composer. */
  kept: number
  /** Incoming byte-identical copies of attachments already held (not added). */
  duplicates: number
  /** Incoming attachments the 20-image cap leaves no room for (lost). */
  dropped: number
}

/**
 * Reconciles incoming images into the composer's image set with the same
 * dedupe/cap rules as the add handler, returning the merged set AND the
 * counts. The restore path calls this against the live composer snapshot and
 * commits the returned `next` directly, so the reported counts can never
 * disagree with the state the user sees (spec: restore semantics).
 */
export function mergeComposerImageAttachments(
  existing: ComposerImageAttachment[],
  incoming: ComposerImageAttachment[],
  nextOrder: () => number = () => 0
): ComposerImageMergeOutcome {
  const accepted = [...existing]
  let kept = 0
  let duplicates = 0
  for (const attachment of incoming) {
    if (accepted.length >= COMPOSER_MAX_IMAGE_ATTACHMENTS) break
    const duplicate = accepted.some(
      candidate =>
        candidate.mimeType === attachment.mimeType &&
        candidate.sizeBytes === attachment.sizeBytes &&
        candidate.dataBase64 === attachment.dataBase64
    )
    if (duplicate) {
      duplicates += 1
      continue
    }
    accepted.push(
      attachment.addedOrder != null ? attachment : { ...attachment, addedOrder: nextOrder() }
    )
    kept += 1
  }
  return { next: accepted, kept, duplicates, dropped: incoming.length - kept - duplicates }
}

interface UseComposerAttachmentsParams {
  /** Attachments are per-agent; switching agents clears the pending composer. */
  selectedAgent: string | null
  /**
   * Called when the user ADDS or UPDATES an attachment so the parent can clear a
   * stale send-error/resend banner (mirrors the pre-extraction behavior where the
   * add/update handlers cleared `agentError`/`failedAgentSend`). Removals do NOT
   * call this (parity with the original handlers).
   */
  clearSendError: () => void
}

/**
 * Owns the composer's pending image + reference attachments (cap/dedupe/order via
 * `composerAttachmentOrderRef`), blob-preview-URL revocation, per-agent cleanup,
 * and the composer-draft-store integration. Extracted from `useAgentChatController`
 * (Fase 1) with NO observable behavior change — the parent composes this and
 * re-exposes the same public handlers to consumers.
 *
 * The ref mirrors (`composerImageAttachmentsRef` / `composerReferenceAttachmentsRef`)
 * are written inside every state updater, so they always reflect the committed
 * transitions — never a stale render closure. The cancel-restore path reads and
 * writes through them so its reconciliation and its drop reporting use ONE
 * snapshot (R1-M4).
 */
export function useComposerAttachments({
  selectedAgent,
  clearSendError,
}: UseComposerAttachmentsParams) {
  const [composerImageAttachments, setComposerImageAttachments] = useState<
    ComposerImageAttachment[]
  >([])
  const [composerReferenceAttachments, setComposerReferenceAttachments] = useState<
    ComposerReferenceAttachment[]
  >([])
  const composerAttachmentOrderRef = useRef(0)
  const composerAttachmentRevisionRef = useRef(0)
  const composerImageAttachmentsRef = useRef<ComposerImageAttachment[]>([])
  const composerReferenceAttachmentsRef = useRef<ComposerReferenceAttachment[]>([])

  const revokeComposerPreviewUrls = useCallback((attachments: ComposerImageAttachment[]) => {
    composerAttachmentRevisionRef.current += 1
    const canRevokeObjectUrl =
      typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function'
    if (!canRevokeObjectUrl) return
    for (const attachment of attachments) {
      if (
        typeof attachment.previewDataUrl === 'string' &&
        attachment.previewDataUrl.startsWith('blob:')
      ) {
        URL.revokeObjectURL(attachment.previewDataUrl)
      }
    }
  }, [])

  const clearComposerImageAttachments = useCallback(() => {
    composerAttachmentRevisionRef.current += 1
    setComposerImageAttachments(previous => {
      revokeComposerPreviewUrls(previous)
      composerImageAttachmentsRef.current = []
      return []
    })
  }, [revokeComposerPreviewUrls])

  /** Clear BOTH pending attachment kinds (revoking image blob URLs). */
  const resetComposerAttachments = useCallback(() => {
    clearComposerImageAttachments()
    setComposerReferenceAttachments(previous => {
      composerReferenceAttachmentsRef.current = []
      return []
    })
  }, [clearComposerImageAttachments])

  /** Post-send cleanup: clear the persisted draft for this chat, then the pending
   *  attachments. Combines the three original send-path calls into one. */
  const clearComposerAfterSend = useCallback(
    (chatId: string | null) => {
      clearComposerDraftAfterSend(chatId)
      resetComposerAttachments()
    },
    [resetComposerAttachments]
  )

  // Clear pending attachments when the selected agent changes (attachments are
  // per-agent). The parent clears its own error/resend banner on the same change.
  useEffect(() => {
    resetComposerAttachments()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- match the agent-change
    // reset semantics of the original single effect (fires on selectedAgent only).
  }, [selectedAgent])

  const handleAddComposerImageAttachments = useCallback(
    (attachments: ComposerImageAttachment[]) => {
      composerAttachmentRevisionRef.current += 1
      if (!attachments.length) return
      setComposerImageAttachments(previous => {
        const next = [...previous]
        for (const attachment of attachments) {
          if (next.length >= COMPOSER_MAX_IMAGE_ATTACHMENTS) {
            revokeComposerPreviewUrls([attachment])
            continue
          }
          const duplicate = next.some(
            existing =>
              existing.mimeType === attachment.mimeType &&
              existing.sizeBytes === attachment.sizeBytes &&
              existing.dataBase64 === attachment.dataBase64
          )
          if (duplicate) {
            revokeComposerPreviewUrls([attachment])
            continue
          }
          composerAttachmentOrderRef.current += 1
          next.push({
            ...attachment,
            addedOrder: attachment.addedOrder ?? composerAttachmentOrderRef.current,
          })
        }
        composerImageAttachmentsRef.current = next
        return next
      })
      clearSendError()
    },
    [clearSendError, revokeComposerPreviewUrls]
  )

  const handleUpdateComposerImageAttachment = useCallback(
    (attachment: ComposerImageAttachment) => {
      composerAttachmentRevisionRef.current += 1
      setComposerImageAttachments(previous => {
        const index = previous.findIndex(item => item.id === attachment.id)
        if (index === -1) {
          revokeComposerPreviewUrls([attachment])
          return previous
        }
        const current = previous[index]!
        if (current.previewDataUrl !== attachment.previewDataUrl) {
          revokeComposerPreviewUrls([current])
        }
        const next = [...previous]
        next[index] = attachment
        composerImageAttachmentsRef.current = next
        return next
      })
      clearSendError()
    },
    [clearSendError, revokeComposerPreviewUrls]
  )

  const handleRemoveComposerImageAttachment = useCallback(
    (attachmentId: string) => {
      composerAttachmentRevisionRef.current += 1
      setComposerImageAttachments(previous => {
        const removed = previous.filter(att => att.id === attachmentId)
        if (removed.length) {
          revokeComposerPreviewUrls(removed)
        }
        const next = previous.filter(att => att.id !== attachmentId)
        composerImageAttachmentsRef.current = next
        return next
      })
    },
    [revokeComposerPreviewUrls]
  )

  /**
   * Restore-path reconciliation for images (R1-M4): one merge against the live
   * snapshot (the ref mirror written by every committed transition), committed
   * directly, returning the counts that describe exactly that snapshot.
   */
  const restoreComposerImageAttachments = useCallback(
    (incoming: ComposerImageAttachment[]): ComposerImageMergeOutcome => {
      composerAttachmentRevisionRef.current += 1
      const outcome = mergeComposerImageAttachments(
        composerImageAttachmentsRef.current,
        incoming,
        () => {
          composerAttachmentOrderRef.current += 1
          return composerAttachmentOrderRef.current
        }
      )
      for (const attachment of incoming) {
        if (!outcome.next.includes(attachment)) revokeComposerPreviewUrls([attachment])
      }
      composerImageAttachmentsRef.current = outcome.next
      setComposerImageAttachments(outcome.next)
      clearSendError()
      return outcome
    },
    [clearSendError, revokeComposerPreviewUrls]
  )

  const handleAddComposerReferenceAttachments = useCallback(
    (attachments: ComposerReferenceAttachment[]) => {
      composerAttachmentRevisionRef.current += 1
      if (!attachments.length) return
      setComposerReferenceAttachments(previous => {
        const next = [...previous]
        for (const attachment of attachments) {
          if (!next.some(existing => existing.id === attachment.id)) {
            composerAttachmentOrderRef.current += 1
            next.push({
              ...attachment,
              addedOrder: attachment.addedOrder ?? composerAttachmentOrderRef.current,
            })
          }
        }
        composerReferenceAttachmentsRef.current = next
        return next
      })
      clearSendError()
    },
    [clearSendError]
  )

  const handleRemoveComposerReferenceAttachment = useCallback(
    (attachmentId: string) => {
      composerAttachmentRevisionRef.current += 1
      setComposerReferenceAttachments(previous => {
        const next = previous.filter(att => att.id !== attachmentId)
        composerReferenceAttachmentsRef.current = next
        return next
      })
      // Removing a file is how the user answers the "at most 10 files" refusal,
      // so the refusal must not stay on screen afterwards.
      clearSendError()
    },
    [clearSendError]
  )

  return {
    composerImageAttachments,
    composerAttachmentRevisionRef,
    composerReferenceAttachments,
    resetComposerAttachments,
    clearComposerAfterSend,
    clearComposerDraft,
    handleAddComposerImageAttachments,
    handleUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment,
    handleAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment,
    restoreComposerImageAttachments,
  }
}
