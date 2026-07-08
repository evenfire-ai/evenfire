import { useCallback, useEffect, useRef, useState } from 'react'
import { COMPOSER_MAX_IMAGE_ATTACHMENTS } from '@constants/attachments'
import { clearComposerDraft, clearComposerDraftAfterSend } from '@lib/composerDraftStore'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '../../uiTypes'

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

  const revokeComposerPreviewUrls = useCallback((attachments: ComposerImageAttachment[]) => {
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
    setComposerImageAttachments(previous => {
      revokeComposerPreviewUrls(previous)
      return []
    })
  }, [revokeComposerPreviewUrls])

  /** Clear BOTH pending attachment kinds (revoking image blob URLs). */
  const resetComposerAttachments = useCallback(() => {
    clearComposerImageAttachments()
    setComposerReferenceAttachments([])
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
        return next
      })
      clearSendError()
    },
    [clearSendError, revokeComposerPreviewUrls]
  )

  const handleUpdateComposerImageAttachment = useCallback(
    (attachment: ComposerImageAttachment) => {
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
        return next
      })
      clearSendError()
    },
    [clearSendError, revokeComposerPreviewUrls]
  )

  const handleRemoveComposerImageAttachment = useCallback(
    (attachmentId: string) => {
      setComposerImageAttachments(previous => {
        const removed = previous.filter(att => att.id === attachmentId)
        if (removed.length) {
          revokeComposerPreviewUrls(removed)
        }
        return previous.filter(att => att.id !== attachmentId)
      })
    },
    [revokeComposerPreviewUrls]
  )

  const handleAddComposerReferenceAttachments = useCallback(
    (attachments: ComposerReferenceAttachment[]) => {
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
        return next
      })
      clearSendError()
    },
    [clearSendError]
  )

  const handleRemoveComposerReferenceAttachment = useCallback((attachmentId: string) => {
    setComposerReferenceAttachments(previous => previous.filter(att => att.id !== attachmentId))
  }, [])

  return {
    composerImageAttachments,
    composerReferenceAttachments,
    resetComposerAttachments,
    clearComposerAfterSend,
    clearComposerDraft,
    handleAddComposerImageAttachments,
    handleUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment,
    handleAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment,
  }
}
