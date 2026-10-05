import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ApprovedExecutionRequest,
  EXECUTION_RUN_ENTRYPOINT,
  TrustedHostExecutionIdentity,
  buildHostExecutionJob,
} from './jobFactory'

const identity: TrustedHostExecutionIdentity = {
  hostName: 'chatllm',
  hostUid: '9f0e3a5c-5f1e-4a4e-9a2d-3f4c5b6a7d8e',
  namespace: 'mcp-host',
  operationId: '7b1f0d2c-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
  hostGeneration: 7,
  image: 'registry.example.com/evenfire/mcp-host@sha256:0123456789abcdef',
  workspacePvcName: 'chatllm-workspace',
  userKey: '0123456789abcdef',
  workspaceLayoutPrefix: 'workspace/',
}

const baseRequest: ApprovedExecutionRequest = {
  kind: 'workspace',
  argv: [],
  timeoutMs: 60_000,
  scratchBytes: 33_554_432,
}

function podSpec(job: k8s.V1Job): k8s.V1PodSpec {
  return job.spec!.template.spec!
}

/**
 * Local launch-contract falsifier, not a Linux /proc or Kubernetes check. The
 * assembled Job command is executed with only its fixed image entrypoint
 * replaced by a synthetic Node fixture, so the wrapper's real descriptors,
 * output sinks and argument passing are observed from a child process.
 */
describe('executor launcher contract', () => {
  it('keeps wrapper stdio private and passes the approved vector literally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-execution-launcher-'))
    try {
      const reportPath = join(dir, 'report.json')
      const fixturePath = join(dir, 'fixture.cjs')
      const sideEffect = (name: string) => join(dir, `pwned-${name}`)
      const argv = [
        'plain',
        'a b',
        '"double quoted"',
        "'single quoted'",
        `$(touch ${sideEffect('dollar')})`,
        '`touch ' + sideEffect('backtick') + '`',
        `; touch ${sideEffect('semicolon')}`,
        `&& touch ${sideEffect('and')}`,
        `| touch ${sideEffect('pipe')}`,
        '$HOME',
        '*',
      ]
      const fixture = [
        "const fs = require('node:fs')",
        'const describeFd = fd => {',
        '  const stat = fs.fstatSync(fd)',
        '  return { isCharacterDevice: stat.isCharacterDevice(), rdev: stat.rdev }',
        '}',
        'fs.writeFileSync(process.env.LAUNCHER_FIXTURE_REPORT, JSON.stringify({',
        '  argv: process.argv.slice(2),',
        '  fd1: describeFd(1),',
        '  fd2: describeFd(2),',
        "  devNullRdev: fs.statSync('/dev/null').rdev,",
        '}))',
        "process.stdout.write('LAUNCHER_FIXTURE_STDOUT_SENTINEL')",
        "process.stderr.write('LAUNCHER_FIXTURE_STDERR_SENTINEL')",
      ].join('\n')
      writeFileSync(fixturePath, fixture)

      const job = buildHostExecutionJob(identity, { ...baseRequest, argv })
      const command = [...podSpec(job).containers![0].command!]
      const entrypointIndex = command.indexOf(EXECUTION_RUN_ENTRYPOINT)
      expect(entrypointIndex).toBeGreaterThanOrEqual(0)
      command[entrypointIndex] = fixturePath

      const result = spawnSync(command[0]!, command.slice(1), {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          LAUNCHER_FIXTURE_REPORT: reportPath,
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status).toBe(0)

      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        argv: string[]
        fd1: { isCharacterDevice: boolean; rdev: number }
        fd2: { isCharacterDevice: boolean; rdev: number }
        devNullRdev: number
      }
      expect(report.argv).toEqual([String(baseRequest.timeoutMs), ...argv])
      expect(report.fd1).toEqual({ isCharacterDevice: true, rdev: report.devNullRdev })
      expect(report.fd2).toEqual({ isCharacterDevice: true, rdev: report.devNullRdev })
      expect(result.stdout).not.toContain('LAUNCHER_FIXTURE_STDOUT_SENTINEL')
      expect(result.stderr).not.toContain('LAUNCHER_FIXTURE_STDERR_SENTINEL')
      for (const name of ['dollar', 'backtick', 'semicolon', 'and', 'pipe']) {
        expect(existsSync(sideEffect(name))).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
