import { useCallback, useEffect, useRef, useState } from 'react'
import { COMPOSER_MAX_ATTACHMENTS } from '@constants/attachments'
import { clearComposerDraft, clearComposerDraftAfterSend } from '@lib/composerDraftStore'
import {
  composerFileAdmissionError,
  composerFileName,
  readComposerFile,
} from '@lib/composerFileAdmission'
import { buildComposerFileReferences } from '@lib/composerFileReferences'
import { composerRequestBaseContent } from '@lib/composerHostRequest'
import { buildComposerRequestContent } from '@lib/composerReferencesPrompt'
import type {
  ComposerFileAttachment,
  ComposerFileRefusal,
  ComposerImageAttachment,
  ComposerReferenceAttachment,
} from '../../uiTypes'

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
  const [composerFileAttachments, setComposerFileAttachments] = useState<ComposerFileAttachment[]>(
    []
  )
  const [composerFileRefusals, setComposerFileRefusals] = useState<ComposerFileRefusal[]>([])
  const composerAttachmentOrderRef = useRef(0)
  const composerAttachmentRevisionRef = useRef(0)
  // Mirrors of the state above. Admission of a file and the completion of its
  // asynchronous read decide from the latest attachments, not from the render
  // that started them.
  const composerFilesRef = useRef<ComposerFileAttachment[]>([])
  const composerImagesRef = useRef<ComposerImageAttachment[]>([])
  const composerReferencesRef = useRef<ComposerReferenceAttachment[]>([])
  composerReferencesRef.current = composerReferenceAttachments

  const commitComposerFiles = useCallback(
    (update: (previous: ComposerFileAttachment[]) => ComposerFileAttachment[]) => {
      const next = update(composerFilesRef.current)
      composerFilesRef.current = next
      setComposerFileAttachments(next)
    },
    []
  )

  // Images and files share one per-message count, so both mirrors must hold
  // what a gesture has already added before its next attach is decided.
  const commitComposerImages = useCallback(
    (update: (previous: ComposerImageAttachment[]) => ComposerImageAttachment[]) => {
      const next = update(composerImagesRef.current)
      composerImagesRef.current = next
      setComposerImageAttachments(next)
    },
    []
  )

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
    commitComposerImages(previous => {
      revokeComposerPreviewUrls(previous)
      return []
    })
  }, [commitComposerImages, revokeComposerPreviewUrls])

  const clearComposerFileAttachments = useCallback(() => {
    composerAttachmentRevisionRef.current += 1
    // A read still in flight finds no entry for its id and is dropped.
    commitComposerFiles(() => [])
  }, [commitComposerFiles])

  /** Clear every pending attachment kind (revoking image blob URLs). */
  const resetComposerAttachments = useCallback(() => {
    clearComposerImageAttachments()
    clearComposerFileAttachments()
    setComposerFileRefusals([])
    setComposerReferenceAttachments([])
  }, [clearComposerFileAttachments, clearComposerImageAttachments])

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
      // The documents of the same gesture were routed first and replaced the
      // notices; an image refused here is added to them, never replaces them.
      const refusals: ComposerFileRefusal[] = []
      commitComposerImages(previous => {
        const next = [...previous]
        for (const attachment of attachments) {
          // Images and files share one per-message count.
          if (next.length + composerFilesRef.current.length >= COMPOSER_MAX_ATTACHMENTS) {
            revokeComposerPreviewUrls([attachment])
            refusals.push({
              id: attachment.id,
              text: `"${attachment.name}" was not attached: a message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`,
            })
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
      if (refusals.length) setComposerFileRefusals(previous => [...previous, ...refusals])
      clearSendError()
    },
    [clearSendError, commitComposerImages, revokeComposerPreviewUrls]
  )

  const handleUpdateComposerImageAttachment = useCallback(
    (attachment: ComposerImageAttachment) => {
      composerAttachmentRevisionRef.current += 1
      commitComposerImages(previous => {
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
    [clearSendError, commitComposerImages, revokeComposerPreviewUrls]
  )

  const handleRemoveComposerImageAttachment = useCallback(
    (attachmentId: string) => {
      composerAttachmentRevisionRef.current += 1
      commitComposerImages(previous => {
        const removed = previous.filter(att => att.id === attachmentId)
        if (removed.length) {
          revokeComposerPreviewUrls(removed)
        }
        return previous.filter(att => att.id !== attachmentId)
      })
      // Images and files share one per-message count, so removing an image
      // frees a slot and a refusal such as the attachment count is stale.
      setComposerFileRefusals([])
    },
    [commitComposerImages, revokeComposerPreviewUrls]
  )

  /**
   * Adds picked documents (#678). Each accepted file appears at once as
   * `reading` and becomes `ready` when its bytes are read and hashed. A file
   * that breaks a limit, or cannot be read, gets no chip: its reason is shown
   * as a refusal notice instead, so a refusal is never silent. The composer
   * calls this once per gesture, with `[]` when the gesture carried only
   * images, so each gesture replaces the refusals of the previous one; images
   * of the same gesture refused later add to them.
   */
  const handleAddComposerFiles = useCallback(
    (files: File[], draft: string) => {
      composerAttachmentRevisionRef.current += 1
      const refusals: ComposerFileRefusal[] = []
      if (!files.length) {
        setComposerFileRefusals(refusals)
        return
      }
      // Admission measures the request the files would be sent with: the
      // content with its references section, the structured references and the
      // agent it is posted to. Without an agent, or with references the send
      // itself would refuse, no file can be admitted.
      const images = composerImagesRef.current
      const references = composerReferencesRef.current
      let referencesProblem: string | null = null
      let fileReferences: ReturnType<typeof buildComposerFileReferences> = []
      try {
        fileReferences = buildComposerFileReferences(references)
      } catch (error) {
        referencesProblem = error instanceof Error ? error.message : String(error)
      }
      for (const file of files) {
        const id = crypto.randomUUID()
        const current = composerFilesRef.current
        const error =
          selectedAgent === null
            ? 'Select an agent before attaching files.'
            : (referencesProblem ??
              composerFileAdmissionError(file, {
                attachedCount: images.length + current.length,
                files: current,
                request: {
                  content: buildComposerRequestContent(
                    composerRequestBaseContent(draft.trim(), images.length, current.length + 1),
                    references
                  ),
                  fileReferences,
                  hostRef: selectedAgent,
                  images,
                },
              }))
        composerAttachmentOrderRef.current += 1
        const base = {
          id,
          addedOrder: composerAttachmentOrderRef.current,
          type: 'file' as const,
          filename: composerFileName(file),
          sizeBytes: file.size,
          declaredMediaType: file.type,
        }
        if (error) {
          refusals.push({ id, text: error })
          continue
        }
        commitComposerFiles(previous => [...previous, { ...base, status: 'reading' }])
        void readComposerFile(file, id).then(result => {
          // A file removed while it was read (by the user, a send or an agent
          // change) leaves neither a chip nor a notice.
          if (!composerFilesRef.current.some(item => item.id === id)) return
          if (result.status === 'failed') {
            commitComposerFiles(previous => previous.filter(item => item.id !== id))
            setComposerFileRefusals(previous => [...previous, { id, text: result.error }])
            return
          }
          // The same bytes under the same name are one document: the second copy
          // leaves no chip, and the user is told why it did not appear.
          const duplicate = composerFilesRef.current.some(
            item =>
              item.id !== id &&
              item.status === 'ready' &&
              item.filename === result.filename &&
              item.digestHex === result.digestHex
          )
          if (duplicate) {
            commitComposerFiles(previous => previous.filter(item => item.id !== id))
            setComposerFileRefusals(previous => [
              ...previous,
              { id, text: `"${result.filename}" is already attached.` },
            ])
            return
          }
          commitComposerFiles(previous =>
            previous.map(item =>
              item.id === id ? { ...result, addedOrder: item.addedOrder } : item
            )
          )
        })
      }
      setComposerFileRefusals(refusals)
      clearSendError()
    },
    [clearSendError, commitComposerFiles, selectedAgent]
  )

  const handleRemoveComposerFileAttachment = useCallback(
    (attachmentId: string) => {
      composerAttachmentRevisionRef.current += 1
      commitComposerFiles(previous => previous.filter(item => item.id !== attachmentId))
      // Removing a file is how the user answers a refusal such as the
      // attachment count or the file quota, so it must not stay on screen.
      setComposerFileRefusals([])
      clearSendError()
    },
    [clearSendError, commitComposerFiles]
  )

  /** Puts back files that were attached to a send that failed. */
  const handleRestoreComposerFiles = useCallback(
    (files: ComposerFileAttachment[]) => {
      composerAttachmentRevisionRef.current += 1
      commitComposerFiles(() => files)
    },
    [commitComposerFiles]
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
        return next
      })
      clearSendError()
    },
    [clearSendError]
  )

  const handleRemoveComposerReferenceAttachment = useCallback(
    (attachmentId: string) => {
      composerAttachmentRevisionRef.current += 1
      setComposerReferenceAttachments(previous => previous.filter(att => att.id !== attachmentId))
      // Removing a file is how the user answers the "at most 10 files" refusal,
      // so the refusal must not stay on screen afterwards.
      clearSendError()
    },
    [clearSendError]
  )

  return {
    composerImageAttachments,
    composerFileAttachments,
    composerFileRefusals,
    composerAttachmentRevisionRef,
    composerReferenceAttachments,
    resetComposerAttachments,
    clearComposerAfterSend,
    clearComposerDraft,
    handleAddComposerImageAttachments,
    handleUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment,
    handleAddComposerFiles,
    handleRemoveComposerFileAttachment,
    handleRestoreComposerFiles,
    handleAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment,
  }
}
