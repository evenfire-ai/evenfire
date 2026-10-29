import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useChatComposerStateContext } from '@contexts/ChatComposerStateContext'
import { useMcpRuntimeContext } from '@contexts/McpRuntimeContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { Alert, Button as AntButton, Collapse, Dropdown, Flex, Input, Tag, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { GfsFileIcon } from '@components/GfsFileIcon'
import {
  IconConnectors as ApiOutlined,
  IconWorkflows as AppstoreOutlined,
  IconClose as CloseOutlined,
  IconAttachFile as FileTextOutlined,
  IconContexts as FolderOutlined,
  IconAttachFile as PaperClipOutlined,
  IconAttachFile as PictureOutlined,
  IconPlus as PlusOutlined,
  IconChevronRight as RightOutlined,
  IconUpload as UploadOutlined,
} from '@components/SidebarNav/icons'
import {
  SHOW_AGENT_FILES_UI,
  SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM,
} from '@constants/agentFeatures'
import {
  COMPOSER_ACCEPT_IMAGE_MIME_TYPES,
  COMPOSER_MAX_ATTACHMENTS,
  type ComposerImageBudget,
  type ComposerImageTotalBudget,
  composerImageBudget,
  composerImageCountedBytes,
} from '@constants/attachments'
import { useContextsDataController } from '@hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useComposerDraft } from '@hooks/useComposerDraft'
import { useHostModels } from '@hooks/useHostModels'
import { formatFileSize } from '@lib/composerFileAdmission'
import { readImageHeaderDimensions } from '@lib/imageHeaderDimensions'
import type { WorkflowRecipeListResult } from '../../../../src/types'
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerReferenceAttachment,
} from '../../uiTypes'
import { AnnotationCanvas } from './AnnotationCanvas'
import { ComposerAgentFilesModal } from './ComposerAgentFilesModal'
import { ComposerGlobalFilesModal } from './ComposerGlobalFilesModal'
import { ModelSelector } from './ModelSelector'

type ComposerPanelProps = {
  inline?: boolean
  agentSelector?: React.ReactNode
}

const COMPOSER_MAX_TEXT_HEIGHT = 240
const COMPOSER_MIN_TEXT_HEIGHT = 56
const COMPOSER_INLINE_MIN_TEXT_HEIGHT = 48

function getComposerReferenceTypeLabel(type: ComposerReferenceAttachment['type']): string {
  if (type === 'plugin') return 'Plugin'
  if (type === 'connector') return 'Connector'
  if (type === 'global_file') return 'Global File'
  return 'Agent File'
}

function getComposerImageTooltip(attachment: ComposerImageAttachment): string {
  return `Uploaded File - ${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB`
}

function formatComposerMebibytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/** The label bytes travel with the total, so the impossible state is not representable. */
function composerTotalLimitLabel(
  total: ComposerImageTotalBudget,
  sizeUnit: ComposerImageBudget['sizeUnit']
): string {
  return `${formatComposerMebibytes(total.labelBytes)} ${sizeUnit}`
}

function bytesFromBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

function composerImageDimensionRejection(
  name: string,
  mimeType: ComposerImageAttachment['mimeType'],
  dataBase64: string,
  maxDimension: number | null
): string | null {
  if (maxDimension == null) return null
  const bytes = bytesFromBase64(dataBase64)
  const dimensions = bytes ? readImageHeaderDimensions(mimeType, bytes) : null
  if (!dimensions) return null
  if (dimensions.width > maxDimension || dimensions.height > maxDimension) {
    return `${name || 'Image'} is too large. Max resolution is ${maxDimension} px.`
  }
  return null
}

function composerImageExceedsPerImageBudget(sizeBytes: number, maxImageBytes: number): boolean {
  return sizeBytes > maxImageBytes
}

function composerPerImageLimitMessage(
  name: string,
  maxImageBytes: number,
  sizeUnit: 'MB' | 'MiB'
): string {
  return `${name || 'Image'} is too large. Max size is ${formatComposerMebibytes(maxImageBytes)} ${sizeUnit}.`
}

function getComposerReferenceIcon(attachment: ComposerReferenceAttachment) {
  if (attachment.type === 'plugin') return <AppstoreOutlined width={14} height={14} />
  if (attachment.type === 'connector') return <ApiOutlined width={14} height={14} />
  if (attachment.type === 'global_file') {
    return <GfsFileIcon name={attachment.label} width={14} height={14} />
  }
  return <FolderOutlined width={14} height={14} />
}

/** Status line of a document chip: what the user needs to know before sending. */
function getComposerFileMeta(file: ComposerFileAttachment): string {
  if (file.status !== 'ready') return 'Reading...'
  const size = formatFileSize(file.sizeBytes)
  if (file.classification.reader === 'none') return `${size} · No reader available`
  return `${size} · ${file.classification.class}`
}

/** Notice shown under the chips for a document that needs attention. */
function getComposerFileNotice(file: ComposerFileAttachment): string | null {
  if (file.status !== 'ready') return null
  if (file.classification.mismatch) {
    return `${file.filename} looks like a ${file.classification.class} file, not what its name or type says. It is attached as it is.`
  }
  if (file.classification.reader === 'none') {
    return `${file.filename} is attached, but the agent has no reader for this kind of file.`
  }
  return null
}

export function ComposerPanel({ inline = false, agentSelector }: ComposerPanelProps) {
  const { selectedAgent } = useNavigationContext()
  const {
    composerImageAttachments,
    composerFileAttachments,
    composerFileRefusals,
    composerReferenceAttachments,
    agentSending,
    agentError,
    failedAgentSend,
    activeChatId,
    activeMessageCount,
    composerFocusRequestId,
  } = useChatComposerStateContext()
  const {
    clearComposerSendError,
    handleAddComposerImageAttachments: onAddComposerImageAttachments,
    handleUpdateComposerImageAttachment: onUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment: onRemoveComposerImageAttachment,
    handleAddComposerFiles: onAddComposerFiles,
    handleRemoveComposerFileAttachment: onRemoveComposerFileAttachment,
    handleAddComposerReferenceAttachments: onAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment: onRemoveComposerReferenceAttachment,
    handleClearComposerAttachments: onClearComposerAttachments,
    handleSendAgentMessage: onSend,
    handleRetryFailedAgentSend: onRetryFailedSend,
    handleRecoverFailedAgentSend: onRecoverFailedSend,
    handleDiscardFailedAgentSend: onDiscardFailedSend,
  } = useAgentChatActionsContext()
  const { hostRuntimeStatus } = useMcpRuntimeContext()
  const {
    selectedAgentMcpServers,
    agentContextByName,
    refresh: refreshConnectors,
  } = useMcpServersDataController({
    selectedAgent,
  })
  const { sharedFilesByContext, refreshSharedFiles } = useContextsDataController()

  const [composerAttachmentError, setComposerAttachmentError] = useState<string | null>(null)
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [pluginOptions, setPluginOptions] = useState<
    Array<{ id: string; label: string; namespace: string; name: string }>
  >([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [pluginsLoaded, setPluginsLoaded] = useState(false)
  const [pluginsError, setPluginsError] = useState<string | null>(null)
  const [agentFilesModalOpen, setAgentFilesModalOpen] = useState(false)
  const [globalFilesModalOpen, setGlobalFilesModalOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null)
  // Per-chat draft from the module-scoped store. Typing only re-renders this
  // component (it's the sole subscriber); the value is restored automatically when
  // activeChatId changes and survives the inline→docked composer swap.
  const [draft, setDraft] = useComposerDraft(activeChatId, selectedAgent ?? undefined)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const composerInputWidthRef = useRef<number | null>(null)
  const composerFileInputRef = useRef<HTMLInputElement | null>(null)

  // Issue #654: image capability comes from the host-projected per-model
  // decision shared with the selector and the send path — never from the
  // provider id. `visualSendBlocked` covers all three blocking shapes:
  // `unsupported` (known text-only), `unknown` (no/stale evidence) and an
  // unsettled selection write (the model may still be changing under us).
  // It gates SENDING images, never selecting them (#678): the picker, paste and
  // drop always attach, and the notice below explains a blocked send, so the
  // user can still switch to a capable model with the images kept.
  const hostModelSelection = useHostModels(selectedAgent ?? '', activeChatId ?? '')
  const imageAttachmentBlockMessage = hostModelSelection.imageBlockMessage
  // Size ceilings follow the host provider: Codex keeps #650 (16 MiB / 2048 /
  // hop-owned aggregate). Grok is 16 MiB per image and 16 MiB decoded in total
  // (#784). Every other image-capable host keeps #669 (3 MiB + 8 MB combined).
  // Capability still comes from the host projection, not this.
  const imageBudget = composerImageBudget(hostModelSelection.data?.provider)
  const selectedAgentContext = selectedAgent
    ? String(agentContextByName[selectedAgent] || '').trim()
    : ''
  const agentFilesState = selectedAgentContext ? sharedFilesByContext[selectedAgentContext] : null
  const agentFilesLoading = Boolean(
    selectedAgentContext && (!agentFilesState?.loaded || agentFilesState.loading)
  )
  const agentFilesAvailable = Boolean(agentFilesState?.items?.length)
  const agentFilesDisabled = agentFilesLoading || !agentFilesAvailable

  const resizeComposerInput = useCallback(() => {
    const textarea = composerInputRef.current
    if (!textarea) return

    const minimumHeight = inline ? COMPOSER_INLINE_MIN_TEXT_HEIGHT : COMPOSER_MIN_TEXT_HEIGHT
    textarea.style.height = 'auto'
    const height = Math.min(
      Math.max(textarea.scrollHeight, minimumHeight),
      COMPOSER_MAX_TEXT_HEIGHT
    )
    textarea.style.height = `${height}px`
    textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_TEXT_HEIGHT ? 'auto' : 'hidden'
  }, [inline])

  useEffect(() => {
    resizeComposerInput()
  }, [activeChatId, draft, resizeComposerInput])

  useEffect(() => {
    const textarea = composerInputRef.current
    if (!textarea || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width === undefined || width === composerInputWidthRef.current) return
      composerInputWidthRef.current = width
      resizeComposerInput()
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [activeChatId, resizeComposerInput])

  // Clear attachment error when agent changes
  useEffect(() => {
    setComposerAttachmentError(null)
    setComposerMenuOpen(false)
    setPluginsLoaded(false)
    setPluginsLoading(false)
    setPluginOptions([])
    setPluginsError(null)
  }, [selectedAgent])

  useEffect(() => {
    if (!selectedAgent || pluginsLoaded) {
      return
    }
    let cancelled = false
    setPluginsLoading(true)
    setPluginsError(null)
    window.clerum.workflows
      .list()
      .then((result: WorkflowRecipeListResult) => {
        if (cancelled) return
        const options = (result.items || [])
          .map(item => {
            const namespace = String(item.metadata?.namespace || '').trim()
            const name = String(item.metadata?.name || '').trim()
            if (!namespace || !name) return null
            return {
              id: `plugin:${namespace}:${name}`,
              label: name,
              namespace,
              name,
            }
          })
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .sort((a, b) => a.label.localeCompare(b.label))
        setPluginOptions(options)
        setPluginsLoaded(true)
      })
      .catch(error => {
        if (cancelled) return
        setPluginsError(error instanceof Error ? error.message : String(error))
        setPluginsLoaded(true)
      })
      .finally(() => {
        if (!cancelled) setPluginsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedAgent, pluginsLoaded])

  useEffect(() => {
    if (!selectedAgent) return
    void refreshConnectors()
  }, [refreshConnectors, selectedAgent])

  useEffect(() => {
    if (!selectedAgentContext) return
    void refreshSharedFiles(selectedAgentContext)
  }, [refreshSharedFiles, selectedAgentContext])

  // Close preview when attachment is removed from list
  useEffect(() => {
    if (!previewAttachmentId) return
    const active = composerImageAttachments.some(
      attachment => attachment.id === previewAttachmentId
    )
    if (!active) {
      setPreviewAttachmentId(null)
    }
  }, [composerImageAttachments, previewAttachmentId])

  // ESC key closes preview
  useEffect(() => {
    if (!previewAttachmentId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewAttachmentId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewAttachmentId])

  // Auto-focus composer after sending
  useEffect(() => {
    if (!activeChatId || activeMessageCount > 0 || agentSending) return
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus()
    })
  }, [activeChatId, activeMessageCount, agentSending])

  useEffect(() => {
    if (composerFocusRequestId === 0) return
    const textarea = composerInputRef.current
    if (!textarea || textarea.disabled || document.activeElement === textarea) return
    textarea.focus()
  }, [composerFocusRequestId])

  const handleDraftChange = useCallback(
    (value: string) => {
      setDraft(value)
      // Clear any pending send error as the user resumes typing. No re-render up-tree
      // unless an error is actually present.
      clearComposerSendError()
    },
    [clearComposerSendError, setDraft]
  )

  // The controller clears the draft store only when the send is actually accepted
  // (it bails out early if the chat already has an in-flight task), so a no-op send
  // naturally keeps the text — no optimistic clear needed here.
  // Issue #654: with pending images and an unsettled/incompatible effective
  // model, Enter must not reach the controller. The chips and the draft stay
  // exactly as they are, and the notice below explains the block.
  const imagesBlockedForSend =
    composerImageAttachments.length > 0 && hostModelSelection.visualSendBlocked
  // Per-instance id: the main panel and the chat drawer can both be mounted.
  const imageNoticeId = useId()
  // #678 — a document that is still being read is not part of the message yet.
  // Sending now would leave it out without saying so, so send stays disabled
  // until each chip is ready or removed.
  const filesBlockedForSend = composerFileAttachments.some(file => file.status !== 'ready')
  const handleSend = useCallback(() => {
    if (imagesBlockedForSend || filesBlockedForSend) return
    void onSend(draft)
  }, [onSend, draft, imagesBlockedForSend, filesBlockedForSend])

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const previewAttachment = useMemo(
    () =>
      previewAttachmentId
        ? composerImageAttachments.find(attachment => attachment.id === previewAttachmentId) || null
        : null,
    [composerImageAttachments, previewAttachmentId]
  )

  const connectorOptions = useMemo(
    () =>
      selectedAgentMcpServers
        .map(server => ({ id: `connector:${server.name}`, label: server.name, name: server.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [selectedAgentMcpServers]
  )

  const addComposerReference = useCallback(
    (attachment: ComposerReferenceAttachment) => {
      onAddComposerReferenceAttachments([attachment])
      setComposerMenuOpen(false)
      setComposerAttachmentError(null)
    },
    [onAddComposerReferenceAttachments]
  )

  const openUploadPicker = useCallback(() => {
    setComposerMenuOpen(false)
    composerFileInputRef.current?.click()
  }, [])

  const openAgentFilesModal = useCallback(() => {
    if (agentFilesLoading) {
      setComposerAttachmentError('Loading Agent Files...')
      return
    }
    if (!selectedAgentContext || !agentFilesAvailable) {
      setComposerAttachmentError('No Agent Files Available')
      setComposerMenuOpen(false)
      return
    }
    setComposerMenuOpen(false)
    setAgentFilesModalOpen(true)
  }, [agentFilesAvailable, agentFilesLoading, selectedAgentContext])

  const openGlobalFilesModal = useCallback(() => {
    setComposerMenuOpen(false)
    setComposerAttachmentError(null)
    setGlobalFilesModalOpen(true)
  }, [])

  const composerReferenceMenuItems = useMemo<NonNullable<MenuProps['items']>>(
    () => [
      {
        key: 'plugins',
        icon: <AppstoreOutlined aria-hidden="true" width={18} height={18} />,
        label: 'Plugins',
        title: 'Plugins',
        popupClassName: 'composer-reference-submenu',
        children: pluginsLoading
          ? [{ key: 'plugins-loading', disabled: true, label: 'Loading plugins...' }]
          : pluginsError
            ? [{ key: 'plugins-error', disabled: true, label: pluginsError }]
            : pluginOptions.length
              ? pluginOptions.map(plugin => ({
                  key: `plugin:${plugin.id}`,
                  label: plugin.label,
                  onClick: () =>
                    addComposerReference({
                      id: plugin.id,
                      type: 'plugin',
                      namespace: plugin.namespace,
                      name: plugin.name,
                      label: plugin.label,
                    }),
                }))
              : [{ key: 'plugins-empty', disabled: true, label: 'No plugins available' }],
      },
      {
        key: 'connectors',
        icon: <ApiOutlined aria-hidden="true" width={18} height={18} />,
        label: 'Connectors',
        title: 'Connectors',
        popupClassName: 'composer-reference-submenu',
        children: connectorOptions.length
          ? connectorOptions.map(connector => ({
              key: connector.id,
              label: connector.label,
              onClick: () =>
                addComposerReference({
                  id: connector.id,
                  type: 'connector',
                  name: connector.name,
                  label: connector.label,
                }),
            }))
          : [{ key: 'connectors-empty', disabled: true, label: 'No connectors available' }],
      },
      ...(SHOW_AGENT_FILES_UI
        ? [
            agentFilesDisabled
              ? {
                  key: 'agent-files',
                  icon: <FolderOutlined aria-hidden="true" width={18} height={18} />,
                  label: 'Agent Files',
                  title: 'Agent Files',
                  popupClassName: 'composer-reference-submenu',
                  children: [
                    {
                      key: agentFilesLoading ? 'agent-files-loading' : 'agent-files-empty',
                      disabled: true,
                      label: agentFilesLoading
                        ? 'Loading Agent Files...'
                        : 'No Agent Files Available',
                    },
                  ],
                }
              : {
                  key: 'agent-files',
                  icon: <FolderOutlined aria-hidden="true" width={18} height={18} />,
                  label: 'Agent Files',
                  onClick: openAgentFilesModal,
                },
          ]
        : []),
      ...(SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM
        ? [
            {
              key: 'even-drive',
              icon: <PaperClipOutlined aria-hidden="true" width={18} height={18} />,
              label: 'EvenDrive',
              onClick: openGlobalFilesModal,
            },
          ]
        : []),
      {
        key: 'upload',
        icon: <UploadOutlined aria-hidden="true" width={18} height={18} />,
        label: 'Upload Files',
        onClick: openUploadPicker,
      },
    ],
    [
      addComposerReference,
      agentFilesDisabled,
      agentFilesLoading,
      connectorOptions,
      openAgentFilesModal,
      openGlobalFilesModal,
      openUploadPicker,
      pluginOptions,
      pluginsError,
      pluginsLoading,
    ]
  )

  const readFileAsDataUrl = useCallback(
    (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () =>
          reject(reader.error || new Error(`Failed to read image file: ${file.name}`))
        reader.readAsDataURL(file)
      }),
    []
  )

  const inferComposerImageMimeType = useCallback(
    (file: File): ComposerImageAttachment['mimeType'] | null => {
      const declared = file.type?.trim().toLowerCase()
      if (declared === 'image/png' || declared === 'image/jpeg') {
        return declared
      }
      const loweredName = (file.name || '').toLowerCase()
      if (loweredName.endsWith('.png')) return 'image/png'
      if (loweredName.endsWith('.jpg') || loweredName.endsWith('.jpeg')) return 'image/jpeg'
      return null
    },
    []
  )

  const createPreviewUrl = useCallback((file: File): string | null => {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      return URL.createObjectURL(file)
    }
    return null
  }, [])

  const revokePreviewUrl = useCallback((previewUrl: string | null) => {
    if (!previewUrl) return
    if (
      previewUrl.startsWith('blob:') &&
      typeof URL !== 'undefined' &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      URL.revokeObjectURL(previewUrl)
    }
  }, [])

  const buildAttachmentName = useCallback(
    (
      file: File,
      source: 'picker' | 'clipboard',
      mimeType: ComposerImageAttachment['mimeType'],
      index: number
    ): string => {
      const extension = mimeType === 'image/png' ? 'png' : 'jpg'
      const rawName = String(file.name || '').trim()
      const looksGeneric = /^image(\.[a-z0-9]+)?$/i.test(rawName)
      if (source === 'clipboard' && (!rawName || looksGeneric)) {
        return `pasted-image-${Date.now()}-${index + 1}.${extension}`
      }
      return rawName || `image-${Date.now()}-${index + 1}.${extension}`
    },
    []
  )

  const prepareComposerImageAttachments = useCallback(
    async (files: File[] | FileList, source: 'picker' | 'clipboard' = 'picker') => {
      const candidates = Array.from(files || [])
      if (!candidates.length) return

      // `routeComposerFiles` sends only PNG/JPEG here; documents take the file
      // path. Images and files share one per-message count.
      const validationErrors: string[] = []
      const imageCandidates: Array<{
        file: File
        mimeType: ComposerImageAttachment['mimeType']
      }> = []
      for (const file of candidates) {
        const mimeType = inferComposerImageMimeType(file)
        if (mimeType && COMPOSER_ACCEPT_IMAGE_MIME_TYPES.includes(mimeType)) {
          imageCandidates.push({ file, mimeType })
        }
      }
      if (!imageCandidates.length) return

      const availableSlots =
        COMPOSER_MAX_ATTACHMENTS - composerImageAttachments.length - composerFileAttachments.length
      if (availableSlots <= 0) {
        setComposerAttachmentError(
          `A message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`
        )
        return
      }

      const accepted: ComposerImageAttachment[] = []
      const selected = imageCandidates.slice(0, availableSlots)
      if (imageCandidates.length > availableSlots) {
        const skipped = imageCandidates.length - availableSlots
        validationErrors.push(
          `A message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments; ${skipped} ${
            skipped === 1 ? 'image was' : 'images were'
          } not added.`
        )
      }
      // General images are counted in base64 characters (#669). Codex and Grok
      // count decoded bytes against the 16 MiB ingress total (#650, #784).
      const totalBudget = imageBudget.total
      let totalCountedBytes = totalBudget
        ? composerImageAttachments.reduce(
            (total, attachment) => total + composerImageCountedBytes(totalBudget, attachment),
            0
          )
        : 0

      for (const [index, { file, mimeType }] of selected.entries()) {
        if (composerImageExceedsPerImageBudget(file.size, imageBudget.maxImageBytes)) {
          validationErrors.push(
            composerPerImageLimitMessage(file.name, imageBudget.maxImageBytes, imageBudget.sizeUnit)
          )
          continue
        }

        const previewUrl = createPreviewUrl(file)
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const base64Index = dataUrl.indexOf('base64,')
          if (base64Index === -1) {
            validationErrors.push(`${file.name || 'Image'} could not be encoded.`)
            revokePreviewUrl(previewUrl)
            continue
          }
          const dataBase64 = dataUrl.slice(base64Index + 'base64,'.length).trim()
          if (!dataBase64) {
            validationErrors.push(`${file.name || 'Image'} could not be encoded.`)
            revokePreviewUrl(previewUrl)
            continue
          }
          const dimensionError = composerImageDimensionRejection(
            file.name || 'Image',
            mimeType,
            dataBase64,
            imageBudget.maxDimension
          )
          if (dimensionError) {
            validationErrors.push(dimensionError)
            revokePreviewUrl(previewUrl)
            continue
          }
          const candidate = { dataBase64, sizeBytes: file.size }
          if (
            totalBudget != null &&
            totalCountedBytes + composerImageCountedBytes(totalBudget, candidate) >
              totalBudget.maxBytes
          ) {
            validationErrors.push(
              `${file.name || 'Image'} does not fit in this message: the images in one message are limited to ${composerTotalLimitLabel(
                totalBudget,
                imageBudget.sizeUnit
              )} in total. Send the attached images first or remove one.`
            )
            revokePreviewUrl(previewUrl)
            continue
          }
          if (totalBudget != null) {
            totalCountedBytes += composerImageCountedBytes(totalBudget, candidate)
          }
          accepted.push({
            id: crypto.randomUUID(),
            name: buildAttachmentName(file, source, mimeType, index),
            mimeType,
            dataBase64,
            sizeBytes: file.size,
            previewDataUrl: previewUrl || dataUrl,
          })
        } catch (error) {
          revokePreviewUrl(previewUrl)
          validationErrors.push(
            `${file.name || 'Image'} failed to load (${error instanceof Error ? error.message : String(error)}).`
          )
        }
      }

      if (accepted.length > 0) {
        onAddComposerImageAttachments(accepted)
      }
      setComposerAttachmentError(validationErrors.length ? (validationErrors[0] ?? null) : null)
    },
    [
      buildAttachmentName,
      composerFileAttachments,
      composerImageAttachments,
      imageBudget,
      inferComposerImageMimeType,
      onAddComposerImageAttachments,
      readFileAsDataUrl,
      createPreviewUrl,
      revokePreviewUrl,
    ]
  )

  /**
   * One entry point for the picker, paste and drop (#678): PNG and JPEG keep the
   * image path with its previews and image budget; every other file is read as
   * an inline document attachment.
   */
  const routeComposerFiles = useCallback(
    (files: File[] | FileList, source: 'picker' | 'clipboard') => {
      const images: File[] = []
      const documents: File[] = []
      for (const file of Array.from(files || [])) {
        const mimeType = inferComposerImageMimeType(file)
        if (mimeType && COMPOSER_ACCEPT_IMAGE_MIME_TYPES.includes(mimeType)) images.push(file)
        else documents.push(file)
      }
      setComposerAttachmentError(null)
      // Called for every gesture, with `[]` when it carried only images: this
      // is what replaces the document notices of the previous gesture.
      onAddComposerFiles(documents, draft)
      if (images.length > 0) void prepareComposerImageAttachments(images, source)
    },
    [draft, inferComposerImageMimeType, onAddComposerFiles, prepareComposerImageAttachments]
  )

  /**
   * An annotation save re-encodes the image, so the result can be larger than the
   * file the picker accepted. Apply the same budget before the attachment is
   * replaced; a refusal never calls through, so the original attachment, its
   * preview URL and its bytes stay exactly as they were.
   *
   * The refusal is thrown rather than returned: AnnotationCanvas runs `onSave`
   * inside its own try/catch and renders the thrown message in
   * `.composer-image-preview-error` within its dialog. That is the only error
   * surface above the full-screen annotation overlay — the composer's own banner
   * sits behind that overlay's 86%-opaque backdrop — and throwing also skips the
   * canvas's `setPreviewIsAnnotating(false)`, so the user keeps their strokes.
   */
  const handleAnnotatedImageSave = useCallback(
    (updated: ComposerImageAttachment) => {
      const dimensionError = composerImageDimensionRejection(
        updated.name || 'Image',
        updated.mimeType,
        updated.dataBase64,
        imageBudget.maxDimension
      )
      const totalBudget = imageBudget.total
      const otherCountedBytes = totalBudget
        ? composerImageAttachments.reduce(
            (total, attachment) =>
              attachment.id === updated.id
                ? total
                : total + composerImageCountedBytes(totalBudget, attachment),
            0
          )
        : 0
      if (composerImageExceedsPerImageBudget(updated.sizeBytes, imageBudget.maxImageBytes)) {
        throw new Error(
          `${updated.name || 'Image'} was kept unchanged. Max size is ${formatComposerMebibytes(
            imageBudget.maxImageBytes
          )} ${imageBudget.sizeUnit} per image.`
        )
      }
      if (dimensionError) {
        throw new Error(
          `${updated.name || 'Image'} was kept unchanged. Max resolution is ${imageBudget.maxDimension} px.`
        )
      }
      if (
        totalBudget != null &&
        otherCountedBytes + composerImageCountedBytes(totalBudget, updated) > totalBudget.maxBytes
      ) {
        throw new Error(
          `${updated.name || 'Image'} was kept unchanged. The images in one message are limited to ${composerTotalLimitLabel(
            totalBudget,
            imageBudget.sizeUnit
          )} in total.`
        )
      }
      onUpdateComposerImageAttachment(updated)
    },
    [composerImageAttachments, imageBudget, onUpdateComposerImageAttachment]
  )

  const handleComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const filesFromClipboard = Array.from(event.clipboardData.files || [])
      const filesFromItems = Array.from(event.clipboardData.items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => Boolean(file))
      const allFiles = [...filesFromClipboard, ...filesFromItems]
      const dedupedBySignature = new Map<string, File>()
      for (const file of allFiles) {
        const signature = `${file.name}:${file.size}:${file.lastModified}:${file.type}`
        if (!dedupedBySignature.has(signature)) {
          dedupedBySignature.set(signature, file)
        }
      }
      const pastedFiles = [...dedupedBySignature.values()]
      if (!pastedFiles.length) return
      event.preventDefault()
      routeComposerFiles(pastedFiles, 'clipboard')
    },
    [routeComposerFiles]
  )

  const hasDragFiles = useCallback((event: React.DragEvent<HTMLElement>) => {
    return Array.from(event.dataTransfer.types || []).includes('Files')
  }, [])

  const handleComposerDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasDragFiles(event)) return
      event.preventDefault()
      setDragActive(true)
      setComposerAttachmentError(null)
    },
    [hasDragFiles]
  )

  const handleComposerDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasDragFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    },
    [hasDragFiles]
  )

  const handleComposerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragActive(false)
  }, [])

  const handleComposerDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasDragFiles(event)) return
      event.preventDefault()
      setDragActive(false)
      const files = Array.from(event.dataTransfer.files || [])
      if (!files.length) return
      routeComposerFiles(files, 'picker')
    },
    [hasDragFiles, routeComposerFiles]
  )

  const composerAttachmentItems = useMemo(() => {
    const referenceItems = composerReferenceAttachments.map((attachment, index) => ({
      id: `reference:${attachment.id}`,
      kind: 'reference' as const,
      attachment,
      order: attachment.addedOrder ?? index,
      fallbackIndex: index,
    }))
    const imageItems = composerImageAttachments.map((attachment, index) => ({
      id: `image:${attachment.id}`,
      kind: 'image' as const,
      attachment,
      order: attachment.addedOrder ?? referenceItems.length + index,
      fallbackIndex: referenceItems.length + index,
    }))
    const fileItems = composerFileAttachments.map((attachment, index) => ({
      id: `file:${attachment.id}`,
      kind: 'file' as const,
      attachment,
      order: attachment.addedOrder ?? referenceItems.length + imageItems.length + index,
      fallbackIndex: referenceItems.length + imageItems.length + index,
    }))
    return [...referenceItems, ...imageItems, ...fileItems].sort(
      (a, b) => a.order - b.order || a.fallbackIndex - b.fallbackIndex
    )
  }, [composerFileAttachments, composerImageAttachments, composerReferenceAttachments])
  // Refusals come first: they name documents that were not attached at all.
  const composerFileNotices = useMemo(
    () => [
      ...composerFileRefusals.map(refusal => ({ ...refusal, refused: true })),
      ...composerFileAttachments.flatMap(file => {
        const notice = getComposerFileNotice(file)
        return notice ? [{ id: file.id, refused: false, text: notice }] : []
      }),
    ],
    [composerFileAttachments, composerFileRefusals]
  )

  const isDegraded = hostRuntimeStatus?.degraded?.reason === 'llm_key_missing'
  const hasComposerAttachments = composerAttachmentItems.length > 0

  return (
    <div className={`composer ${inline ? 'composer-inline' : 'composer-shell-footer'}`}>
      <input
        ref={composerFileInputRef}
        type="file"
        multiple
        className="composer-file-input"
        onChange={event => {
          const selectedFiles = event.target.files
          if (selectedFiles && selectedFiles.length > 0) {
            routeComposerFiles(selectedFiles, 'picker')
          }
          event.currentTarget.value = ''
        }}
      />
      <div
        className={`composer-input-shell${dragActive ? ' composer-input-shell--drag-active' : ''}`}
        onDragEnter={handleComposerDragEnter}
        onDragLeave={handleComposerDragLeave}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
      >
        <div className="composer-textarea-viewport">
          <Input.TextArea
            key={activeChatId ?? 'no-chat'}
            ref={input => {
              composerInputRef.current = input?.resizableTextArea?.textArea ?? null
            }}
            data-testid="chat-input"
            aria-label="Agent message composer"
            variant="borderless"
            value={draft}
            onChange={event => {
              handleDraftChange(event.target.value)
              resizeComposerInput()
            }}
            onPaste={handleComposerPaste}
            onKeyDown={handleComposerKeyDown}
            rows={3}
            disabled={isDegraded}
            placeholder={
              isDegraded
                ? 'Agent degraded — fix the LLM Secret to resume.'
                : `Message ${selectedAgent}... (Enter to send, Shift+Enter for newline)`
            }
          />
        </div>
        {dragActive ? <div className="composer-drop-overlay">Drop files here</div> : null}
        <div className="composer-input-actions">
          {agentSelector && <span className="composer-agent-selector-slot">{agentSelector}</span>}
          <span className="composer-reference-toolbar">
            <span className="composer-reference-menu">
              <Dropdown
                autoAdjustOverflow
                autoFocus
                destroyOnHidden
                menu={{
                  items: composerReferenceMenuItems,
                  className: 'composer-reference-menu-antd',
                  getPopupContainer: () => document.body,
                  subMenuOpenDelay: 0,
                  subMenuCloseDelay: 0.4,
                  expandIcon: (
                    <span aria-hidden="true">
                      <RightOutlined width={18} height={18} />
                    </span>
                  ),
                  'aria-label': 'Add context',
                }}
                classNames={{ root: 'composer-reference-menu-panel' }}
                getPopupContainer={trigger =>
                  trigger.closest<HTMLElement>('.composer-reference-menu') ?? document.body
                }
                onOpenChange={open => setComposerMenuOpen(open)}
                open={composerMenuOpen}
                placement={inline ? 'bottomLeft' : 'topLeft'}
                trigger={['click']}
              >
                <AntButton
                  htmlType="button"
                  type="text"
                  size="small"
                  icon={<PlusOutlined aria-hidden="true" width={16} height={16} />}
                  disabled={agentSending}
                  aria-label="Add context"
                  aria-haspopup="menu"
                  aria-expanded={composerMenuOpen}
                />
              </Dropdown>
            </span>
            {hasComposerAttachments ? (
              <Flex align="center" data-testid="composer-attachments-list" gap="small" wrap>
                <Typography.Text type="secondary" data-testid="composer-attachments-count">
                  {composerAttachmentItems.length}{' '}
                  {composerAttachmentItems.length === 1 ? 'attachment' : 'attachments'}
                </Typography.Text>
                {composerAttachmentItems.map(item => {
                  if (item.kind === 'reference') {
                    const attachment = item.attachment
                    const typeLabel = getComposerReferenceTypeLabel(attachment.type)
                    return (
                      <Flex align="center" gap="small" key={item.id}>
                        <Tag icon={getComposerReferenceIcon(attachment)} title={typeLabel}>
                          {attachment.label}
                        </Tag>
                        <AntButton
                          htmlType="button"
                          type="text"
                          size="small"
                          shape="circle"
                          icon={<CloseOutlined aria-hidden="true" width={16} height={16} />}
                          onClick={() => onRemoveComposerReferenceAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.label}`}
                        />
                      </Flex>
                    )
                  }
                  if (item.kind === 'file') {
                    const attachment = item.attachment
                    const meta = getComposerFileMeta(attachment)
                    return (
                      <Flex
                        align="center"
                        gap="small"
                        key={item.id}
                        data-testid="composer-file-chip"
                        data-file-status={attachment.status}
                        title={`${attachment.filename} - ${meta}`}
                      >
                        <Tag icon={<FileTextOutlined aria-hidden="true" width={14} height={14} />}>
                          <Flex vertical>
                            <Typography.Text>{attachment.filename}</Typography.Text>
                            <Typography.Text type="secondary">{meta}</Typography.Text>
                          </Flex>
                        </Tag>
                        <AntButton
                          htmlType="button"
                          type="text"
                          size="small"
                          shape="circle"
                          icon={<CloseOutlined aria-hidden="true" width={16} height={16} />}
                          onClick={() => onRemoveComposerFileAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.filename}`}
                        />
                      </Flex>
                    )
                  }
                  const attachment = item.attachment
                  const tooltip = getComposerImageTooltip(attachment)
                  return (
                    <Flex align="center" gap="small" key={item.id} title={tooltip}>
                      <Tag icon={<PictureOutlined aria-hidden="true" width={14} height={14} />}>
                        <AntButton
                          htmlType="button"
                          type="link"
                          size="small"
                          onClick={() => setPreviewAttachmentId(attachment.id)}
                          title={tooltip}
                        >
                          {attachment.name}
                        </AntButton>
                      </Tag>
                      <AntButton
                        htmlType="button"
                        type="text"
                        size="small"
                        shape="circle"
                        icon={<CloseOutlined aria-hidden="true" width={16} height={16} />}
                        onClick={() => onRemoveComposerImageAttachment(attachment.id)}
                        aria-label={`Remove ${attachment.name}`}
                      />
                    </Flex>
                  )
                })}
                <AntButton
                  htmlType="button"
                  type="link"
                  size="small"
                  onClick={onClearComposerAttachments}
                  aria-label="Clear all attachments"
                >
                  Clear all
                </AntButton>
              </Flex>
            ) : null}
          </span>
          <span className="composer-actions-right">
            {selectedAgent && (
              // Rendered even before a chat exists (new-chat composer): with an
              // empty chatId the selector shows the host default and holds the pick
              // locally, and the first send piggybacks it onto message 1 (R2).
              <ModelSelector agentRef={selectedAgent} chatId={activeChatId ?? ''} placement="up" />
            )}
            <AntButton
              htmlType="button"
              data-testid="send-button"
              shape="circle"
              size="small"
              onClick={handleSend}
              disabled={
                isDegraded ||
                agentSending ||
                imagesBlockedForSend ||
                filesBlockedForSend ||
                (!draft.trim() &&
                  composerImageAttachments.length === 0 &&
                  composerFileAttachments.length === 0 &&
                  composerReferenceAttachments.length === 0)
              }
              aria-label={agentSending ? 'Sending message' : 'Send message'}
              aria-describedby={imagesBlockedForSend ? imageNoticeId : undefined}
              loading={agentSending}
              title={agentSending ? 'Sending...' : 'Send message'}
              type="primary"
              icon={
                <svg
                  viewBox="0 0 20 20"
                  width={22}
                  height={22}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M10 5v9.1" />
                  <path d="M6.7 8.3 10 5l3.3 3.3" />
                </svg>
              }
            ></AntButton>
          </span>
        </div>
      </div>
      {imagesBlockedForSend || composerAttachmentError ? (
        <Alert
          showIcon
          type="error"
          role="alert"
          title={
            imagesBlockedForSend
              ? (imageAttachmentBlockMessage ??
                'Image attachments are not available for this model yet.')
              : composerAttachmentError
          }
          id={imagesBlockedForSend ? imageNoticeId : undefined}
          data-testid={imagesBlockedForSend ? 'composer-image-capability-notice' : undefined}
        />
      ) : null}
      {composerFileNotices.length > 0 ? (
        <Flex vertical gap="small" data-testid="composer-file-notices">
          {composerFileNotices.map(notice => (
            <Alert
              key={notice.id}
              showIcon
              type={notice.refused ? 'error' : 'warning'}
              role={notice.refused ? 'alert' : 'status'}
              title={notice.text}
            />
          ))}
        </Flex>
      ) : null}
      {agentError ? (
        <Flex vertical gap="small">
          {failedAgentSend?.kind === 'waking' ? (
            <Alert
              type="info"
              showIcon
              role="status"
              data-testid="waking-state"
              title="Agent is waking up — this usually takes under a minute. Your message was not delivered yet."
              action={
                <AntButton
                  htmlType="button"
                  onClick={onRetryFailedSend}
                  disabled={agentSending}
                  size="small"
                  type="text"
                >
                  Retry last send
                </AntButton>
              }
            />
          ) : (
            <Alert
              type="error"
              showIcon
              role="alert"
              title={agentError}
              description={
                failedAgentSend?.message ? (
                  <Collapse
                    size="small"
                    items={[
                      {
                        key: 'technical-details',
                        label: 'Technical details',
                        forceRender: true,
                        children: <Typography.Text code>{failedAgentSend.message}</Typography.Text>,
                      },
                    ]}
                  />
                ) : undefined
              }
            />
          )}
          {failedAgentSend?.kind !== 'waking' &&
          failedAgentSend &&
          !failedAgentSend.answeredWithoutFiles ? (
            <Flex justify="flex-end">
              <AntButton
                htmlType="button"
                onClick={onRetryFailedSend}
                disabled={agentSending}
                size="small"
                type="text"
              >
                Retry last send
              </AntButton>
            </Flex>
          ) : null}
        </Flex>
      ) : null}
      {failedAgentSend ? (
        <Flex gap="small" justify="flex-end">
          <AntButton
            htmlType="button"
            onClick={onRecoverFailedSend}
            disabled={agentSending}
            size="small"
            type="text"
          >
            {failedAgentSend.answeredWithoutFiles ? 'Recover files' : 'Recover input'}
          </AntButton>
          <AntButton
            htmlType="button"
            onClick={onDiscardFailedSend}
            disabled={agentSending}
            size="small"
            type="text"
          >
            Discard failed input
          </AntButton>
        </Flex>
      ) : null}

      {previewAttachment && (
        <AnnotationCanvas
          attachment={previewAttachment}
          onSave={handleAnnotatedImageSave}
          onClose={() => setPreviewAttachmentId(null)}
        />
      )}
      {agentFilesModalOpen && selectedAgentContext ? (
        <ComposerAgentFilesModal
          contextId={selectedAgentContext}
          onAdd={onAddComposerReferenceAttachments}
          onClose={() => setAgentFilesModalOpen(false)}
        />
      ) : null}
      {globalFilesModalOpen ? (
        <ComposerGlobalFilesModal
          attachedIds={composerReferenceAttachments
            .filter(attachment => attachment.type === 'global_file')
            .map(attachment => attachment.id)}
          onAdd={onAddComposerReferenceAttachments}
          onClose={() => setGlobalFilesModalOpen(false)}
        />
      ) : null}
    </div>
  )
}
