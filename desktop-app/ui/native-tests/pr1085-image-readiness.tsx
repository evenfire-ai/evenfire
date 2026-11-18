import { createRoot } from 'react-dom/client'
import { GfsImagePreviewBody } from '@components/GfsImagePreview/Body'

const valid = new URLSearchParams(window.location.search).get('kind') === 'valid'
const bytes = valid
  ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII='
  : 'AQID'
const probe = {
  kind: valid ? 'valid' : 'invalid',
  decoded: false,
  failed: false,
  writes: 0,
  writesBeforeDecode: 0,
  done: false,
}
;(window as unknown as { __imageProbe: typeof probe }).__imageProbe = probe
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    write: async () => {
      probe.writes += 1
      if (!probe.decoded) probe.writesBeforeDecode += 1
    },
  },
})
Object.defineProperty(window, 'ClipboardItem', {
  configurable: true,
  value: class ClipboardItem {},
})
document.addEventListener(
  'load',
  event => {
    if (event.target instanceof HTMLImageElement) {
      probe.decoded = event.target.naturalWidth > 0
      window.setTimeout(() => {
        probe.done = true
      }, 200)
    }
  },
  true
)
document.addEventListener(
  'error',
  event => {
    if (event.target instanceof HTMLImageElement) {
      probe.failed = true
      window.setTimeout(() => {
        probe.done = true
      }, 200)
    }
  },
  true
)
let invoked = false
createRoot(document.getElementById('root')!).render(
  <GfsImagePreviewBody
    dataBase64={bytes}
    byteLength={valid ? 68 : 3}
    fileName={valid ? 'valid.png' : 'invalid.png'}
    mimeType="image/png"
    onCopyContentReady={copy => {
      if (copy && !invoked) {
        invoked = true
        void copy()
      }
    }}
  />
)
