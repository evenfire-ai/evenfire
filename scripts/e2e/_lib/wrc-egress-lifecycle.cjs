'use strict'

// Development-only lifecycle for the disruptive WRC gate. The durable journal
// is deliberately outside the transient profile lease: a killed process must
// leave a recovery obligation that later certification cannot silently ignore.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

const RUN_LABEL = 'e2e.clerum.io/run'
const resourceRoutes = new Map([
  ['ConfigMap', ['v1', 'configmaps']],
  ['Service', ['v1', 'services']],
  ['Deployment', ['apps/v1', 'deployments']],
  ['NetworkPolicy', ['networking.k8s.io/v1', 'networkpolicies']],
  ['WorkflowRecipe', ['clerum.io/v1alpha1', 'workflowrecipes']],
])
const validName = value =>
  typeof value === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value)
function invariant(value, code) {
  if (!value) throw new Error(code)
}

function journalPath(repository, profile) {
  invariant(validName(profile), 'INVALID_PROFILE')
  invariant(fs.realpathSync(repository) === repository, 'NONCANONICAL_REPOSITORY')
  return path.join(
    repository,
    '.local-notes',
    'infra',
    'runs',
    'fault-injection',
    `wrc-${profile}.json`
  )
}

function safeParents(file, create = false, allowMissing = false) {
  let current = path.parse(file).root
  for (const part of path.dirname(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
    const info = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!info && allowMissing) return
    invariant(info, 'MISSING_JOURNAL_PARENT')
    invariant(info.isDirectory() && !info.isSymbolicLink(), 'UNSAFE_JOURNAL_PARENT')
  }
}

function readJournal(file) {
  safeParents(file)
  let descriptor
  try {
    // The local harness runs on POSIX. NOFOLLOW binds validation and reading
    // to one opened file; NONBLOCK prevents a substituted FIFO from hanging
    // before fstat can reject it as a non-regular file.
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error('UNSAFE_JOURNAL_FILE', { cause: error })
    throw error
  }
  try {
    const checkedStat = () => {
      const info = fs.fstatSync(descriptor)
      invariant(
        info.isFile() && info.nlink === 1 && (info.mode & 0o077) === 0,
        'UNSAFE_JOURNAL_FILE'
      )
      invariant(info.size > 0 && info.size <= 1024 * 1024, 'INVALID_JOURNAL_SIZE')
      return info
    }
    const before = checkedStat()
    // One extra byte detects growth without an unbounded read-to-EOF. Normal
    // journal writers replace atomically; in-place size changes are refused.
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = checkedStat()
    invariant(length === before.size && after.size === before.size, 'JOURNAL_CHANGED_DURING_READ')
    const state = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    invariant(
      state.version === 1 &&
        typeof state.runId === 'string' &&
        /^[a-f0-9-]{36}$/.test(state.runId) &&
        Array.isArray(state.resources),
      'INVALID_JOURNAL'
    )
    return state
  } finally {
    fs.closeSync(descriptor)
  }
}

function assertJournalBinding(state, expected) {
  // HEAD is historical during recovery; stable owner identity must still match.
  for (const key of ['repository', 'branch', 'profile', 'context']) {
    invariant(
      typeof expected[key] === 'string' &&
        expected[key].length > 0 &&
        state.binding?.[key] === expected[key],
      'JOURNAL_OWNER_MISMATCH'
    )
  }
}

class Journal {
  constructor(file, state, existing = false) {
    this.file = file
    this.state = state
    safeParents(file, true)
    if (!existing) {
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify(state))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } else readJournal(file)
  }
  save() {
    const current = readJournal(this.file)
    invariant(current.runId === this.state.runId, 'JOURNAL_REPLACED')
    const pending = `${this.file}.${randomUUID()}.new`
    const fd = fs.openSync(pending, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(pending, this.file)
  }
  remove() {
    invariant(readJournal(this.file).runId === this.state.runId, 'JOURNAL_REPLACED')
    fs.unlinkSync(this.file)
  }
}

function resourceIdentity(object) {
  const metadata = object?.metadata
  invariant(
    resourceRoutes.has(object?.kind) && validName(metadata?.name) && validName(metadata?.namespace),
    'INVALID_RESOURCE_IDENTITY'
  )
  return { kind: object.kind, name: metadata.name, namespace: metadata.namespace }
}

function resourcePath(identity) {
  const { kind, name, namespace } = resourceIdentity({ kind: identity.kind, metadata: identity })
  const [version, plural] = resourceRoutes.get(kind)
  return `${version === 'v1' ? '/api' : '/apis'}/${version}/namespaces/${namespace}/${plural}/${name}`
}

async function createOwned(kube, journal, object) {
  const identity = resourceIdentity(object)
  invariant(object.metadata.labels?.[RUN_LABEL] === journal.state.runId, 'MISSING_RUN_OWNERSHIP')
  const entry = { ...identity, attempted: true, uid: null }
  journal.state.resources.push(entry)
  journal.save() // Record uncertain acknowledgement BEFORE issuing the request.
  const created = await kube.create(object)
  invariant(
    created?.metadata?.uid && created.metadata.labels?.[RUN_LABEL] === journal.state.runId,
    'UNPROVEN_CREATED_RESOURCE'
  )
  invariant(
    JSON.stringify(resourceIdentity(created)) === JSON.stringify(identity),
    'CREATED_IDENTITY_MISMATCH'
  )
  entry.uid = created.metadata.uid
  journal.save()
  return created
}

async function deleteOwned(kube, journal, entry) {
  const live = await kube.get(entry)
  if (!live) return // Only the client's authoritative NotFound produces null.
  invariant(
    entry.uid &&
      live.metadata?.uid === entry.uid &&
      live.metadata.labels?.[RUN_LABEL] === journal.state.runId,
    'UNPROVEN_CLEANUP_OWNERSHIP'
  )
  invariant(live.metadata.resourceVersion, 'MISSING_DELETE_VERSION')
  try {
    await kube.delete(entry, { uid: entry.uid, resourceVersion: live.metadata.resourceVersion })
  } catch (error) {
    if (await kube.get(entry)) throw error
  }
  await waitFor('owned-resource-absence', 90_000, async (remaining, signal) => {
    const current = await kube.get(entry, remaining, signal)
    if (!current) return true
    invariant(current.metadata?.uid === entry.uid, 'RESOURCE_RECREATED_DURING_CLEANUP')
    return false
  })
}

async function waitFor(label, timeoutMs, predicate, options = {}) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const deadline = now() + timeoutMs
  const timeoutError = new Error(`TIMEOUT:${label}`)
  timeoutError.exitCode = 124
  while (now() < deadline) {
    if (options.signal?.aborted) throw options.signal.reason
    const remaining = deadline - now()
    // Predicates pass this remaining budget into all child I/O. Race also bounds
    // a misbehaving predicate; cancellation must terminate its actual process.
    const controller = new AbortController()
    let timer
    const cancel = () => controller.abort(options.signal.reason)
    options.signal?.addEventListener('abort', cancel, { once: true })
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      })
    })
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError)
        reject(timeoutError)
      }, remaining)
    })
    let ready
    try {
      ready = await Promise.race([predicate(remaining, controller.signal), expired, cancelled])
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
    if (options.signal?.aborted) throw options.signal.reason
    if (ready && now() < deadline) return
    if (now() >= deadline) break
    await sleep(Math.min(500, deadline - now()))
  }
  throw timeoutError
}

function createCommandRunner(repository, cancellation) {
  return (args, { input, timeoutMs = 30_000, signal, cleanup = false } = {}) =>
    new Promise((resolve, reject) => {
      if (!cleanup && cancellation.signal.aborted) return reject(cancellation.signal.reason)
      const effectiveSignal = cleanup
        ? signal
        : AbortSignal.any([cancellation.signal, ...(signal ? [signal] : [])])
      if (effectiveSignal?.aborted) return reject(effectiveSignal.reason)
      const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
      const child = spawn(
        process.execPath,
        [
          path.join(repository, 'scripts/minikube/run-with-deadline.mjs'),
          '--timeout-seconds',
          String(timeoutSeconds),
          '--kill-grace-seconds',
          '2',
          '--heartbeat-seconds',
          '20',
          '--label',
          'wrc-egress-operation',
          '--',
          ...args,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: process.env }
      )
      const started = Date.now()
      const stdout = []
      let bytes = 0
      // Never echo arbitrary API bodies, pod output, or access configuration.
      child.stderr.resume()
      const abort = () => child.kill('SIGTERM')
      effectiveSignal?.addEventListener('abort', abort, { once: true })
      // The reused process-group supervisor accepts seconds; this parent timer
      // enforces the remaining millisecond phase budget without granting another
      // rounded-up second in which a command could still perform work.
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        abort()
      }, timeoutMs)
      child.stdout.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) abort()
        else stdout.push(chunk)
      })
      child.once('error', error => {
        clearTimeout(timer)
        effectiveSignal?.removeEventListener('abort', abort)
        reject(error)
      })
      child.once('close', (code, signalName) => {
        clearTimeout(timer)
        effectiveSignal?.removeEventListener('abort', abort)
        if (
          timedOut ||
          code !== 0 ||
          signalName ||
          effectiveSignal?.aborted ||
          bytes > 4 * 1024 * 1024 ||
          Date.now() - started > timeoutMs
        ) {
          const error = new Error('WRC_GATE_OPERATION_FAILED')
          error.exitCode =
            timedOut || Date.now() - started > timeoutMs
              ? 124
              : effectiveSignal?.reason?.exitCode || code || 1
          reject(error)
        } else resolve(Buffer.concat(stdout).toString('utf8'))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input ?? '')
    })
}

function createKubeClient(repository, context, run) {
  let cleanup = false
  const pending = new Set()
  const readBudget = timeoutMs => {
    const budget = timeoutMs ?? 30_000
    if (!Number.isFinite(budget) || budget <= 0) {
      const error = new Error('TIMEOUT:wrc-read')
      error.exitCode = 124
      throw error
    }
    return Math.min(30_000, budget)
  }
  const command = async (args, input, timeoutMs = 30_000, signal) => {
    const operation = run(
      [
        'kubectl',
        `--context=${context}`,
        `--request-timeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
        ...args,
      ],
      { input, timeoutMs, signal, cleanup }
    )
    pending.add(operation)
    try {
      return await operation
    } finally {
      pending.delete(operation)
    }
  }
  const mutation = async (args, input) => {
    await run(['bash', path.join(repository, 'scripts/minikube/require-t2-mutation-lock.sh')], {
      timeoutMs: 15_000,
      cleanup,
    })
    return command(args, input)
  }
  return {
    async setCleanup(value) {
      cleanup = value
      // A polling deadline can abort a GET before its process-group supervisor
      // has finished reaping it. Drain those bounded operations before cleanup
      // mutates resources or releases the profile's ownership obligation.
      if (value) await Promise.allSettled([...pending])
    },
    async get(identity, timeoutMs, signal) {
      resourceIdentity({ kind: identity.kind, metadata: identity })
      const text = await command(
        [
          'get',
          identity.kind,
          identity.name,
          '-n',
          identity.namespace,
          '--ignore-not-found=true',
          '-o',
          'json',
        ],
        undefined,
        readBudget(timeoutMs),
        signal
      )
      return text.trim() === '' ? null : JSON.parse(text)
    },
    async list(kind, namespace, selector, timeoutMs, signal) {
      return JSON.parse(
        await command(
          ['get', kind, '-n', namespace, '-l', selector, '-o', 'json'],
          undefined,
          readBudget(timeoutMs),
          signal
        )
      ).items
    },
    async create(object) {
      resourceIdentity(object)
      return JSON.parse(await mutation(['create', '-f', '-', '-o', 'json'], JSON.stringify(object)))
    },
    async patch(identity, patch) {
      resourceIdentity({ kind: identity.kind, metadata: identity })
      return JSON.parse(
        await mutation([
          'patch',
          identity.kind,
          identity.name,
          '-n',
          identity.namespace,
          '--type=json',
          '-p',
          JSON.stringify(patch),
          '-o',
          'json',
        ])
      )
    },
    async delete(identity, preconditions) {
      // kubectl RawDelete accepts a DeleteOptions request body via stdin.
      return mutation(
        ['delete', `--raw=${resourcePath(identity)}`, '-f', '-'],
        JSON.stringify({
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions,
          propagationPolicy: 'Foreground',
        })
      )
    },
    async exec(namespace, pod, code, args = [], timeoutMs = 20_000, signal) {
      return command(
        ['exec', pod, '-n', namespace, '--', 'node', '-e', code, ...args],
        undefined,
        timeoutMs,
        signal
      )
    },
    async rollout(namespace, name, timeoutMs = 180_000) {
      return command(
        [
          'rollout',
          'status',
          `deployment/${name}`,
          '-n',
          namespace,
          `--timeout=${Math.ceil(timeoutMs / 1000)}s`,
        ],
        undefined,
        timeoutMs
      )
    },
  }
}

module.exports = {
  Journal,
  journalPath,
  readJournal,
  assertJournalBinding,
  createOwned,
  deleteOwned,
  resourceIdentity,
  resourcePath,
  waitFor,
  createCommandRunner,
  createKubeClient,
  invariant,
  RUN_LABEL,
}

if (require.main === module) {
  const [repository, profile] = process.argv.slice(2)
  try {
    const file = journalPath(repository, profile)
    safeParents(file, false, true)
    if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) {
      throw new Error('WRC_EGRESS_RECOVERY_REQUIRED')
    }
  } catch (error) {
    process.stderr.write(
      'WRC_EGRESS_RECOVERY_REQUIRED: resolve the owned gate journal before certification\n'
    )
    process.exitCode = 1
  }
}
