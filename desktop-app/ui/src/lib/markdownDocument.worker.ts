import {
  CHAT_FILE_PREVIEW_MARKDOWN_MAX_ELEMENTS,
  CHAT_FILE_PREVIEW_MAX_LAYOUT_COST,
} from '@constants/chatRendering'
import { buildMarkdownDocumentModel, countElements } from './chatMessageSemantics'
import { documentLayoutCost } from './layoutCost'
import type { MarkdownDocumentRequest } from './markdownDocument.types'

self.onmessage = (event: MessageEvent<MarkdownDocumentRequest>) => {
  const model = buildMarkdownDocumentModel(event.data.id, event.data.markdown)
  const drawable =
    model.representation === 'markdown' &&
    countElements(model.renderTree) <= CHAT_FILE_PREVIEW_MARKDOWN_MAX_ELEMENTS &&
    documentLayoutCost(model, CHAT_FILE_PREVIEW_MAX_LAYOUT_COST) <=
      CHAT_FILE_PREVIEW_MAX_LAYOUT_COST
  self.postMessage(drawable ? model : null)
}
