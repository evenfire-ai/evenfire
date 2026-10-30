import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useAuthContext } from '@contexts/AuthContext'
import { useChatComposerStateContext } from '@contexts/ChatComposerStateContext'
import { useMcpRuntimeContext } from '@contexts/McpRuntimeContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
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
  COMPOSER_MAX_ATTACHMENTS,
  type ComposerImageBudget,
  type ComposerImageTotalBudget,
  composerImageBudget,
  composerImageCountedBytes,
} from '@constants/attachments'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import { useContextsDataController } from '@hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useClickOutside } from '@hooks/useClickOutside'
import { useComposerDraft } from '@hooks/useComposerDraft'
import { useFlyoutPosition } from '@hooks/useFlyoutPosition'
import { useHostModels } from '@hooks/useHostModels'
import { resolveAgentCatalogAvailability } from '@lib/agentCatalogAvailability'
import { getComposerDraft, getComposerDraftRevision } from '@lib/composerDraftStore'
import { formatFileSize } from '@lib/composerFileAdmission'
import { prefillEmptyConversationWithGfsResource } from '@lib/gfsConversationPrefill'
import { readImageHeaderDimensions } from '@lib/imageHeaderDimensions'
import type { WorkflowRecipeListResult } from '../../../../src/types'
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerReferenceAttachment,
} from '../../uiTypes'
import { AnnotationCanvas } from './AnnotationCanvas'
import { ComposerAgentFilesModal } from './ComposerAgentFilesModal'
import { ComposerGfsLinkPicker, type ComposerGfsLinkSelection } from './ComposerGfsLinkPicker'
import { ComposerGlobalFilesModal } from './ComposerGlobalFilesModal'
import { ModelSelector } from './ModelSelector'

type ComposerPanelProps = {
  inline?: boolean
  agentSelector?: React.ReactNode
}

const COMPOSER_MAX_TEXT_HEIGHT = 240
const COMPOSER_MIN_TEXT_HEIGHT = 56
const COMPOSER_INLINE_MIN_TEXT_HEIGHT = 48

type GfsInsertionSession = {
  id: number
  chatId: string | null
  agent: string | null
  expectedDraft: string
  expectedRevision: number
  anchor: number
  controllerScope: string | null
}

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
  if (attachment.type === 'plugin') return <IconWorkflows />
  if (attachment.type === 'connector') return <IconConnectors />
  if (attachment.type === 'global_file') return <GfsFileIcon name={attachment.label} />
  return <IconContexts />
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
  const { me } = useAuthContext()
  const {
    composerImageAttachments,
    composerFileAttachments,
    composerFileRefusals,
    composerReferenceAttachments,
    agentSending,
    agentError,
    failedAgentSend,
    activeChatId,
    workspaceChatTabId,
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
  const agentCatalog = useAgentsDataController()

  const [composerAttachmentError, setComposerAttachmentError] = useState<string | null>(null)
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [composerSubmenu, setComposerSubmenu] = useState<
    'plugins' | 'connectors' | 'agent-files' | 'gfs' | null
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
  const [draft, setDraft] = useComposerDraft(
    activeChatId,
    selectedAgent ?? undefined,
    workspaceChatTabId
  )
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const composerInputWidthRef = useRef<number | null>(null)
  const composerFileInputRef = useRef<HTMLInputElement | null>(null)
  const composerInputShellRef = useRef<HTMLDivElement | null>(null)
  const composerMenuRef = useRef<HTMLSpanElement | null>(null)
  // The reference submenu is portaled out of the composer (the drawer's
  // overflow-clipping ancestors would otherwise crop it), so it needs an anchor
  // ref per primary item and its own ref for click-outside + positioning.
  const composerSubmenuRef = useRef<HTMLSpanElement | null>(null)
  const gfsInsertionSessionRef = useRef<GfsInsertionSession | null>(null)
  const gfsInsertionSessionCounterRef = useRef(0)
  const gfsInsertionBusyRef = useRef(false)
  const composerIdentityRef = useRef({ chatId: activeChatId, agent: selectedAgent })
  composerIdentityRef.current = { chatId: activeChatId, agent: selectedAgent }
  const pluginsItemRef = useRef<HTMLButtonElement | null>(null)
  const connectorsItemRef = useRef<HTMLButtonElement | null>(null)
  const agentFilesItemRef = useRef<HTMLButtonElement | null>(null)
  const evenDriveLinkItemRef = useRef<HTMLButtonElement | null>(null)
  const composerSubmenuAnchorRef =
    composerSubmenu === 'gfs'
      ? evenDriveLinkItemRef
      : composerSubmenu === 'connectors'
        ? connectorsItemRef
        : composerSubmenu === 'agent-files'
          ? agentFilesItemRef
          : pluginsItemRef
  const submenuFlyoutPosition = useFlyoutPosition({
    anchorRef: composerSubmenuAnchorRef,
    flyoutRef: composerSubmenuRef,
    open: composerMenuOpen && composerSubmenu !== null,
    placement: 'right-of',
  })

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

  // Both refs: the submenu is portaled to document.body, so a mousedown on a
  // submenu item is outside `composerMenuRef` and would close the menu before
  // the item's click fires.
  useClickOutside([composerInputShellRef, composerSubmenuRef], composerMenuOpen, () => {
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
    gfsInsertionSessionRef.current = null
  })

  useEffect(() => {
    const session = gfsInsertionSessionRef.current
    if (!session) return
    if (session.chatId !== activeChatId || session.agent !== selectedAgent) {
      gfsInsertionSessionRef.current = null
      setComposerSubmenu(current => (current === 'gfs' ? null : current))
    }
  }, [activeChatId, selectedAgent])

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

  useEffect(() => {
    if (composerFocusRequestId === 0) return
    const textarea = composerInputRef.current
    if (!textarea || textarea.disabled || document.activeElement === textarea) return
    textarea.focus()
  }, [composerFocusRequestId])

  useEffect(() => {
    if (!activeChatId || !selectedAgent) return
    prefillEmptyConversationWithGfsResource(activeChatId, selectedAgent)
  }, [activeChatId, composerFocusRequestId, selectedAgent])

  const handleDraftChange = useCallback(
    (value: string, selectionStart?: number) => {
      const result = setDraft(value)
      const session = gfsInsertionSessionRef.current
      if (
        result.accepted &&
        session &&
        session.chatId === activeChatId &&
        session.agent === selectedAgent
      ) {
        session.expectedDraft = value
        session.expectedRevision = getComposerDraftRevision(
          activeChatId,
          selectedAgent ?? undefined
        )
        session.anchor = selectionStart ?? value.length
      }
      // Clear any pending send error as the user resumes typing. No re-render up-tree
      // unless an error is actually present.
      if (result.accepted) clearComposerSendError()
    },
    [activeChatId, clearComposerSendError, selectedAgent, setDraft]
  )

  const rememberGfsInsertionAnchor = useCallback(() => {
    const session = gfsInsertionSessionRef.current
    const textarea = composerInputRef.current
    if (
      !session ||
      !textarea ||
      session.chatId !== activeChatId ||
      session.agent !== selectedAgent
    ) {
      return
    }
    const currentDraft = getComposerDraft(activeChatId, selectedAgent ?? undefined)
    session.expectedDraft = currentDraft
    session.expectedRevision = getComposerDraftRevision(activeChatId, selectedAgent ?? undefined)
    session.anchor = textarea.selectionEnd
  }, [activeChatId, selectedAgent])

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
  const accessCatalog = agentCatalog.accessCatalog
  const agentCatalogMatchesSession = Boolean(
    me && accessCatalog && accessCatalog.userId === me.id && accessCatalog.teamId === me.teamId
  )
  const selectedAgentCatalogState = resolveAgentCatalogAvailability({
    selectedAgent,
    loading: agentCatalog.loading,
    error: agentCatalog.error,
    catalogMatchesSession: agentCatalogMatchesSession,
    agentNames: agentCatalog.agentNames,
  })
  const selectedAgentCatalogMessage =
    selectedAgentCatalogState === 'checking'
      ? 'Checking agent access for this team…'
      : selectedAgentCatalogState === 'error'
        ? 'Could not verify agent access for this team. Retry the check before sending.'
        : selectedAgentCatalogState === 'unavailable'
          ? `${selectedAgent} is unavailable in this team. Select an available agent to send.`
          : null
  const selectedAgentSendBlocked =
    selectedAgentCatalogState !== 'ready' && selectedAgentCatalogState !== 'available'
  const agentCatalogNoticeId = useId()
  const handleSend = useCallback(() => {
    if (imagesBlockedForSend || filesBlockedForSend || selectedAgentSendBlocked) {
      return
    }
    if (workspaceChatTabId) void onSend(draft, workspaceChatTabId)
    else void onSend(draft)
  }, [
    onSend,
    draft,
    imagesBlockedForSend,
    filesBlockedForSend,
    selectedAgentSendBlocked,
    workspaceChatTabId,
  ])

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
      gfsInsertionSessionRef.current = null
      setComposerAttachmentError(null)
    },
    [onAddComposerReferenceAttachments]
  )

  const openUploadPicker = useCallback(() => {
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
    gfsInsertionSessionRef.current = null
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
      setComposerSubmenu(null)
      return
    }
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
    gfsInsertionSessionRef.current = null
    setAgentFilesModalOpen(true)
  }, [agentFilesAvailable, agentFilesLoading, selectedAgentContext])

  const openGlobalFilesModal = useCallback(() => {
    setComposerMenuOpen(false)
    setComposerSubmenu(null)
    gfsInsertionSessionRef.current = null
    setComposerAttachmentError(null)
    setGlobalFilesModalOpen(true)
  }, [])

  const openGfsLinkPicker = useCallback(() => {
    const textarea = composerInputRef.current
    const currentDraft = getComposerDraft(activeChatId, selectedAgent ?? undefined)
    gfsInsertionSessionRef.current = {
      id: ++gfsInsertionSessionCounterRef.current,
      chatId: activeChatId,
      agent: selectedAgent,
      expectedDraft: currentDraft,
      expectedRevision: getComposerDraftRevision(activeChatId, selectedAgent ?? undefined),
      anchor: textarea?.selectionEnd ?? currentDraft.length,
      controllerScope: null,
    }
    setComposerMenuOpen(true)
    setComposerSubmenu('gfs')
    setComposerAttachmentError(null)
  }, [activeChatId, selectedAgent])

  const captureGfsControllerScope = useCallback((sessionId: number, scope: string) => {
    const session = gfsInsertionSessionRef.current
    if (session?.id === sessionId && session.controllerScope === null) {
      session.controllerScope = scope
    }
  }, [])

  useEffect(() => {
    if (!composerMenuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (composerSubmenu !== null) {
        setComposerSubmenu(null)
        gfsInsertionSessionRef.current = null
      } else {
        setComposerMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [composerMenuOpen, composerSubmenu])

  const insertGfsLink = useCallback(
    ({ uri }: ComposerGfsLinkSelection, controllerScope: string, sessionId: number) => {
      const session = gfsInsertionSessionRef.current
      if (!session || gfsInsertionBusyRef.current) return
      if (session.id !== sessionId) return
      if (
        session.chatId !== composerIdentityRef.current.chatId ||
        session.agent !== composerIdentityRef.current.agent ||
        session.chatId !== activeChatId ||
        session.agent !== selectedAgent ||
        session.controllerScope !== controllerScope
      ) {
        gfsInsertionSessionRef.current = null
        setComposerSubmenu(null)
        return
      }
      const currentDraft = getComposerDraft(activeChatId, selectedAgent ?? undefined)
      const currentRevision = getComposerDraftRevision(activeChatId, selectedAgent ?? undefined)
      if (currentDraft !== session.expectedDraft || currentRevision !== session.expectedRevision) {
        gfsInsertionSessionRef.current = null
        setComposerSubmenu(null)
        return
      }
      const canonicalUri = normalizeGfsResourceUri(uri)
      if (!canonicalUri) return

      gfsInsertionBusyRef.current = true
      const anchor = Math.max(0, Math.min(session.anchor, currentDraft.length))
      const insertion = `${canonicalUri} `
      const nextDraft = `${currentDraft.slice(0, anchor)}${insertion}${currentDraft.slice(anchor)}`
      const nextAnchor = anchor + insertion.length
      setDraft(nextDraft)
      session.expectedDraft = nextDraft
      session.expectedRevision = getComposerDraftRevision(activeChatId, selectedAgent ?? undefined)
      session.anchor = nextAnchor
      window.requestAnimationFrame(() => {
        const textarea = composerInputRef.current
        if (
          !textarea ||
          activeChatId !== session.chatId ||
          selectedAgent !== session.agent ||
          gfsInsertionSessionRef.current?.id !== session.id
        ) {
          gfsInsertionBusyRef.current = false
          return
        }
        textarea.focus()
        textarea.setSelectionRange(nextAnchor, nextAnchor)
        resizeComposerInput()
        gfsInsertionBusyRef.current = false
      })
    },
    [activeChatId, resizeComposerInput, selectedAgent, setDraft]
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
        ref={composerInputShellRef}
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
              handleDraftChange(event.target.value, event.target.selectionEnd)
              resizeComposerInput()
            }}
            onClick={rememberGfsInsertionAnchor}
            onKeyUp={rememberGfsInsertionAnchor}
            onSelect={rememberGfsInsertionAnchor}
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
                  setComposerMenuOpen(open => {
                    if (open) gfsInsertionSessionRef.current = null
                    return !open
                  })
                  setComposerSubmenu(null)
                }}
              >
                <IconPlus />
              </IconButton>
              {composerMenuOpen ? (
                <span className="composer-reference-menu-panel" role="menu">
                  <span className="composer-reference-menu-primary">
                    <MenuItem
                      ref={pluginsItemRef}
                      aria-haspopup="menu"
                      aria-expanded={composerSubmenu === 'plugins'}
                      leadingIcon={<IconWorkflows />}
                      onMouseEnter={() => setComposerSubmenu('plugins')}
                      onFocus={() => setComposerSubmenu('plugins')}
                      role="menuitem"
                      trailingIcon={<span aria-hidden="true">&gt;</span>}
                    >
                      Plugins
                    </MenuItem>
                    <MenuItem
                      ref={connectorsItemRef}
                      aria-haspopup="menu"
                      aria-expanded={composerSubmenu === 'connectors'}
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
                        ref={agentFilesItemRef}
                        aria-disabled={agentFilesDisabled}
                        aria-haspopup={agentFilesDisabled ? 'menu' : undefined}
                        aria-expanded={
                          agentFilesDisabled ? composerSubmenu === 'agent-files' : undefined
                        }
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
                        Attach EvenDrive files
                      </MenuItem>
                    ) : null}
                    {SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM ? (
                      <MenuItem
                        ref={evenDriveLinkItemRef}
                        aria-haspopup="menu"
                        aria-expanded={composerSubmenu === 'gfs'}
                        leadingIcon={<IconContexts />}
                        onClick={openGfsLinkPicker}
                        role="menuitem"
                        trailingIcon={<span aria-hidden="true">&gt;</span>}
                      >
                        Insert EvenDrive link
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
                </span>
              ) : null}
              {/* The submenu is portaled to document.body and positioned with a
                  fixed rect confined to the chat drawer. In-flow it was cropped
                  by the drawer's overflow-clipping ancestors and the native
                  embed painting over it; see useFlyoutPosition. */}
              {composerMenuOpen && composerSubmenu !== null
                ? createPortal(
                    <span
                      className="composer-reference-submenu"
                      ref={composerSubmenuRef}
                      role="menu"
                      style={{
                        left: submenuFlyoutPosition?.left ?? 0,
                        top: submenuFlyoutPosition?.top ?? 0,
                        // Hidden at the origin until the first layout pass sets a
                        // real rect, so it never flashes in the top-left corner.
                        visibility: submenuFlyoutPosition ? undefined : 'hidden',
                      }}
                    >
                      {composerSubmenu === 'gfs' ? (
                        <ComposerGfsLinkPicker
                          sessionId={gfsInsertionSessionRef.current?.id ?? 0}
                          onInsert={insertGfsLink}
                          onSessionScope={captureGfsControllerScope}
                          onEscapeRoot={() => {
                            gfsInsertionSessionRef.current = null
                            evenDriveLinkItemRef.current?.focus()
                            setComposerSubmenu(null)
                          }}
                        />
                      ) : composerSubmenu === 'plugins' ? (
                        pluginsLoading ? (
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
                          <span className="composer-reference-menu-empty">
                            No plugins available
                          </span>
                        )
                      ) : composerSubmenu === 'connectors' ? (
                        connectorOptions.length ? (
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
                        )
                      ) : SHOW_AGENT_FILES_UI && composerSubmenu === 'agent-files' ? (
                        <span className="composer-reference-menu-empty">
                          {agentFilesLoading
                            ? 'Loading Agent Files...'
                            : 'No Agent Files Available'}
                        </span>
                      ) : null}
                    </span>,
                    document.body
                  )
                : null}
            </span>
            {hasComposerAttachments ? (
              <span className="composer-attachments-list composer-attachments-list--inline">
                <span
                  className="composer-attachments-count"
                  data-testid="composer-attachments-count"
                >
                  {composerAttachmentItems.length}{' '}
                  {composerAttachmentItems.length === 1 ? 'attachment' : 'attachments'}
                </span>
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
                  if (item.kind === 'file') {
                    const attachment = item.attachment
                    const meta = getComposerFileMeta(attachment)
                    return (
                      <span
                        key={item.id}
                        className="composer-attachment-chip"
                        title={`${attachment.filename} - ${meta}`}
                        data-testid="composer-file-chip"
                        data-file-status={attachment.status}
                      >
                        <span
                          className="composer-reference-icon composer-reference-icon--uploaded-file"
                          aria-hidden="true"
                        >
                          <IconAttachFile />
                        </span>
                        <span className="composer-attachment-chip-body">
                          <strong>{attachment.filename}</strong>
                          <span className="composer-attachment-chip-meta">{meta}</span>
                        </span>
                        <IconButton
                          className="composer-attachment-remove"
                          onClick={() => onRemoveComposerFileAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.filename}`}
                          label={`Remove ${attachment.filename}`}
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
                <button
                  type="button"
                  className="composer-attachments-clear"
                  onClick={onClearComposerAttachments}
                  aria-label="Clear all attachments"
                >
                  Clear all
                </button>
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
                imagesBlockedForSend ||
                filesBlockedForSend ||
                selectedAgentSendBlocked ||
                (!draft.trim() &&
                  composerImageAttachments.length === 0 &&
                  composerFileAttachments.length === 0 &&
                  composerReferenceAttachments.length === 0)
              }
              aria-label={agentSending ? 'Sending message' : 'Send message'}
              aria-describedby={
                [
                  imagesBlockedForSend ? imageNoticeId : null,
                  selectedAgentCatalogMessage ? agentCatalogNoticeId : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
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
      {imagesBlockedForSend || composerAttachmentError ? (
        <div className="composer-attachments">
          <p
            className="composer-attachment-error"
            role="alert"
            id={imagesBlockedForSend ? imageNoticeId : undefined}
            data-testid={imagesBlockedForSend ? 'composer-image-capability-notice' : undefined}
          >
            {imagesBlockedForSend
              ? (imageAttachmentBlockMessage ??
                'Image attachments are not available for this model yet.')
              : composerAttachmentError}
          </p>
        </div>
      ) : null}
      {selectedAgentCatalogMessage ? (
        <div className="composer-attachments">
          <p
            className={
              selectedAgentCatalogState === 'checking'
                ? 'composer-attachment-notice'
                : 'composer-attachment-error'
            }
            role={selectedAgentCatalogState === 'checking' ? 'status' : 'alert'}
            id={agentCatalogNoticeId}
            data-testid="composer-agent-catalog-notice"
          >
            {selectedAgentCatalogMessage}
          </p>
          {selectedAgentCatalogState === 'error' ? (
            <Button
              disabled={agentCatalog.loading}
              onClick={() => void agentCatalog.refresh()}
              size="sm"
              variant="ghost"
            >
              Retry access check
            </Button>
          ) : null}
        </div>
      ) : null}
      {composerFileNotices.length > 0 ? (
        <div className="composer-attachments" data-testid="composer-file-notices">
          {composerFileNotices.map(notice => (
            <p
              key={notice.id}
              className={
                notice.refused ? 'composer-attachment-error' : 'composer-attachment-notice'
              }
              role={notice.refused ? 'alert' : 'status'}
            >
              {notice.text}
            </p>
          ))}
        </div>
      ) : null}
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
                {/* A message answered without its documents is never resent. */}
                {failedAgentSend && !failedAgentSend.answeredWithoutFiles && (
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
      {failedAgentSend ? (
        <div className="composer-footer">
          <div className="action-row">
            <Button
              onClick={() => onRecoverFailedSend(workspaceChatTabId)}
              disabled={agentSending}
              size="xs"
              variant="ghost"
            >
              {failedAgentSend.answeredWithoutFiles ? 'Recover files' : 'Recover input'}
            </Button>
            <Button onClick={onDiscardFailedSend} disabled={agentSending} size="xs" variant="ghost">
              Discard failed input
            </Button>
          </div>
        </div>
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
