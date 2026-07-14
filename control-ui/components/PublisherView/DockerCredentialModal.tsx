'use client'

import { useEffect, useRef } from 'react'
import type { CreatedRegistryApiKey } from '../../lib/api'
import { useToast } from '../Toast'
import { Button } from '../ui'
import {
  buildDockerLoginCommand,
  buildPushCoordinate,
  resolveDockerCredential,
} from './dockerCredential'

export function DockerCredentialModal({
  created,
  orgScope,
  onClose,
}: {
  created: CreatedRegistryApiKey
  orgScope: string
  onClose: () => void
}) {
  const { showToast } = useToast()
  const closeRef = useRef<HTMLButtonElement>(null)
  const { registry, dockerconfigjson } = resolveDockerCredential(created)
  const loginCmd = buildDockerLoginCommand(registry, created.key)
  const pushCoordinate = buildPushCoordinate(registry, orgScope)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      showToast(`${label} copied.`, { tone: 'success' })
    } catch {
      showToast('Could not copy — select and copy manually.', { tone: 'error' })
    }
  }

  function download() {
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
      <div className="cu-modal" role="dialog" aria-modal="true" aria-labelledby="docker-cred-title">
        <h3 id="docker-cred-title" className="cu-modal-panel__title">
          Docker push credential created
        </h3>
        <div className="cu-banner cu-banner--warn" role="alert">
          <strong>This is the only time this credential is shown.</strong> Copy or download it now —
          it cannot be retrieved after you close this dialog.
        </div>

        <div className="cu-field">
          <label>Log in to the registry</label>
          <pre className="cu-code-block">{loginCmd}</pre>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void copy(loginCmd, 'Login command')}
          >
            Copy login command
          </Button>
        </div>

        <div className="cu-field">
          <label>Docker config</label>
          <p className="cu-field__hint">
            For CI, mount this as <code>~/.docker/config.json</code> (or a Kubernetes{' '}
            <code>dockerconfigjson</code> secret).
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={download}>
            Download dockerconfigjson
          </Button>
        </div>

        <div className="cu-field">
          <label>Push coordinate</label>
          <pre className="cu-code-block">{pushCoordinate}</pre>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void copy(pushCoordinate, 'Push coordinate')}
          >
            Copy coordinate
          </Button>
          {/* A "CI template" help link will be re-added once the docs page exists — see #729. */}
          <p className="cu-field__hint">
            Plain <code>docker push</code> works — the registry advertises{' '}
            <code>http.compat: [&quot;docker2s2&quot;]</code>, so Docker-format (schema 2) manifests
            are accepted. If your tooling only emits OCI images and the push is rejected, re-tag to
            Docker manifest format.
          </p>
        </div>

        <div className="cu-modal-actions">
          {/* Native button so the focus ref works — Button does not use forwardRef. */}
          <button ref={closeRef} type="button" className="cu-btn cu-btn--primary" onClick={onClose}>
            I&apos;ve saved it
          </button>
        </div>
      </div>
    </div>
  )
}
