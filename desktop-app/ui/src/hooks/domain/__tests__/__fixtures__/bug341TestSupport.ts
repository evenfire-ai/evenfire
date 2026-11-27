import { inject } from 'vitest'
import { readFileSync } from 'node:fs'
import sessionProducer from './bug341SessionProducer.json'
import taskProgressCompleted from './bug341TaskProgressCompleted.json'
import taskProgressGone from './bug341TaskProgressGone.json'

const fixtures: Record<string, unknown> = {
  'bug341SessionProducer.json': sessionProducer,
  'bug341TaskProgressCompleted.json': taskProgressCompleted,
  'bug341TaskProgressGone.json': taskProgressGone,
}

export function bug341ScratchRoot(): string {
  return process.env.BUG341_SCRATCH_DIR ?? inject('mockClerumStoreRoot')
}

export function readBug341Fixture(fileName: string, outputVariable: string): unknown {
  const outputPath = process.env[outputVariable]
  if (outputPath) return JSON.parse(readFileSync(outputPath, 'utf8'))
  const fixture = fixtures[fileName]
  if (!fixture) throw new Error(`Unknown BUG-341 producer fixture: ${fileName}`)
  return fixture
}
