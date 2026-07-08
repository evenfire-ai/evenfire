// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SecureHtmlPreview } from '@components/SecureHtmlPreview'

describe('SecureHtmlPreview', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders sandboxed preview with full-view and download controls', () => {
    const { container } = render(
      <SecureHtmlPreview
        html="<html><body><h1>Hello</h1></body></html>"
        previewId="preview-1"
        title="Artifact preview: output.html"
        maxBytes={512000}
      />
    )

    expect(container.querySelector('.message-html-preview-frame')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open full view' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download HTML' })).toBeTruthy()
    expect(container.querySelector('.message-html-preview-source')).toBeNull()
  })

  it('renders visible untrusted HTML warning', () => {
    const { container } = render(
      <SecureHtmlPreview
        html="<html><body>Unsafe</body></html>"
        previewId="preview-2"
        title="Artifact preview: output.html"
        maxBytes={512000}
      />
    )

    expect(container.querySelector('.message-html-preview-warning')?.textContent).toContain(
      'Untrusted HTML preview. Review carefully before interacting.'
    )
  })
})
