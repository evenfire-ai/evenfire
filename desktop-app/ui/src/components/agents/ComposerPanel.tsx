import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useChatComposerStateContext } from '@contexts/ChatComposerStateContext'
import { useMcpRuntimeContext } from '@contexts/McpRuntimeContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { Button, IconButton, MenuItem } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import {
  IconAttachFile,
  IconClose,
  IconConnectors,
  IconContexts,
  IconPlus,
  IconUpload,
  IconWorkflows,
} from '@components/SidebarNav/icons'
import {
  SHOW_AGENT_FILES_UI,
  SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM,
} from '@constants/agentFeatures'
import {
  COMPOSER_ACCEPT_IMAGE_MIME_TYPES,
  COMPOSER_MAX_IMAGE_ATTACHMENTS,
  COMPOSER_MAX_IMAGE_BYTES,
  ZAI_IMAGE_ATTACHMENT_UNSUPPORTED_MESSAGE,
} from '@constants/attachments'
import { useContextsDataController } from '@hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useClickOutside } from '@hooks/useClickOutside'
import { useComposerDraft } from '@hooks/useComposerDraft'
import type { WorkflowRecipeListResult } from '../../../../src/types'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '../../uiTypes'
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

function getComposerReferenceIcon(attachment: ComposerReferenceAttachment) {
  if (attachment.type === 'plugin') return <IconWorkflows />
  if (attachment.type === 'connector') return <IconConnectors />
  if (attachment.type === 'global_file') return <GfsFileIcon name={attachment.label} />
  return <IconContexts />
}

export function ComposerPanel({ inline = false, agentSelector }: ComposerPanelProps) {
  const { selectedAgent } = useNavigationContext()
  const {
    composerImageAttachments,
    composerReferenceAttachments,
    agentSending,
    agentError,
    failedAgentSend,
    activeChatId,
    activeMessageCount,
  } = useChatComposerStateContext()
  const {
    clearComposerSendError,
    handleAddComposerImageAttachments: onAddComposerImageAttachments,
    handleUpdateComposerImageAttachment: onUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment: onRemoveComposerImageAttachment,
    handleAddComposerReferenceAttachments: onAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment: onRemoveComposerReferenceAttachment,
    handleSendAgentMessage: onSend,
    handleRetryFailedAgentSend: onRetryFailedSend,
  } = useAgentChatActionsContext()
  const { hostRuntimeStatus, activeLlmProvider } = useMcpRuntimeContext()
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
  const [composerSubmenu, setComposerSubmenu] = useState<
    'plugins' | 'connectors' | 'agent-files' | null
  >(null)
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
  const [draft, setDraft] = useComposerDraft(activeChatId)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const composerInputWidthRef = useRef<number | null>(null)
  const composerFileInputRef = useRef<HTMLInputElement | null>(null)
  const composerMenuRef = useRef<HTMLSpanElement | null>(null)

  const activeProviderDoesNotSupportImages = activeLlmProvider === 'zai'
  const selectedAgentContext = selectedAgent
    ? String(agentContextByName[selectedAgent] || '').trim()
    : ''
  const agentFilesState = selectedAgentContext ? sharedFilesByContext[selectedAgentContext] : null
  const agentFilesLoading = Boolean(
    selectedAgentContext && (!agentFilesState?.loaded || agentFilesState.loading)
  )
  const agentFilesAvailable = Boolean(agentFilesState?.items?.length)
  const agentFilesDisabled = agentFilesLoading || !agentFilesAvailable

  useClickOutside(composerMenuRef, composerMenuOpen, () => {
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
  })

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
    setComposerSubmenu(null)
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
  const handleSend = useCallback(() => {
    void onSend(draft)
  }, [onSend, draft])

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
      setComposerSubmenu(null)
      setComposerAttachmentError(null)
    },
    [onAddComposerReferenceAttachments]
  )

  const openUploadPicker = useCallback(() => {
    if (activeProviderDoesNotSupportImages) {
      setComposerAttachmentError(ZAI_IMAGE_ATTACHMENT_UNSUPPORTED_MESSAGE)
      return
    }
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
    composerFileInputRef.current?.click()
  }, [activeProviderDoesNotSupportImages])

  const openAgentFilesModal = useCallback(() => {
    if (agentFilesLoading) {
      setComposerAttachmentError('Loading Agent Files...')
      return
    }
    if (!selectedAgentContext || !agentFilesAvailable) {
      setComposerAttachmentError('No Agent Files Available')
      setComposerMenuOpen(false)
      setComposerSubmenu(null)
      return
    }
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
    setAgentFilesModalOpen(true)
  }, [agentFilesAvailable, agentFilesLoading, selectedAgentContext])

  const openGlobalFilesModal = useCallback(() => {
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
    setComposerAttachmentError(null)
    setGlobalFilesModalOpen(true)
  }, [])

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
      if (activeProviderDoesNotSupportImages) {
        setComposerAttachmentError(ZAI_IMAGE_ATTACHMENT_UNSUPPORTED_MESSAGE)
        return
      }

      const candidates = Array.from(files || [])
      if (!candidates.length) return

      const availableSlots = COMPOSER_MAX_IMAGE_ATTACHMENTS - composerImageAttachments.length
      if (availableSlots <= 0) {
        setComposerAttachmentError(
          `You can attach up to ${COMPOSER_MAX_IMAGE_ATTACHMENTS} images per message.`
        )
        return
      }

      const accepted: ComposerImageAttachment[] = []
      const validationErrors: string[] = []
      const selected = candidates.slice(0, availableSlots)

      for (const [index, file] of selected.entries()) {
        const mimeType = inferComposerImageMimeType(file)
        if (!mimeType || !COMPOSER_ACCEPT_IMAGE_MIME_TYPES.includes(mimeType)) {
          validationErrors.push(`${file.name || 'Image'} is not supported. Use PNG or JPEG.`)
          continue
        }
        if (file.size > COMPOSER_MAX_IMAGE_BYTES) {
          validationErrors.push(
            `${file.name || 'Image'} is too large. Max size is ${Math.round(
              COMPOSER_MAX_IMAGE_BYTES / (1024 * 1024)
            )} MB.`
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
      activeProviderDoesNotSupportImages,
      buildAttachmentName,
      composerImageAttachments.length,
      inferComposerImageMimeType,
      onAddComposerImageAttachments,
      readFileAsDataUrl,
      createPreviewUrl,
      revokePreviewUrl,
    ]
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
      const imageFiles = [...dedupedBySignature.values()].filter(file => {
        const mimeType = inferComposerImageMimeType(file)
        return mimeType ? COMPOSER_ACCEPT_IMAGE_MIME_TYPES.includes(mimeType) : false
      })
      if (!imageFiles.length) return
      event.preventDefault()
      void prepareComposerImageAttachments(imageFiles, 'clipboard')
    },
    [inferComposerImageMimeType, prepareComposerImageAttachments]
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
      void prepareComposerImageAttachments(files, 'picker')
    },
    [hasDragFiles, prepareComposerImageAttachments]
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
    return [...referenceItems, ...imageItems].sort(
      (a, b) => a.order - b.order || a.fallbackIndex - b.fallbackIndex
    )
  }, [composerImageAttachments, composerReferenceAttachments])

  const isDegraded = hostRuntimeStatus?.degraded?.reason === 'llm_key_missing'
  const hasComposerAttachments = composerAttachmentItems.length > 0

  return (
    <div className={`composer ${inline ? 'composer-inline' : 'composer-shell-footer'}`}>
      <input
        ref={composerFileInputRef}
        type="file"
        accept={COMPOSER_ACCEPT_IMAGE_MIME_TYPES.join(',')}
        multiple
        className="composer-file-input"
        onChange={event => {
          const selectedFiles = event.target.files
          if (selectedFiles && selectedFiles.length > 0) {
            void prepareComposerImageAttachments(selectedFiles, 'picker')
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
          <textarea
            key={activeChatId ?? 'no-chat'}
            ref={composerInputRef}
            data-testid="chat-input"
            aria-label="Agent message composer"
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
            <span className="composer-reference-menu" ref={composerMenuRef}>
              <IconButton
                className="composer-reference-trigger"
                color="neutral"
                disabled={agentSending}
                label="Add context"
                size="sm"
                variant="ghost"
                aria-haspopup="menu"
                aria-expanded={composerMenuOpen}
                onClick={() => {
                  setComposerMenuOpen(open => !open)
                  setComposerSubmenu(null)
                }}
              >
                <IconPlus />
              </IconButton>
              {composerMenuOpen ? (
                <span className="composer-reference-menu-panel" role="menu">
                  <span className="composer-reference-menu-primary">
                    <MenuItem
                      leadingIcon={<IconWorkflows />}
                      onMouseEnter={() => setComposerSubmenu('plugins')}
                      onFocus={() => setComposerSubmenu('plugins')}
                      role="menuitem"
                      trailingIcon={<span aria-hidden="true">&gt;</span>}
                    >
                      Plugins
                    </MenuItem>
                    <MenuItem
                      leadingIcon={<IconConnectors />}
                      onMouseEnter={() => setComposerSubmenu('connectors')}
                      onFocus={() => setComposerSubmenu('connectors')}
                      role="menuitem"
                      trailingIcon={<span aria-hidden="true">&gt;</span>}
                    >
                      Connectors
                    </MenuItem>
                    {SHOW_AGENT_FILES_UI ? (
                      <MenuItem
                        aria-disabled={agentFilesDisabled}
                        className={
                          agentFilesDisabled ? 'composer-reference-menu-item-disabled' : undefined
                        }
                        leadingIcon={<IconContexts />}
                        onClick={agentFilesDisabled ? undefined : openAgentFilesModal}
                        onFocus={() =>
                          setComposerSubmenu(agentFilesDisabled ? 'agent-files' : null)
                        }
                        onMouseEnter={() =>
                          setComposerSubmenu(agentFilesDisabled ? 'agent-files' : null)
                        }
                        role="menuitem"
                        trailingIcon={
                          agentFilesDisabled ? <span aria-hidden="true">&gt;</span> : undefined
                        }
                      >
                        Agent Files
                      </MenuItem>
                    ) : null}
                    {SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM ? (
                      <MenuItem
                        leadingIcon={<IconAttachFile />}
                        onClick={openGlobalFilesModal}
                        role="menuitem"
                      >
                        Global File System
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      leadingIcon={<IconUpload />}
                      onClick={openUploadPicker}
                      role="menuitem"
                    >
                      Upload Files
                    </MenuItem>
                  </span>
                  {composerSubmenu === 'plugins' ? (
                    <span
                      className="composer-reference-submenu composer-reference-submenu--plugins"
                      role="menu"
                    >
                      {pluginsLoading ? (
                        <span className="composer-reference-menu-empty">Loading plugins...</span>
                      ) : pluginsError ? (
                        <span className="composer-reference-menu-empty">{pluginsError}</span>
                      ) : pluginOptions.length ? (
                        pluginOptions.map(plugin => (
                          <MenuItem
                            key={plugin.id}
                            onClick={() =>
                              addComposerReference({
                                id: plugin.id,
                                type: 'plugin',
                                namespace: plugin.namespace,
                                name: plugin.name,
                                label: plugin.label,
                              })
                            }
                            role="menuitem"
                          >
                            {plugin.label}
                          </MenuItem>
                        ))
                      ) : (
                        <span className="composer-reference-menu-empty">No plugins available</span>
                      )}
                    </span>
                  ) : null}
                  {composerSubmenu === 'connectors' ? (
                    <span
                      className="composer-reference-submenu composer-reference-submenu--connectors"
                      role="menu"
                    >
                      {connectorOptions.length ? (
                        connectorOptions.map(connector => (
                          <MenuItem
                            key={connector.id}
                            onClick={() =>
                              addComposerReference({
                                id: connector.id,
                                type: 'connector',
                                name: connector.name,
                                label: connector.label,
                              })
                            }
                            role="menuitem"
                          >
                            {connector.label}
                          </MenuItem>
                        ))
                      ) : (
                        <span className="composer-reference-menu-empty">
                          No connectors available
                        </span>
                      )}
                    </span>
                  ) : null}
                  {SHOW_AGENT_FILES_UI && composerSubmenu === 'agent-files' ? (
                    <span
                      className="composer-reference-submenu composer-reference-submenu--agent-files"
                      role="menu"
                    >
                      <span className="composer-reference-menu-empty">
                        {agentFilesLoading ? 'Loading Agent Files...' : 'No Agent Files Available'}
                      </span>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
            {hasComposerAttachments ? (
              <span className="composer-attachments-list composer-attachments-list--inline">
                {composerAttachmentItems.map(item => {
                  if (item.kind === 'reference') {
                    const attachment = item.attachment
                    const typeLabel = getComposerReferenceTypeLabel(attachment.type)
                    return (
                      <span key={item.id} className="composer-attachment-chip" title={typeLabel}>
                        <span
                          className={`composer-reference-icon composer-reference-icon--${attachment.type}`}
                          aria-hidden="true"
                        >
                          {getComposerReferenceIcon(attachment)}
                        </span>
                        <span className="composer-attachment-chip-body">
                          <strong>{attachment.label}</strong>
                        </span>
                        <IconButton
                          className="composer-attachment-remove"
                          onClick={() => onRemoveComposerReferenceAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.label}`}
                          label={`Remove ${attachment.label}`}
                          size="xs"
                          variant="ghost"
                        >
                          <IconClose />
                        </IconButton>
                      </span>
                    )
                  }
                  const attachment = item.attachment
                  const tooltip = getComposerImageTooltip(attachment)
                  return (
                    <span key={item.id} className="composer-attachment-chip" title={tooltip}>
                      <button
                        type="button"
                        className="composer-attachment-preview-trigger"
                        onClick={() => setPreviewAttachmentId(attachment.id)}
                        title={tooltip}
                      >
                        <span
                          className="composer-reference-icon composer-reference-icon--uploaded-image"
                          aria-hidden="true"
                        >
                          <IconAttachFile />
                        </span>
                        <span className="composer-attachment-chip-body">
                          <strong>{attachment.name}</strong>
                        </span>
                      </button>
                      <IconButton
                        className="composer-attachment-remove"
                        onClick={() => onRemoveComposerImageAttachment(attachment.id)}
                        aria-label={`Remove ${attachment.name}`}
                        label={`Remove ${attachment.name}`}
                        size="xs"
                        variant="ghost"
                      >
                        <IconClose />
                      </IconButton>
                    </span>
                  )
                })}
              </span>
            ) : null}
          </span>
          <span className="composer-actions-right">
            {selectedAgent && (
              // Rendered even before a chat exists (new-chat composer): with an
              // empty chatId the selector shows the host default and holds the pick
              // locally, and the first send piggybacks it onto message 1 (R2).
              <ModelSelector agentRef={selectedAgent} chatId={activeChatId ?? ''} placement="up" />
            )}
            <IconButton
              data-testid="send-button"
              className="composer-send-button composer-send-button-compact composer-send-icon-btn"
              onClick={handleSend}
              disabled={
                isDegraded ||
                agentSending ||
                (!draft.trim() &&
                  composerImageAttachments.length === 0 &&
                  composerReferenceAttachments.length === 0)
              }
              aria-label={agentSending ? 'Sending message' : 'Send message'}
              label={agentSending ? 'Sending message' : 'Send message'}
              size="sm"
              title={agentSending ? 'Sending...' : 'Send message'}
              variant="solid"
            >
              {agentSending ? (
                <span className="composer-send-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 5v9.1" />
                  <path d="M6.7 8.3 10 5l3.3 3.3" />
                </svg>
              )}
            </IconButton>
          </span>
        </div>
      </div>
      {composerAttachmentError && (
        <div className="composer-attachments">
          <p className="composer-attachment-error" role="alert">
            {composerAttachmentError}
          </p>
        </div>
      )}
      {agentError ? (
        <div className="composer-footer">
          {failedAgentSend?.kind === 'waking' ? (
            <div className="composer-error" role="status" data-testid="waking-state">
              <p className="error-text">
                Agent is waking up — this usually takes under a minute. Your message was not
                delivered yet.
              </p>
              <div className="action-row">
                <Button
                  color="neutral"
                  onClick={onRetryFailedSend}
                  disabled={agentSending}
                  size="xs"
                  variant="ghost"
                >
                  Retry last send
                </Button>
              </div>
            </div>
          ) : (
            <div className="composer-error" role="alert">
              <p className="error-text">{agentError}</p>
              {failedAgentSend?.message ? (
                <details className="error-details">
                  <summary>Technical details</summary>
                  <pre>{failedAgentSend.message}</pre>
                </details>
              ) : null}
              <div className="action-row">
                {failedAgentSend && (
                  <Button
                    color="neutral"
                    onClick={onRetryFailedSend}
                    disabled={agentSending}
                    size="xs"
                    variant="ghost"
                  >
                    Retry last send
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {previewAttachment && (
        <AnnotationCanvas
          attachment={previewAttachment}
          onSave={onUpdateComposerImageAttachment}
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
          onAdd={onAddComposerReferenceAttachments}
          onClose={() => setGlobalFilesModalOpen(false)}
        />
      ) : null}
    </div>
  )
}
