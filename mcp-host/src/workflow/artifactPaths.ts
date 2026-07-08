import * as fs from 'fs'
import * as path from 'path'

// Keep this aligned with control-api/src/k8s.ts until the artifact policy is
// promoted to a shared runtime dependency consumed by both services.
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

export class ArtifactPathError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413 | 500,
    message: string
  ) {
    super(message)
    this.name = 'ArtifactPathError'
  }
}

export type ResolvedArtifactFile = {
  filePath: string
  stat: fs.Stats
}

export type OpenedArtifactFile = ResolvedArtifactFile & {
  fd: number
}

type ArtifactCandidate = {
  candidate: string
  realRoot: string
}

export function isSafeArtifactFilename(filename: string | undefined): filename is string {
  if (!filename) return false
  return !/[/\\\x00]/.test(filename) && !filename.includes('..')
}

function artifactFsError(err: unknown): ArtifactPathError {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ArtifactPathError(404, 'Artifact not found')
  }
  if (code === 'ELOOP') {
    return new ArtifactPathError(403, 'Symlink artifacts are not allowed')
  }
  return new ArtifactPathError(500, 'Failed to read artifact')
}

function resolveArtifactCandidate(outputDir: string, filename: string): ArtifactCandidate {
  if (!isSafeArtifactFilename(filename)) {
    throw new ArtifactPathError(400, 'Invalid filename')
  }

  const root = path.resolve(outputDir)
  const candidate = path.resolve(root, filename)
  if (candidate === root || !candidate.startsWith(root + path.sep)) {
    throw new ArtifactPathError(403, 'Path traversal blocked')
  }

  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    throw new ArtifactPathError(404, 'Artifact not found')
  }

  return { candidate, realRoot }
}

function validateOpenedArtifactFile(
  candidate: ArtifactCandidate,
  fd: number
): ResolvedArtifactFile {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile()) {
    throw new ArtifactPathError(404, 'Artifact not found')
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactPathError(413, 'Artifact too large to download')
  }

  const realFile = fs.realpathSync(candidate.candidate)
  if (realFile === candidate.realRoot || !realFile.startsWith(candidate.realRoot + path.sep)) {
    throw new ArtifactPathError(403, 'Path traversal blocked')
  }

  return { filePath: realFile, stat }
}

function closeFd(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    /* ignore close failure while returning the original artifact error */
  }
}

function openResolvedArtifactFile(outputDir: string, filename: string): OpenedArtifactFile {
  const candidate = resolveArtifactCandidate(outputDir, filename)
  let fd: number

  try {
    fd = fs.openSync(candidate.candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (err) {
    throw artifactFsError(err)
  }

  try {
    const artifact = validateOpenedArtifactFile(candidate, fd)
    return { ...artifact, fd }
  } catch (err) {
    closeFd(fd)
    if (err instanceof ArtifactPathError) throw err
    throw artifactFsError(err)
  }
}

export function resolveExistingArtifactFile(
  outputDir: string,
  filename: string
): ResolvedArtifactFile {
  const artifact = openResolvedArtifactFile(outputDir, filename)
  closeFd(artifact.fd)
  return { filePath: artifact.filePath, stat: artifact.stat }
}

export function openExistingArtifactFile(outputDir: string, filename: string): OpenedArtifactFile {
  return openResolvedArtifactFile(outputDir, filename)
}
