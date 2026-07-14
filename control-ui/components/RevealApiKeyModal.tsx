'use client'
import { useEffect, useRef, useState } from 'react'
import { useToast } from './Toast'
import { Button } from './ui'

export default function RevealApiKeyModal({
  apiKey,
  onClose,
}: {
  apiKey: string
  onClose: () => void
}) {
  const { showToast } = useToast()
  const [revealed, setRevealed] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    copyRef.current?.focus()
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey)
      showToast('Copied to clipboard.', { tone: 'success' })
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <div className="cu-modal-overlay" role="presentation">
      <div
        className="cu-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reveal-key-title"
      >
        <h3 id="reveal-key-title" className="cu-modal-panel__title">
          API key created
        </h3>
        <div className="cu-banner cu-banner--warn" role="alert">
          <strong>This is the only time this key will be displayed.</strong> Copy it now — after you
          close this dialog it cannot be retrieved.
        </div>
        <div className="cu-modal-actions">
          {revealed ? <code>{apiKey}</code> : <code>••••••••••••••••</code>}
          <Button type="button" variant="ghost" size="sm" onClick={() => setRevealed(v => !v)}>
            {revealed ? 'Hide' : 'Reveal'}
          </Button>
          {/* ref requires a native button element since Button does not use forwardRef */}
          <button
            ref={copyRef}
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            onClick={copy}
          >
            Copy
          </button>
        </div>
        {copyFailed ? (
          <p className="cu-field__hint" role="status">
            Could not copy to clipboard. Reveal the key, then select and copy manually.
          </p>
        ) : null}
        <div className="cu-modal-actions">
          <Button type="button" variant="primary" onClick={onClose}>
            I&apos;ve saved it
          </Button>
        </div>
      </div>
    </div>
  )
}
