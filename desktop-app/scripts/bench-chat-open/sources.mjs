import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'

const COMMAND_TIMEOUT_MS = 60_000

export function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

export async function setSourcePermissions(root, readOnly) {
  // Never follow the node_modules symlink into the working checkout.
  await fs.chmod(root, readOnly ? 0o555 : 0o700)
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await setSourcePermissions(path, readOnly)
    else if (entry.isFile()) await fs.chmod(path, readOnly ? 0o444 : 0o600)
  }
}

function runtimeDependencies(ts, file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const imports = new Set()
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.add(node.moduleSpecifier.text)
      }
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
        throw new Error('A dynamic runtime dependency cannot be audited for Electron isolation')
      }
      imports.add(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return [...imports]
}

export async function auditRuntime(ts, compiledRoot, entryFiles) {
  const canonicalRoot = await fs.realpath(compiledRoot)
  const seen = new Set()
  const imports = new Set()
  async function visit(file) {
    file = await fs.realpath(file)
    const withinRoot = relative(canonicalRoot, file)
    if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
      throw new Error('Runtime dependency escapes the compiled source snapshot')
    }
    if (seen.has(file)) return
    seen.add(file)
    for (const specifier of runtimeDependencies(ts, file, await fs.readFile(file, 'utf8'))) {
      imports.add(specifier)
      if (isBuiltin(specifier)) continue
      if (!specifier.startsWith('.')) {
        throw new Error(`Non-Node runtime dependency requires explicit isolation: ${specifier}`)
      }
      const next = createRequire(file).resolve(specifier)
      await visit(next)
    }
  }
  for (const entry of entryFiles) await visit(entry)
  return { files: [...seen].sort(), imports: [...imports].sort() }
}

export function handlerLines(ipcSource) {
  const lines = ipcSource.split('\n')
  const start = lines.findIndex(line => line.includes("ipcMain.handle('chat:getIndex'"))
  if (start < 0) throw new Error('chat:getIndex handler is missing from this source version')
  const end = lines.findIndex((line, index) => index > start && line === '  })')
  if (end < 0) throw new Error('chat:getIndex handler boundary is missing')
  return { start: start + 1, end: end + 1, source: lines.slice(start, end + 1).join('\n') }
}

/**
 * HEAD snapshots the live worktree, so its numbers describe the recorded commit
 * only when the tree is clean. Returns whether the tree is dirty.
 */
export function checkWorktreeClean(porcelainStatus, allowDirty) {
  const dirty = porcelainStatus !== ''
  if (dirty && !allowDirty) {
    throw Object.assign(
      new Error('HEAD has uncommitted changes; commit them or pass --allow-dirty'),
      { code: 'DIRTY_WORKTREE' }
    )
  }
  return dirty
}

export async function compileVersion({ adapter, repoRoot, desktopRoot, runDir, allowDirty }) {
  const versionDir = await fs.mkdtemp(join(runDir, 'source-'))
  const snapshotRoot = join(versionDir, 'snapshot')
  const snapshotDesktop = join(snapshotRoot, 'desktop-app')
  const sourceRoot = join(snapshotDesktop, 'src')
  const compiledRoot = join(versionDir, 'compiled')
  await fs.mkdir(snapshotDesktop, { recursive: true })
  const commit = git(repoRoot, ['rev-parse', `${adapter.ref}^{commit}`])
  let dirty = false
  let handler = null
  let ipcSha256 = null
  if (adapter.ref === 'HEAD') {
    dirty = checkWorktreeClean(git(repoRoot, ['status', '--porcelain']), allowDirty)
    // Include the live, possibly uncommitted handler; freeze it before compiling.
    await fs.access(join(desktopRoot, 'src/chatGetIndexHandler.ts'))
    await fs.cp(join(desktopRoot, 'src'), sourceRoot, { recursive: true })
    for (const file of await fs.readdir(desktopRoot)) {
      if (file === 'package.json' || /^tsconfig.*\.json$/.test(file)) {
        await fs.copyFile(join(desktopRoot, file), join(snapshotDesktop, file))
      }
    }
  } else {
    // Equivalent to git archive <ref> ... | tar -x -C <tmpdir>, with each exit checked.
    const archive = execFileSync(
      'git',
      [
        'archive',
        commit,
        'desktop-app/src',
        'desktop-app/package.json',
        'desktop-app/tsconfig*.json',
      ],
      { cwd: repoRoot, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
    )
    execFileSync('tar', ['-x', '-C', snapshotRoot], {
      input: archive,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
  }
  await fs.symlink(join(desktopRoot, 'node_modules'), join(snapshotDesktop, 'node_modules'), 'dir')
  // A historical handler is inline in ipc.ts, so its pinned lines are checked
  // against git show. HEAD's handler is the compiled runChatGetIndex export,
  // which the HEAD adapter asserts it receives.
  if (adapter.ref !== 'HEAD') {
    const ipcSource = await fs.readFile(join(sourceRoot, 'ipc.ts'), 'utf8')
    if (ipcSource !== `${git(repoRoot, ['show', `${commit}:desktop-app/src/ipc.ts`])}\n`) {
      throw new Error('Archived ipc.ts does not match git show')
    }
    handler = handlerLines(ipcSource)
    adapter.verifyHandler(handler)
    ipcSha256 = createHash('sha256').update(ipcSource).digest('hex')
  }
  await setSourcePermissions(snapshotRoot, true)
  const entries = ['chatStore.ts', ...(adapter.ref === 'HEAD' ? ['chatGetIndexHandler.ts'] : [])]
  const config = join(versionDir, 'tsconfig.bench.json')
  await fs.writeFile(
    config,
    JSON.stringify({
      extends: join(snapshotDesktop, 'tsconfig.json'),
      compilerOptions: {
        rootDir: sourceRoot,
        outDir: compiledRoot,
        types: ['node'],
        typeRoots: [join(desktopRoot, 'node_modules/@types')],
        noEmit: false,
        noEmitOnError: true,
        incremental: false,
        declaration: false,
        sourceMap: false,
      },
      files: entries.map(file => join(sourceRoot, file)),
      include: [],
      exclude: [],
    }),
    { mode: 0o600 }
  )
  execFileSync(process.execPath, [join(desktopRoot, 'node_modules/.bin/tsc'), '-p', config], {
    cwd: desktopRoot,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  })
  const requireHead = createRequire(join(desktopRoot, 'package.json'))
  const ts = requireHead('typescript')
  const runtimeRoot = await fs.realpath(compiledRoot)
  const runtime = await auditRuntime(
    ts,
    runtimeRoot,
    entries.map(file => join(runtimeRoot, file.replace(/\.ts$/, '.js')))
  )
  const sources = await Promise.all(
    runtime.files.map(async file => {
      const name = relative(runtimeRoot, file).replace(/\.js$/, '.ts')
      return {
        file: `desktop-app/src/${name}`,
        sha256: createHash('sha256')
          .update(await fs.readFile(join(sourceRoot, name)))
          .digest('hex'),
      }
    })
  )
  const load = createRequire(join(compiledRoot, 'chatStore.js'))
  const { ChatStore } = load('./chatStore.js')
  const handlerModule = adapter.ref === 'HEAD' ? load('./chatGetIndexHandler.js') : undefined
  return {
    ChatStore,
    context: store => adapter.context(store, handlerModule),
    metadata: {
      version: adapter.ref,
      commit,
      dirty,
      sourceMode: adapter.ref === 'HEAD' ? 'live-worktree-snapshot' : 'read-only-git-archive',
      compilerVersion: ts.version,
      sources,
      ipcSha256,
      handlerLines: handler && { start: handler.start, end: handler.end },
      runtimeImports: runtime.imports,
      electronIsolation:
        'Only the compiled ChatStore/handler runtime dependency graph is loaded; every dependency is audited as a Node builtin or a relative module. Electron bindings and ipc.ts are never loaded.',
      handlesPendingCleanups: adapter.handlesPendingCleanups,
    },
  }
}
