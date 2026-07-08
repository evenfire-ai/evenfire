import { useEffect, useMemo, useState } from 'react'
import { Button } from '@components/Common'

interface ArtifactInfo {
  name: string
  format: string
  sizeBytes: number
  createdAt: string
}

interface ArtifactsBadgeProps {
  hostRef: string
  artifactNames?: string[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatBadge(format: string): string {
  return format.toUpperCase()
}

function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  const copy = new Uint8Array(value.byteLength)
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  return copy.buffer
}

export function ArtifactsBadge({ hostRef, artifactNames }: ArtifactsBadgeProps) {
  const artifactNameKey = useMemo(() => artifactNames?.join('\n') ?? null, [artifactNames])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const scopedNames =
        artifactNameKey == null ? null : artifactNameKey.split('\n').filter(Boolean)
      if (scopedNames && scopedNames.length === 0) {
        setArtifacts([])
        setLoadError(null)
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const result = await window.clerum.rpc.listArtifacts(hostRef, [hostRef])
        const availableArtifacts = result.artifacts || []
        const wanted = scopedNames ? new Set(scopedNames.map(name => name.toLowerCase())) : null
        const scopedArtifacts = wanted
          ? availableArtifacts.filter(artifact => wanted.has(artifact.name.toLowerCase()))
          : availableArtifacts
        if (!cancelled) setArtifacts(scopedArtifacts)
        if (!cancelled) setLoadError(null)
      } catch (error) {
        if (!cancelled) {
          const fallbackArtifacts = (scopedNames || []).map(name => ({
            name,
            format: name.split('.').pop() || 'file',
            sizeBytes: 0,
            createdAt: '',
          }))
          setArtifacts(fallbackArtifacts)
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [artifactNameKey, hostRef])

  if (loading) return null
  if (artifacts.length === 0) return null

  async function handleDownload(filename: string) {
    setDownloading(filename)
    try {
      const buffer = await window.clerum.rpc.downloadArtifact(hostRef, filename, [hostRef])
      const blob = new Blob([toArrayBuffer(buffer)])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (err) {
      console.error('Download failed:', err)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="artifacts-badge-container" title={loadError || undefined}>
      {loadError && (
        <p className="artifacts-badge-error">
          Artifact catalog unavailable. Showing filenames from message output.
        </p>
      )}
      <Button
        className="artifacts-badge-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        color="primary"
        size="xs"
        variant="soft"
      >
        <span className="artifacts-badge-icon">&#128196;</span>
        {artifacts.length} artifact{artifacts.length > 1 ? 's' : ''} generated
      </Button>
      {expanded && (
        <div className="artifacts-badge-list">
          {artifacts.map(a => (
            <div key={a.name} className="artifacts-badge-item">
              <span className={`artifacts-format-badge fmt-${a.format}`}>
                {formatBadge(a.format)}
              </span>
              <span className="artifacts-filename">{a.name}</span>
              <span className="artifacts-size">{formatSize(a.sizeBytes)}</span>
              <Button
                className="artifacts-download-btn"
                color="primary"
                disabled={downloading === a.name}
                onClick={() => void handleDownload(a.name)}
                size="xs"
                variant="soft"
              >
                {downloading === a.name ? '...' : 'Download'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
