'use client'

import { useEffect, useRef, useState } from 'react'
import type { CreatedRegistryApiKey } from '../lib/api'
import {
  buildDockerLoginCommand,
  buildPushCoordinate,
  resolveDockerCredential,
} from './PublisherView/dockerCredential'
import { useToast } from './Toast'
import { Button } from './ui'

export default function RevealApiKeyModal({
  created,
  orgScope,
  onClose,
}: {
  created: CreatedRegistryApiKey
  orgScope: string
  onClose: () => void
}) {
  const { showToast } = useToast()
  const [revealed, setRevealed] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyRef = useRef<HTMLButtonElement>(null)

  const apiKey = created.key
  // Only a registry:publish key can push images, and only then does the registry
  // return the push-credential fields — so the Docker section shows for those.
  const isPushCredential = created.scopes.includes('registry:publish')
  const { registry, dockerconfigjson } = resolveDockerCredential(created)
  const loginCmd = buildDockerLoginCommand(registry, apiKey)
  const pushCoordinate = buildPushCoordinate(registry, orgScope)

  useEffect(() => {
    copyRef.current?.focus()
  }, [])

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      showToast(`${label} copied.`, { tone: 'success' })
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
    }
  }

  function downloadDockerconfig() {
    const blob = new Blob([dockerconfigjson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'dockerconfigjson.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="cu-modal-overlay" role="presentation">
      <div
        className={`cu-modal${isPushCredential ? ' cu-modal--wide' : ''}`}
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
            onClick={() => copy(apiKey, 'API key')}
          >
            Copy
          </button>
        </div>
        {copyFailed ? (
          <p className="cu-field__hint" role="status">
            Could not copy to clipboard. Reveal the key, then select and copy manually.
          </p>
        ) : null}

        {isPushCredential ? (
          <div className="cu-field">
            <label>Use with Docker</label>
            <p className="cu-field__hint">
              This key is also a Docker push credential — publish images to your org.
            </p>

            <span className="cu-field__hint">1. Log in to the registry</span>
            <pre className="cu-code-block">{loginCmd}</pre>
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={() => copy(loginCmd, 'Login command')}
            >
              Copy login command
            </button>

            <span className="cu-field__hint">2. Tag and push to this coordinate</span>
            <pre className="cu-code-block">{pushCoordinate}</pre>

            <span className="cu-field__hint">
              Or hand the credential to a build system as a Docker config file:
            </span>
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={downloadDockerconfig}
            >
              Download dockerconfigjson
            </button>
          </div>
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
