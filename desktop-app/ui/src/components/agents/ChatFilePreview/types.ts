import type { ChatEndActions } from '@hooks/useNearChatViewport.types'
import type { ChatFilePreviewKind } from '@lib/chatFilePreview'
import type { ChatMessageSemanticModel } from '@lib/chatMessageSemantics'
import type { ChatMessageAttachment } from '../../../../../src/types'

export type ChatFilePreviewProps = {
  name: string
  kind: ChatFilePreviewKind
  bytes: ArrayBuffer
  /** Called when the preview changes size after its first paint. */
  onGrow?: () => void
}

export type ChatAttachmentPreviewsProps = {
  attachments: readonly ChatMessageAttachment[]
  chatEnd: ChatEndActions
}

export type ChatLinkedFilePreviewsProps = {
  files: readonly Readonly<{ uri: string; name: string }>[]
  chatEnd: ChatEndActions
}

export type ChatFileLoadState =
  | { status: 'idle' }
  | { status: 'ready'; name: string; bytes: ArrayBuffer }
  | { status: 'unavailable'; reason: string }

export type ChatMarkdownLayout = Readonly<{
  markdown: string
  model: ChatMessageSemanticModel | null
}>
