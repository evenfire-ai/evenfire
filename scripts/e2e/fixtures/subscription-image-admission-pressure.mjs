// Frozen client surface for the private admission-pressure companion.
//
// openAdmissionPressure({ receiptFile, socketPath, deadlineMs }) -> {
//   hold({ maxInFlight }) -> PressureObservation
//   owners()              -> PressureObservation
//   release()             -> PressureObservation
//   close()               -> void
// }
//
// PressureObservation = {
//   pressureRunId: string,
//   maxInFlight: number,
//   owners: { baseline: number, held: number, drained: number },
//   counts: { sameRunAttempts: number, sameRunTickets: number, reservations: number },
//   pids: number[],
//   inspector: { pid: number, startTime: string }
// }
//
// The main-sealed receipt (readMainRecord, uid != container, mode 0600) carries:
//   { kind: 'evenfire-subscription-image-pressure-metadata-v1',
//     profile, context, worktreeId, sourceManifestSha256, podUid,
//     imageId: 'sha256:<64>', pressureRunId, hostRefs: [string, string],
//     maxInFlight: number, socketPath: '/abs/path/pressure.sock' }
// No credentials travel over this channel. Commands are newline-delimited JSON:
//   { command: 'hello'|'hold'|'owners'|'release'|'close', pressureRunId, maxInFlight? }
// Replies: { ok: true, ... } or { ok: false, code }.
// Main owns making socketPath reachable inside the runner and proving the relay
// under the branch Make lease; this client never invents an endpoint.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  RunnerAdmissionError,
  readMainRecord,
} from '../../tests/lib/subscription-image-runner-contract.mjs'

const refuse = code => {
  throw new RunnerAdmissionError(code)
}
const MAX_FRAME_BYTES = 64 * 1024

export function verifyPressureMetadata(metadata) {
  if (
    metadata?.kind !== 'evenfire-subscription-image-pressure-metadata-v1' ||
    typeof metadata.profile !== 'string' ||
    metadata.context !== metadata.profile ||
    !/^[a-f0-9]{40}$/.test(metadata.worktreeId ?? '') ||
    !/^[a-f0-9]{64}$/.test(metadata.sourceManifestSha256 ?? '') ||
    typeof metadata.podUid !== 'string' ||
    !metadata.podUid ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.imageId ?? '') ||
    !/^subscription-image-pressure-[a-f0-9]{12}$/.test(metadata.pressureRunId ?? '') ||
    !Array.isArray(metadata.hostRefs) ||
    metadata.hostRefs.length !== 2 ||
    new Set(metadata.hostRefs).size !== 2 ||
    metadata.hostRefs.some(value => typeof value !== 'string' || !value) ||
    !Number.isSafeInteger(metadata.maxInFlight) ||
    metadata.maxInFlight < 1 ||
    typeof metadata.socketPath !== 'string' ||
    !path.isAbsolute(metadata.socketPath)
  )
    refuse('ADMISSION_PRESSURE_METADATA_INVALID')
  return metadata
}

export function verifyPressureObservation(value, expectation = {}, metadata) {
  const owners = value?.owners,
    counts = value?.counts
  if (
    value?.ok !== true ||
    (metadata !== undefined &&
      (value.pressureRunId !== metadata.pressureRunId ||
        value.maxInFlight !== metadata.maxInFlight)) ||
    owners?.baseline !== 0 ||
    !Number.isSafeInteger(owners?.held) ||
    owners.held < 0 ||
    !Number.isSafeInteger(owners?.drained) ||
    owners.drained < 0 ||
    counts?.sameRunAttempts !== 0 ||
    counts?.sameRunTickets !== 0 ||
    counts?.reservations !== 0 ||
    !Array.isArray(value?.pids) ||
    !value.pids.length ||
    value.pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) ||
    !Number.isSafeInteger(value?.inspector?.pid) ||
    !value.pids.includes(value.inspector.pid) ||
    typeof value?.inspector?.startTime !== 'string' ||
    !value.inspector.startTime
  )
    refuse('ADMISSION_PRESSURE_OBSERVATION_INVALID')
  if (expectation.held !== undefined && owners.held !== expectation.held)
    refuse('ADMISSION_PRESSURE_HELD_MISMATCH')
  if (expectation.drained !== undefined && owners.drained !== expectation.drained)
    refuse('ADMISSION_PRESSURE_DRAINED_MISMATCH')
  return {
    pressureRunId: value.pressureRunId,
    maxInFlight: value.maxInFlight,
    owners: { baseline: 0, held: owners.held, drained: owners.drained },
    counts: { sameRunAttempts: 0, sameRunTickets: 0, reservations: 0 },
    pids: [...value.pids],
    inspector: { pid: value.inspector.pid, startTime: value.inspector.startTime },
  }
}

/**
 * @param {{ receiptFile?: string, deadlineMs?: number }} options
 */
export async function openAdmissionPressure({ receiptFile, deadlineMs = 30_000 } = {}) {
  if (typeof receiptFile !== 'string' || !path.isAbsolute(receiptFile))
    refuse('ADMISSION_PRESSURE_RECEIPT_REQUIRED')
  const metadata = verifyPressureMetadata(readMainRecord(receiptFile).value)
  if (!fs.existsSync(metadata.socketPath)) refuse('ADMISSION_PRESSURE_SOCKET_MISSING')
  const socket = await new Promise((resolve, reject) => {
    const candidate = net.connect({ path: metadata.socketPath })
    const timer = setTimeout(() => {
      candidate.destroy()
      reject(new RunnerAdmissionError('ADMISSION_PRESSURE_SOCKET_TIMEOUT'))
    }, deadlineMs)
    candidate.once('connect', () => {
      clearTimeout(timer)
      resolve(candidate)
    })
    candidate.once('error', () => {
      clearTimeout(timer)
      reject(new RunnerAdmissionError('ADMISSION_PRESSURE_SOCKET_FAILED'))
    })
  })
  const request = command => {
    const body = `${JSON.stringify({ ...command, pressureRunId: metadata.pressureRunId })}\n`
    return new Promise((resolve, reject) => {
      let buffered = ''
      const onData = chunk => {
        buffered += chunk.toString('utf8')
        if (Buffer.byteLength(buffered, 'utf8') > MAX_FRAME_BYTES) {
          cleanup()
          socket.destroy()
          reject(new RunnerAdmissionError('ADMISSION_PRESSURE_FRAME_BOUND'))
          return
        }
        const end = buffered.indexOf('\n')
        if (end < 0) return
        const line = buffered.slice(0, end)
        cleanup()
        try {
          resolve(JSON.parse(line))
        } catch {
          reject(new RunnerAdmissionError('ADMISSION_PRESSURE_REPLY_INVALID'))
        }
      }
      const onError = () => {
        cleanup()
        socket.destroy()
        reject(new RunnerAdmissionError('ADMISSION_PRESSURE_SOCKET_FAILED'))
      }
      const onClose = () => {
        cleanup()
        reject(new RunnerAdmissionError('ADMISSION_PRESSURE_SOCKET_CLOSED'))
      }
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        reject(new RunnerAdmissionError('ADMISSION_PRESSURE_COMMAND_TIMEOUT'))
      }, deadlineMs)
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      socket.write(body)
    })
  }
  let hello
  try {
    hello = await request({ command: 'hello' })
    if (hello?.ok !== true) refuse('ADMISSION_PRESSURE_HELLO_REFUSED')
  } catch (err) {
    socket.destroy()
    throw err
  }
  let stable
  const observed = (value, expectation = {}) => {
    const observation = verifyPressureObservation(value, expectation, metadata)
    if (!stable) stable = observation
    else if (
      observation.inspector.pid !== stable.inspector.pid ||
      observation.inspector.startTime !== stable.inspector.startTime ||
      observation.pids.join(',') !== stable.pids.join(',')
    )
      refuse('ADMISSION_PRESSURE_PROCESS_CHANGED')
    return observation
  }
  observed(hello)
  return {
    metadata,
    async hold({ maxInFlight } = {}) {
      const expected = maxInFlight ?? metadata.maxInFlight
      if (!Number.isSafeInteger(expected) || expected < 1 || expected !== metadata.maxInFlight)
        refuse('ADMISSION_PRESSURE_MAX_IN_FLIGHT')
      return observed(
        await request({ command: 'hold', maxInFlight: expected }),
        { held: expected, drained: 0 }
      )
    },
    async owners() {
      return observed(await request({ command: 'owners' }))
    },
    async release() {
      return observed(await request({ command: 'release' }))
    },
    async close() {
      try {
        await request({ command: 'close' })
      } finally {
        socket.destroy()
      }
    },
  }
}
