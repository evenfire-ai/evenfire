import mermaid from 'mermaid'
import { createDiagramDrawer } from './drawDiagram'

async function decodes(src: string): Promise<boolean> {
  const image = new Image()
  image.src = src
  try {
    await image.decode()
    return image.naturalWidth > 0
  } catch {
    return false
  }
}

// The main process calls this through executeJavaScript: the page has no preload.
;(window as unknown as { __drawDiagram: unknown }).__drawDiagram = createDiagramDrawer({
  mermaid,
  decodes,
})
