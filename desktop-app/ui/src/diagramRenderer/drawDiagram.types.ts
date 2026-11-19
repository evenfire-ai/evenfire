import type { Mermaid } from 'mermaid'

export type DiagramDrawerDeps = Readonly<{
  mermaid: Pick<Mermaid, 'initialize' | 'render'>
  /** Whether the browser decodes the URL as an image. */
  decodes: (src: string) => Promise<boolean>
}>
