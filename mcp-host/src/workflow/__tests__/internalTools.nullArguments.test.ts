/**
 * Many models send null for every optional argument they leave out. Every
 * internal tool reads such a null as unset, from chat (execute called directly)
 * and from a workflow step (StepMcpRouter), so a call means the same on both
 * paths. The step's record keeps what the model sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WorkflowTriggerTool } from '../../core/tools/workflowTriggerTool'
import { INTERNAL_TOOLS } from '../internalTools'
import { workflowRouter } from './support/workflowRouter'

const tool = (name: string) => INTERNAL_TOOLS.find(t => t.name === `clerum__${name}`)!

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-nulls-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a null optional argument', () => {
  it('reaches trigger_workflow from chat as unset, as it does from a step', async () => {
    const execute = vi
      .spyOn(WorkflowTriggerTool.prototype, 'execute')
      .mockResolvedValue({ content: 'started', is_error: false, duration_ms: 0 })
    const sent = {
      namespace: 'team',
      name: 'weekly-report',
      timeoutSeconds: null,
      targetUserId: null,
    }

    await tool('trigger_workflow').execute({ ...sent }, dir)
    await workflowRouter(dir).callTool('clerum__trigger_workflow', { ...sent })

    expect(execute).toHaveBeenCalledTimes(2)
    for (const [args] of execute.mock.calls) {
      expect(args).toEqual({ namespace: 'team', name: 'weekly-report' })
    }
  })

  it('is recorded by a workflow step as the model sent it', async () => {
    const sent = { filename: 'n.pdf', body: 'x', title: null, palette: null }
    const { result, record } = await workflowRouter(dir).callTool('clerum__generate_pdf', {
      ...sent,
    })
    expect(result.isError).toBe(false)
    expect(record.args).toEqual(sent)
  })

  it('is recorded as sent when the arguments fail validation', async () => {
    const sent = { filename: 42, body: 'x', title: null }
    const { result, record } = await workflowRouter(dir).callTool('clerum__generate_pdf', {
      ...sent,
    })
    expect(result.isError).toBe(true)
    expect(record.args).toEqual(sent)
  })
})
