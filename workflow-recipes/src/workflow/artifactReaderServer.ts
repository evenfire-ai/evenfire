import { importSPKI, jwtVerify } from 'jose'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

type ArtifactReaderClaims = {
  sub?: string
  recipeName?: string
  recipeNamespace?: string
  artifactName?: string
  scopes?: string[]
}

const DEFAULT_OUTPUT_DIR = '/output'
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function artifactGoneBody(filename: string): Record<string, unknown> {
  return {
    error: 'artifact_gone',
    code: 'artifact_gone',
    message: `Artifact "${filename}" is no longer available on the workflow output PVC`,
  }
}

function contentTypeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const types: Record<string, string> = {
    csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    html: 'text/html',
    json: 'application/json',
    md: 'text/markdown',
    pdf: 'application/pdf',
    txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return types[ext] ?? 'application/octet-stream'
}

function safeDispositionName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getOutputDir(): string {
  return process.env.CLERUM_OUTPUT_DIR || DEFAULT_OUTPUT_DIR
}

function requiredEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

function filenameFromUrl(req: http.IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://artifact-reader.local')
  const match = url.pathname.match(/^\/api\/v1\/workflow\/artifacts\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

function isArtifactCollectionUrl(req: http.IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', 'http://artifact-reader.local')
  return url.pathname === '/api/v1/workflow/artifacts'
}

let cachedKey: Awaited<ReturnType<typeof importSPKI>> | null = null
let cachedPem = ''

async function verifyBearer(req: http.IncomingMessage): Promise<ArtifactReaderClaims> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) throw new Error('missing bearer')

  const publicKeyPem = process.env.WRC_PUBLIC_KEY_PEM
  if (!publicKeyPem) throw new Error('WRC public key not configured')
  if (!cachedKey || cachedPem !== publicKeyPem) {
    cachedKey = await importSPKI(publicKeyPem, 'RS256')
    cachedPem = publicKeyPem
  }

  const { payload } = await jwtVerify(header.slice(7), cachedKey, {
    algorithms: ['RS256'],
    issuer: 'clerum-wrc',
    audience: 'mcp-host',
  })

  return {
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    recipeName: typeof payload.recipeName === 'string' ? payload.recipeName : undefined,
    recipeNamespace:
      typeof payload.recipeNamespace === 'string' ? payload.recipeNamespace : undefined,
    artifactName: typeof payload.artifactName === 'string' ? payload.artifactName : undefined,
    scopes: Array.isArray(payload.scopes)
      ? payload.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
  }
}

async function verifyWorkflowClaims(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requiredScope: string
): Promise<ArtifactReaderClaims | null> {
  let claims: ArtifactReaderClaims
  try {
    claims = await verifyBearer(req)
  } catch {
    json(res, 401, { error: 'Invalid workflow token' })
    return null
  }

  const expectedRecipe = requiredEnv('CLERUM_WORKFLOW_RECIPE')
  const expectedNamespace = requiredEnv('CLERUM_WORKFLOW_NAMESPACE')
  if (!expectedRecipe || !expectedNamespace) {
    json(res, 500, { error: 'Workflow artifact reader is not configured' })
    return null
  }
  if (!claims.scopes?.includes(requiredScope)) {
    json(res, 403, { error: `Missing scope: ${requiredScope}` })
    return null
  }
  if (claims.recipeName !== expectedRecipe) {
    json(res, 403, { error: 'recipeName mismatch' })
    return null
  }
  if (claims.recipeNamespace !== expectedNamespace) {
    json(res, 403, { error: 'recipeNamespace mismatch' })
    return null
  }

  return claims
}

function resolveArtifactPath(filename: string): { outputDir: string; filePath: string } | null {
  const outputDir = path.resolve(getOutputDir())
  const filePath = path.resolve(outputDir, filename)
  if (!filePath.startsWith(outputDir + path.sep)) return null
  return { outputDir, filePath }
}

function removeOutputEntry(outputDir: string, entry: string): void {
  const entryPath = path.resolve(outputDir, entry)
  if (!entryPath.startsWith(outputDir + path.sep)) return
  const stat = fs.lstatSync(entryPath)
  fs.rmSync(entryPath, { recursive: stat.isDirectory(), force: true })
}

async function handleReadArtifact(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed' })
    return
  }

  const claims = await verifyWorkflowClaims(req, res, 'artifact_read')
  if (!claims) return
  if (claims.sub !== 'wrc') {
    json(res, 403, { error: 'Only WRC may read artifacts' })
    return
  }

  const filename = filenameFromUrl(req)
  if (!filename || !SAFE_FILENAME_RE.test(filename) || filename.includes('..')) {
    json(res, 400, { error: 'Invalid filename' })
    return
  }
  if (!claims.artifactName) {
    json(res, 403, { error: 'Missing artifactName binding' })
    return
  }
  if (claims.artifactName !== filename) {
    json(res, 403, { error: 'artifactName mismatch' })
    return
  }

  const resolved = resolveArtifactPath(filename)
  if (!resolved) {
    json(res, 403, { error: 'Path traversal blocked' })
    return
  }

  let stat: fs.Stats
  try {
    stat = fs.lstatSync(resolved.filePath)
  } catch {
    json(res, 404, artifactGoneBody(filename))
    return
  }
  if (!stat.isFile()) {
    json(res, 404, artifactGoneBody(filename))
    return
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filename),
    'Content-Disposition': `attachment; filename="${safeDispositionName(filename)}"`,
    'Content-Length': String(stat.size),
  })

  const stream = fs.createReadStream(resolved.filePath)
  stream.on('error', () => {
    if (!res.headersSent) {
      json(res, 500, { error: 'Failed to read artifact' })
    } else {
      res.destroy()
    }
  })
  stream.pipe(res)
}

async function handleDeleteArtifactFile(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method !== 'DELETE') {
    json(res, 405, { error: 'Method not allowed' })
    return
  }

  const claims = await verifyWorkflowClaims(req, res, 'artifact_delete')
  if (!claims) return
  if (claims.sub !== 'wrc') {
    json(res, 403, { error: 'Only WRC may delete artifacts' })
    return
  }

  const filename = filenameFromUrl(req)
  if (!filename || !SAFE_FILENAME_RE.test(filename) || filename.includes('..')) {
    json(res, 400, { error: 'Invalid filename' })
    return
  }
  if (!claims.artifactName) {
    json(res, 403, { error: 'Missing artifactName binding' })
    return
  }
  if (claims.artifactName !== filename) {
    json(res, 403, { error: 'artifactName mismatch' })
    return
  }

  const resolved = resolveArtifactPath(filename)
  if (!resolved) {
    json(res, 403, { error: 'Path traversal blocked' })
    return
  }

  try {
    const stat = fs.lstatSync(resolved.filePath)
    if (!stat.isFile()) {
      json(res, 404, { error: `Artifact "${filename}" not found` })
      return
    }
    fs.unlinkSync(resolved.filePath)
    res.writeHead(204)
    res.end()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      json(res, 404, { error: `Artifact "${filename}" not found` })
      return
    }
    json(res, 500, { error: 'Failed to delete artifact' })
  }
}

async function handleDeleteAllArtifacts(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method !== 'DELETE') {
    json(res, 405, { error: 'Method not allowed' })
    return
  }

  const claims = await verifyWorkflowClaims(req, res, 'artifact_delete')
  if (!claims) return
  if (claims.sub !== 'wrc') {
    json(res, 403, { error: 'Only WRC may delete artifacts' })
    return
  }

  const outputDir = path.resolve(getOutputDir())
  try {
    fs.mkdirSync(outputDir, { recursive: true })
    for (const entry of fs.readdirSync(outputDir)) {
      removeOutputEntry(outputDir, entry)
    }
    res.writeHead(204)
    res.end()
  } catch {
    json(res, 500, { error: 'Failed to delete artifacts' })
  }
}

function createServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { status: 'ok' })
      return
    }

    if (isArtifactCollectionUrl(req)) {
      void handleDeleteAllArtifacts(req, res).catch(() =>
        json(res, 500, { error: 'Internal error' })
      )
      return
    }

    if ((req.url ?? '').startsWith('/api/v1/workflow/artifacts/')) {
      const handler = req.method === 'DELETE' ? handleDeleteArtifactFile : handleReadArtifact
      void handler(req, res).catch(() => json(res, 500, { error: 'Internal error' }))
      return
    }

    json(res, 404, { error: 'Not Found' })
  })
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080)
  createServer().listen(port, () => {
    console.log(`workflow-artifact-reader listening on ${port}`)
  })
}

export { createServer }
