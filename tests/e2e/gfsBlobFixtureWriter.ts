import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BLOB_KEY_RE = /^[0-9a-f]+$/i

function safeTempPrefix(): string {
  return join(tmpdir(), 'clerum-gfs-blob-')
}

export function seedGfsBlobWithKubectlCp(input: {
  context: string
  writerPod: string
  blobKey: string
  content: Buffer
  timeoutMs?: number
}): void {
  if (!input.context) throw new Error('GFS blob seed requires a Kubernetes context')
  if (!input.writerPod) throw new Error('GFS blob seed requires a writer pod')
  if (!BLOB_KEY_RE.test(input.blobKey)) {
    throw new Error(`invalid GFS blob key: ${input.blobKey}`)
  }

  const timeout = input.timeoutMs ?? 20_000
  const tempDir = mkdtempSync(safeTempPrefix())
  const tempFile = join(tempDir, input.blobKey)

  try {
    writeFileSync(tempFile, input.content, { mode: 0o600 })
    execFileSync(
      'kubectl',
      [
        '--context',
        input.context,
        '-n',
        'gfs',
        'cp',
        tempFile,
        `${input.writerPod}:/data/gfs/${input.blobKey}`,
        '-c',
        'gfsc',
      ],
      { encoding: 'utf-8', timeout }
    )
    execFileSync(
      'kubectl',
      [
        '--context',
        input.context,
        '-n',
        'gfs',
        'exec',
        input.writerPod,
        '-c',
        'gfsc',
        '--',
        'chmod',
        '600',
        `/data/gfs/${input.blobKey}`,
      ],
      { encoding: 'utf-8', timeout }
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
