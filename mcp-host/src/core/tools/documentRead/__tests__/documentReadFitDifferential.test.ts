import { describe, expect, it } from 'vitest'
import { DocumentReadTool } from '../index'
import { runFitScenarios } from './fitScenarios'

/**
 * Independent review M2 cut the measures of the XLSX row probes and of the
 * budget fit. Neither may change what a read returns: these are digests of
 * every result of each read chain, produced by the implementation before that
 * change (5af3a16ce). A change here is a change in what the model reads, and
 * needs its own justification.
 */
describe('document read results are unchanged by the M2 measure cuts', () => {
  it('emits the same results through every scenario chain', async () => {
    const runs = await runFitScenarios(DocumentReadTool)
    expect(runs.map(run => [run.name, run.digest, run.calls])).toEqual([
      ['xlsx long sheet list (turn)', '6f740f0b54cf786e', 2],
      ['xlsx long sheet list (fresh)', '13554878c75ef5d2', 24],
      ['xlsx sheet boundaries (turn)', 'f46b6c67f018c0fd', 3],
      ['xlsx sheet boundaries (fresh)', 'df4add5392b936bb', 3],
      ['xlsx parser-skipped rows (turn)', 'a24883c6392d1671', 3],
      ['xlsx parser-skipped rows (fresh)', 'a95af489440ea891', 3],
      ['xlsx all rows too wide (turn)', 'ff4dd233f07d8713', 1],
      ['xlsx all rows too wide (fresh)', 'ff4dd233f07d8713', 1],
      ['xlsx nearly full page (turn)', '93b1c822d2712b01', 2],
      ['xlsx nearly full page (fresh)', 'bb1edc5fbaea20ef', 5],
      ['xlsx mixed widths (turn)', '7d60396cfeb08778', 3],
      ['xlsx mixed widths (fresh)', '51aa021abb7eac69', 7],
      ['pdf one long page (turn)', '05adf470191929db', 3],
      ['pdf one long page (fresh)', 'c6229cbd7864c70a', 16],
      ['pdf pages with a secret (turn)', '6e8d6a5b977e9a0a', 3],
      ['pdf pages with a secret (fresh)', '5254d3d47eecc5c9', 6],
      ['pdf surrogate pairs (turn)', 'c47e2d0ce4829179', 3],
      ['pdf surrogate pairs (fresh)', 'b0cbbbcbc2567dd9', 4],
    ])
  }, 60_000)
})
