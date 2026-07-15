'use client'

import React, { useEffect, useId, useState } from 'react'
import { IconServer } from '@components/Sidebar/icons'
import { IconX } from '@components/icons'
import { Button } from '@components/ui'
import type { FileUploadModalProps } from './types'

export function FileUploadModal({
  busy = false,
  destination,
  file,
  fileSummary,
  guidance,
  onClose,
  onFileChange,
  onUpload,
  title = 'Upload file',
}: FileUploadModalProps): React.JSX.Element {
  const inputId = useId()
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])

  function selectFile(nextFile: File | null): void {
    if (busy) return
    setDragOver(false)
    onFileChange(nextFile)
  }

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="cu-modal-panel cu-modal-panel--shared-files"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="cu-modal-panel__head">
          <h3 className="cu-modal-panel__title">{title}</h3>
          <Button
            className="cu-btn--icon"
            variant="ghost"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <IconX width={18} height={18} />
          </Button>
        </header>

        <div className="cu-upload-file-flow">
          <input
            id={inputId}
            type="file"
            className="sr-only"
            aria-label="Choose file to upload"
            disabled={busy}
            onChange={event => {
              const nextFile = event.currentTarget.files?.[0] ?? null
              event.currentTarget.value = ''
              selectFile(nextFile)
            }}
          />
          <label
            htmlFor={inputId}
            className={`cu-upload-dropzone${dragOver ? ' cu-upload-dropzone--active' : ''}${
              busy ? ' cu-upload-dropzone--disabled' : ''
            }`}
            onDragEnter={event => {
              event.preventDefault()
              event.stopPropagation()
              if (event.dataTransfer.types.includes('Files')) setDragOver(true)
            }}
            onDragOver={event => {
              event.preventDefault()
              event.stopPropagation()
              if (event.dataTransfer.types.includes('Files')) event.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={event => {
              event.preventDefault()
              event.stopPropagation()
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              setDragOver(false)
            }}
            onDrop={event => {
              event.preventDefault()
              event.stopPropagation()
              const [nextFile] = Array.from(event.dataTransfer.files || [])
              if (nextFile) selectFile(nextFile)
            }}
          >
            <span className="cu-upload-dropzone__icon" aria-hidden="true">
              <IconServer />
            </span>
            <span className="cu-upload-dropzone__text">
              <strong>{file ? file.name : 'Drop a file here'}</strong>
              <span>
                {file ? fileSummary || 'Ready to upload' : 'Drag and drop, or click to browse'}
              </span>
            </span>
          </label>

          {guidance ? (
            <p className="cu-upload-file-flow__guidance" role="note">
              {guidance}
            </p>
          ) : null}

          {destination ? (
            <p className="cu-upload-file-flow__destination">
              Uploads to <code>{destination}</code>
            </p>
          ) : null}
        </div>

        <footer className="cu-modal-panel__foot">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !file} onClick={onUpload}>
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
        </footer>
      </section>
    </div>
  )
}

export type { FileUploadModalProps } from './types'
