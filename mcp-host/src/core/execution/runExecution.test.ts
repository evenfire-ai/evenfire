import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_CAPTURED_OUTPUT_BYTES, MAX_EXECUTION_TIMEOUT_MS, runExecution } from './runExecution'

const execPath = process.execPath
/** Fixture child: this same Node binary, never a shell or an external script. */
const fixture = (script: string, ...args: string[]) => [execPath, '-e', script, ...args]
/**
 * Long-lived fixtures self-terminate, so even a deliberately broken launcher
 * under mutation cannot leave a child of this suite running.
 */
const WATCHDOG = 'setTimeout(() => process.exit(9), 30_000); '
const decode = (base64: string) => Buffer.from(base64, 'base64')
const text = (base64: string) => decode(base64).toString('utf8')

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('isolated execution launcher', () => {
  it('runs the approved argument vector literally, without a shell', async () => {
    const literals = ['a b', '$HOME', '; echo pwned', '$(id)', '*']
    const result = await runExecution(10_000, [
      execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ...literals,
    ])

    expect(result).toMatchObject({
      reason: 'exited',
      exitCode: 0,
      signal: null,
      truncated: false,
    })
    // No expansion, splitting or quoting happened: the bytes are the literals.
    expect(JSON.parse(text(result.stdout))).toEqual(literals)
    expect(result.stderr).toBe('')
  })

  it('passes only the fixed non-secret environment with HOME at the cwd', async () => {
    process.env.PR932_LAUNCHER_ENV_LEAK = 'must-not-reach-the-child'
    try {
      const result = await runExecution(
        10_000,
        fixture('process.stdout.write(JSON.stringify(process.env))')
      )
      const env = JSON.parse(text(result.stdout))
      // macOS adds this CoreFoundation text-encoding variable on its own; the
      // launcher itself passes exactly the fixed set below.
      delete env.__CF_USER_TEXT_ENCODING
      expect(env).toEqual({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: process.cwd(),
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
      })
    } finally {
      delete process.env.PR932_LAUNCHER_ENV_LEAK
    }
  })

  it('does not forward or interpret stdin', async () => {
    const result = await runExecution(
      10_000,
      fixture(
        'let bytes = 0; process.stdin.on("data", chunk => { bytes += chunk.length }); ' +
          'setTimeout(() => process.stdout.write(String(bytes)), 150)'
      )
    )

    expect(text(result.stdout)).toBe('0')
  })

  it('preserves arbitrary binary bytes through base64', async () => {
    const bytes = Buffer.from([0, 1, 2, 0x7f, 0x80, 0xff, 0x0a, 0x0d])
    const result = await runExecution(
      10_000,
      fixture(`process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`)
    )

    expect(decode(result.stdout)).toEqual(bytes)
    expect(result.truncated).toBe(false)
  })

  it('bounds stdout and stderr together at the aggregate cap and stops the child', async () => {
    const half = 40 * 1024
    const result = await runExecution(
      10_000,
      fixture(
        WATCHDOG +
          `process.stdout.write(Buffer.alloc(${half}, 65)); ` +
          `process.stderr.write(Buffer.alloc(${half}, 66)); setInterval(() => {}, 1000)`
      )
    )

    expect(result.reason).toBe('output_limit')
    expect(result.truncated).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    const captured = decode(result.stdout).length + decode(result.stderr).length
    expect(captured).toBe(MAX_CAPTURED_OUTPUT_BYTES)
    expect(decode(result.stdout).length).toBeLessThanOrEqual(half)
  })

  it('stops the approved command at the timeout', async () => {
    const result = await runExecution(250, fixture(`${WATCHDOG}setInterval(() => {}, 1000)`))

    expect(result).toEqual({
      reason: 'timeout',
      exitCode: null,
      signal: 'SIGKILL',
      truncated: false,
      stdout: '',
      stderr: '',
    })
  })

  it('reports a spawn failure without throwing or leaking an exception', async () => {
    const result = await runExecution(10_000, ['/nonexistent/pr932-execution-fixture', 'x'])

    expect(result).toEqual({
      reason: 'spawn_failed',
      exitCode: null,
      signal: null,
      truncated: false,
      stdout: '',
      stderr: '',
    })
  })

  it('keeps a huge output bounded to the cap', async () => {
    const result = await runExecution(
      30_000,
      fixture('process.stdout.write(Buffer.alloc(10 * 1024 * 1024, 97))')
    )

    expect(result.reason).toBe('output_limit')
    expect(result.truncated).toBe(true)
    expect(decode(result.stdout).length).toBeLessThanOrEqual(MAX_CAPTURED_OUTPUT_BYTES)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_CAPTURED_OUTPUT_BYTES * 2)
  })

  it('reports exit codes and signals separately from the reason', async () => {
    const exited = await runExecution(10_000, fixture('process.exit(7)'))
    expect(exited).toMatchObject({
      reason: 'exited',
      exitCode: 7,
      signal: null,
      truncated: false,
    })

    const signalled = await runExecution(10_000, fixture('process.kill(process.pid, "SIGTERM")'))
    expect(signalled).toMatchObject({
      reason: 'exited',
      exitCode: null,
      signal: 'SIGTERM',
      truncated: false,
    })
  })

  it('rejects an invalid launcher contract without spawning anything', async () => {
    const invalid: Array<[number, string[]]> = [
      [MAX_EXECUTION_TIMEOUT_MS + 1, [execPath]],
      [0, [execPath]],
      [-1, [execPath]],
      [1.5, [execPath]],
      [Number.NaN, [execPath]],
      [10_000, []],
      [10_000, ['']],
      [10_000, ['x\0y']],
    ]
    for (const [timeoutMs, argv] of invalid) {
      await expect(runExecution(timeoutMs, argv)).resolves.toEqual({
        reason: 'invalid_contract',
        exitCode: null,
        signal: null,
        truncated: false,
        stdout: '',
        stderr: '',
      })
    }
    // The maximum accepted timeout still runs.
    await expect(
      runExecution(MAX_EXECUTION_TIMEOUT_MS, fixture('process.exit(0)'))
    ).resolves.toMatchObject({ reason: 'exited', exitCode: 0 })
  })

  it('never writes child content or raw errors to the launcher streams', async () => {
    const writes: string[] = []
    const intercept = () =>
      ((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as unknown as typeof process.stdout.write
    const originalOut = process.stdout.write
    const originalErr = process.stderr.write
    process.stdout.write = intercept()
    process.stderr.write = intercept()
    try {
      const result = await runExecution(
        10_000,
        fixture("process.stdout.write('hidden-out'); process.stderr.write('hidden-err')")
      )
      expect(text(result.stdout)).toBe('hidden-out')
      expect(text(result.stderr)).toBe('hidden-err')
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    }
    expect(writes).toEqual([])
  })

  it('stops descendants through the process group, not only the direct child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pr932-exec-group-'))
    tempDirs.push(dir)
    const marker = join(dir, 'descendant-ran')
    const grandchild =
      "setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'late') }, 600)"
    const child =
      WATCHDOG +
      `require('child_process').spawn(process.execPath, ['-e', ` +
      `${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}], { stdio: 'ignore' }); ` +
      'setInterval(() => {}, 1000)'

    const result = await runExecution(250, [execPath, '-e', child])
    expect(result.reason).toBe('timeout')

    await new Promise(resolve => setTimeout(resolve, 900))
    await expect(stat(marker)).rejects.toThrow()
  })
})
