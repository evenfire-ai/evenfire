/**
 * File routes:
 *   GET    /v1/files?path=<rel>            — list directory entries
 *   GET    /v1/files/stat?path=<rel>       — file metadata
 *   GET    /v1/files/download?path=<rel>   — stream file contents
 *   POST   /v1/files/upload (multipart)    — create new file (409 if exists)
 *   PUT    /v1/files/replace (multipart)   — whole-file replace (404 if missing)
 *   POST   /v1/files/mkdir {path}          — mkdir -p
 *   POST   /v1/files/move  {from, to}      — rename within mount
 *   DELETE /v1/files?path=<rel>&recursive  — delete file or directory
 *
 * All paths are validated lexically and physically before any read or write.
 * Listings are capped at maxListEntries.
 * Uploads are written to a temp sibling first then renamed atomically so
 * partial writes never appear at the destination path.
 */
import { type NextFunction, type Request, type Response, Router } from 'express'
import multer from 'multer'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  requireWfcFileScope,
  WFC_FILE_READ_SCOPE,
  WFC_FILE_WRITE_SCOPE,
  type BrowsingJwtPayload,
  type JwtVerifier,
  type WfcFileScope,
} from '../auth/jwtVerifier'
import { envelopeFromError, err, ok } from '../errors'
import {
  pathFromQuery,
  resolveSafePhysicalPath,
  type ResolvedPhysicalPath,
} from '../fs/pathSafety'

export interface FilesRouterOptions {
  mountPath: string
  maxListEntries: number
  maxPathDepth: number
  maxUploadBytes: number
  verifier: JwtVerifier
}

interface DirEntry {
  name: string
  kind: 'file' | 'directory' | 'other'
  size: number
  mtime: string
}

function classify(stat: import('node:fs').Stats): DirEntry['kind'] {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  return 'other'
}

function attachmentDisposition(filename: string): string {
  const safeName = filename.replace(/[\x00-\x1f\x7f]/g, '_')
  return `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`
}

/**
 * Express middleware: verify the bearer token and attach the decoded payload
 * to req.locals.jwt. Failures are converted to the standard error envelope.
 */
function authMiddleware(verifier: JwtVerifier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const payload = await verifier.verifyBearer(req.header('authorization'))
      ;(res.locals as { jwt?: BrowsingJwtPayload }).jwt = payload
      next()
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  }
}

function scopeMiddleware(scope: WfcFileScope) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const payload = (res.locals as { jwt?: BrowsingJwtPayload }).jwt
      if (!payload) {
        throw err('unauthorized', 'missing verified bearer credential')
      }
      requireWfcFileScope(payload, scope)
      next()
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  }
}

export function createFilesRouter(opts: FilesRouterOptions): Router {
  const router = Router()
  router.use(authMiddleware(opts.verifier))
  const requireRead = scopeMiddleware(WFC_FILE_READ_SCOPE)
  const requireWrite = scopeMiddleware(WFC_FILE_WRITE_SCOPE)

  function resolvePhysical(rel: string, mode: 'existing-target' | 'existing-parent') {
    return resolveSafePhysicalPath(rel, {
      mountRoot: opts.mountPath,
      maxDepth: opts.maxPathDepth,
      mode,
    })
  }

  function relFromAbs(abs: string): string {
    const rel = path.posix.relative(opts.mountPath, abs)
    return rel === '' ? '' : rel
  }

  // Resolve a target that may legitimately not exist yet. Returns the validated
  // resolution, or null when the target is absent (ENOENT). Any other fs error
  // propagates. Centralizes the "does this path exist, safely?" check shared by
  // the upload/mkdir/move handlers (each previously inlined the same
  // resolve-then-catch-ENOENT dance).
  async function resolveExistingOrNull(rel: string): Promise<ResolvedPhysicalPath | null> {
    try {
      return await resolvePhysical(rel, 'existing-target')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  // Defense-in-depth re-validation AFTER a filesystem mutation (mkdir/rename).
  // Guards against a TOCTOU symlink swap on an ancestor between the pre-check and
  // the syscall: throws path_invalid if the now-existing chain contains a
  // symlinked ancestor. Every write path MUST re-validate the parent it just
  // created and its final target through this helper.
  async function revalidateAfterMutation(rel: string): Promise<void> {
    await resolvePhysical(rel, 'existing-target')
  }

  router.get('/files', requireRead, async (req, res) => {
    try {
      const rel = pathFromQuery(req.query.path)
      const { absPath: abs } = await resolvePhysical(rel, 'existing-target')

      // lstat the directory itself first to reject symlinks at the listing
      // root. (Symlinks inside the dir are filtered per-entry below.)
      const rootLstat = await fs.lstat(abs)
      if (rootLstat.isSymbolicLink()) {
        throw err('path_invalid', 'symlinks are not allowed')
      }
      if (!rootLstat.isDirectory()) {
        throw err('not_a_directory', 'requested path is not a directory')
      }

      const dirents = await fs.readdir(abs, { withFileTypes: true })
      const truncated = dirents.length > opts.maxListEntries
      const slice = truncated ? dirents.slice(0, opts.maxListEntries) : dirents

      const entries: DirEntry[] = []
      for (const dirent of slice) {
        const childAbs = path.posix.join(abs, dirent.name)
        const lst = await fs.lstat(childAbs)
        if (lst.isSymbolicLink()) {
          // Skip silently — symlinks aren't safe to expose; v1 policy is to
          // pretend they don't exist rather than fail the whole listing.
          continue
        }
        entries.push({
          name: dirent.name,
          kind: classify(lst),
          size: lst.size,
          mtime: lst.mtime.toISOString(),
        })
      }
      res.json(ok({ path: rel, entries, truncated }))
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  })

  router.get('/files/stat', requireRead, async (req, res) => {
    try {
      const rel = pathFromQuery(req.query.path)
      const { absPath: abs } = await resolvePhysical(rel, 'existing-target')
      const lst = await fs.lstat(abs)
      if (lst.isSymbolicLink()) {
        throw err('path_invalid', 'symlinks are not allowed')
      }
      res.json(
        ok({
          path: rel,
          kind: classify(lst),
          size: lst.size,
          mtime: lst.mtime.toISOString(),
        })
      )
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  })

  router.get('/files/download', requireRead, async (req, res) => {
    try {
      const rel = pathFromQuery(req.query.path)
      const { absPath: abs } = await resolvePhysical(rel, 'existing-target')
      const lst = await fs.lstat(abs)
      if (lst.isSymbolicLink()) {
        throw err('path_invalid', 'symlinks are not allowed')
      }
      if (lst.isDirectory()) {
        throw err('is_a_directory', 'cannot download a directory')
      }
      if (!lst.isFile()) {
        throw err('not_found', 'not a regular file')
      }

      const filename = path.posix.basename(abs)
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Length', String(lst.size))
      res.setHeader('Content-Disposition', attachmentDisposition(filename))

      const stream = createReadStream(abs)
      stream.on('error', e => {
        const { status, body } = envelopeFromError(e)
        if (!res.headersSent) {
          res.status(status).json(body)
        } else {
          res.destroy()
        }
      })
      stream.pipe(res)
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  })

  // ── write endpoints (P3) ──────────────────────────────────────────────

  const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: opts.maxUploadBytes, files: 1 },
  })

  /**
   * Atomic write: open a sibling temp file, write contents, then rename it
   * onto the destination. Avoids partial-write races where a reader might
   * see a half-written file. Throws via fs error codes — caller maps them
   * via envelopeFromError.
   */
  // `absDest` MUST be the already-resolved physical path of `relDest`: the caller
  // resolves + validates the path once with the matching mode (existing-parent
  // for create, existing-target for replace) and passes both, so writeAtomic does
  // not re-resolve. The post-mutation re-validations below (after mkdir and after
  // rename) remain the TOCTOU defense.
  async function writeAtomic(
    relDest: string,
    absDest: string,
    contents: Buffer,
    mode: 'create' | 'replace'
  ): Promise<string> {
    if (absDest === opts.mountPath) {
      throw err('path_invalid', 'cannot write to mount root itself')
    }
    const dir = path.posix.dirname(absDest)
    const base = path.posix.basename(absDest)
    // Ensure parent exists before staging the temp file.
    await fs.mkdir(dir, { recursive: true })
    await revalidateAfterMutation(relFromAbs(dir))
    const tmp = path.posix.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`)
    let renamed = false
    try {
      await fs.writeFile(tmp, contents, { flag: 'wx' })
      if (mode === 'create') {
        // wx on rename isn't portable; do a pre-check then rename. There is
        // a tiny race window, but the linkSync→unlink dance isn't worth it
        // for a single-writer per-SFS service.
        const exists = (await resolveExistingOrNull(relDest)) !== null
        if (exists) {
          await fs.unlink(tmp).catch(() => {})
          throw err('already_exists', 'file already exists')
        }
      }
      await fs.rename(tmp, absDest)
      renamed = true
      await revalidateAfterMutation(relDest)
      return absDest
    } catch (e) {
      // Only the temp path is safe to clean up. After rename succeeds, a failed
      // post-rename validation means a concurrent actor may have changed an
      // ancestor; do not chase the destination path again for cleanup.
      if (!renamed) {
        await fs.unlink(tmp).catch(() => {})
      }
      throw e
    }
  }

  function pathFromBody(body: unknown, key: string): string {
    if (!body || typeof body !== 'object') {
      throw err('path_invalid', `request body missing ${key}`)
    }
    const v = (body as Record<string, unknown>)[key]
    if (typeof v !== 'string') {
      throw err('path_invalid', `request body ${key} must be a string`)
    }
    return v
  }

  /**
   * Convert multer's "file too large" error into the standard envelope so the
   * client gets a 413 with a stable `code`.
   */
  function multerErrorMiddleware(
    e: unknown,
    _req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (e instanceof multer.MulterError) {
      if (e.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          ok: false,
          error: { code: 'payload_too_large', message: 'file exceeds upload limit' },
        })
        return
      }
      res.status(400).json({
        ok: false,
        error: { code: 'path_invalid', message: e.message },
      })
      return
    }
    next(e)
  }

  router.post(
    '/files/upload',
    requireWrite,
    uploader.single('file'),
    multerErrorMiddleware,
    async (req: Request, res: Response) => {
      try {
        // Path can come from the multipart form field or the query string.
        const rawPath =
          typeof req.body?.path === 'string'
            ? (req.body.path as string)
            : pathFromQuery(req.query.path)
        const file = req.file
        if (!file) {
          throw err('path_invalid', 'multipart "file" field is required')
        }
        const { absPath: abs } = await resolvePhysical(rawPath, 'existing-parent')
        if (abs === opts.mountPath) {
          throw err('path_invalid', 'cannot upload to mount root itself')
        }
        await writeAtomic(rawPath, abs, file.buffer, 'create')
        const lst = await fs.lstat(abs)
        res.status(201).json(
          ok({
            path: rawPath,
            kind: 'file',
            size: lst.size,
            mtime: lst.mtime.toISOString(),
          })
        )
      } catch (e) {
        const { status, body } = envelopeFromError(e)
        res.status(status).json(body)
      }
    }
  )

  router.put(
    '/files/replace',
    requireWrite,
    uploader.single('file'),
    multerErrorMiddleware,
    async (req: Request, res: Response) => {
      try {
        const rawPath =
          typeof req.body?.path === 'string'
            ? (req.body.path as string)
            : pathFromQuery(req.query.path)
        const file = req.file
        if (!file) {
          throw err('path_invalid', 'multipart "file" field is required')
        }
        const { absPath: abs } = await resolvePhysical(rawPath, 'existing-target')
        if (abs === opts.mountPath) {
          throw err('path_invalid', 'cannot replace the mount root')
        }
        // Replace requires the destination to exist as a regular (non-symlink) file.
        const lst = await fs.lstat(abs)
        if (lst.isSymbolicLink()) {
          throw err('path_invalid', 'symlinks are not allowed')
        }
        if (lst.isDirectory()) {
          throw err('is_a_directory', 'cannot replace a directory')
        }
        if (!lst.isFile()) {
          throw err('not_found', 'not a regular file')
        }
        await writeAtomic(rawPath, abs, file.buffer, 'replace')
        const after = await fs.lstat(abs)
        res.json(
          ok({
            path: rawPath,
            kind: 'file',
            size: after.size,
            mtime: after.mtime.toISOString(),
          })
        )
      } catch (e) {
        const { status, body } = envelopeFromError(e)
        res.status(status).json(body)
      }
    }
  )

  router.post('/files/mkdir', requireWrite, async (req, res) => {
    try {
      const rawPath = pathFromBody(req.body, 'path')
      const { absPath: abs } = await resolvePhysical(rawPath, 'existing-parent')
      if (abs === opts.mountPath) {
        // mkdir on the mount root is a no-op success — it always exists.
        res.status(200).json(ok({ path: rawPath, kind: 'directory', created: false }))
        return
      }
      // Reject if the path exists as a non-directory (file or symlink).
      const existing = (await resolveExistingOrNull(rawPath)) ? await fs.lstat(abs) : null
      if (existing) {
        if (existing.isSymbolicLink()) {
          throw err('path_invalid', 'symlinks are not allowed')
        }
        if (!existing.isDirectory()) {
          throw err('already_exists', 'path exists and is not a directory')
        }
        res.status(200).json(ok({ path: rawPath, kind: 'directory', created: false }))
        return
      }
      await fs.mkdir(abs, { recursive: true })
      await revalidateAfterMutation(relFromAbs(path.posix.dirname(abs)))
      await revalidateAfterMutation(rawPath)
      res.status(201).json(ok({ path: rawPath, kind: 'directory', created: true }))
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  })

  router.post('/files/move', requireWrite, async (req, res) => {
    try {
      const fromRaw = pathFromBody(req.body, 'from')
      const toRaw = pathFromBody(req.body, 'to')
      const { absPath: toAbs } = await resolvePhysical(toRaw, 'existing-parent')
      const { absPath: fromAbs } = await resolvePhysical(fromRaw, 'existing-target')
      if (fromAbs === opts.mountPath || toAbs === opts.mountPath) {
        throw err('path_invalid', 'cannot move the mount root')
      }
      if (fromAbs === toAbs) {
        throw err('path_invalid', '"from" and "to" are the same path')
      }
      const srcLstat = await fs.lstat(fromAbs)
      if (srcLstat.isSymbolicLink()) {
        throw err('path_invalid', 'symlinks are not allowed')
      }
      // Refuse to clobber an existing destination — caller must delete first.
      const dstExists = (await resolveExistingOrNull(toRaw)) !== null
      if (dstExists) {
        throw err('already_exists', 'destination already exists')
      }
      await fs.mkdir(path.posix.dirname(toAbs), { recursive: true })
      await revalidateAfterMutation(relFromAbs(path.posix.dirname(toAbs)))
      await fs.rename(fromAbs, toAbs)
      await revalidateAfterMutation(toRaw)
      const after = await fs.lstat(toAbs)
      res.json(
        ok({
          from: fromRaw,
          to: toRaw,
          kind: classify(after),
          size: after.size,
          mtime: after.mtime.toISOString(),
        })
      )
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  })

  router.delete('/files', requireWrite, async (req, res) => {
    try {
      const rel = pathFromQuery(req.query.path)
      const recursive = req.query.recursive === 'true'
      const { absPath: abs } = await resolvePhysical(rel, 'existing-target')
      if (abs === opts.mountPath) {
        throw err('path_invalid', 'cannot delete the mount root')
      }
      const lst = await fs.lstat(abs)
      if (lst.isSymbolicLink()) {
        // Symlinks are never surfaced; refuse to delete one too rather than
        // silently following it.
        throw err('path_invalid', 'symlinks are not allowed')
      }
      if (lst.isDirectory()) {
        if (recursive) {
          await fs.rm(abs, { recursive: true, force: false })
        } else {
          // Will fail with ENOTEMPTY if the dir has entries — mapped to 409.
          await fs.rmdir(abs)
        }
      } else {
        await fs.unlink(abs)
      }
      res.json(ok({ path: rel, deleted: true, recursive }))
    } catch (e) {
      const { status, body } = envelopeFromError(e)
      res.status(status).json(body)
    }
  })

  return router
}
