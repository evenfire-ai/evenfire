// The markdown/text preview no longer has a modal wrapper (spec 18 §3.B.2/§3.B.4):
// FilesPage opens previews in a workspace tab via FilePreviewPage, which mounts
// the de-modalized body directly. This module stays as the public barrel so
// `@components/GfsMarkdownPreview` keeps resolving to the body.
export { GfsMarkdownPreviewBody } from './Body'
export type { GfsMarkdownPreviewBodyProps } from './types'
