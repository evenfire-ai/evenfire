export const EXPECTED_FOCUSED_PROCESSES = [
  {
    id: 'consent',
    selected: [
      'verifies the real user-data, consent directory, and produced consent file',
      'rejects an unsafe existing consent file without reading or overwriting it',
      'rejects an in-place DACL change without a filesystem identity change',
      'rejects consent when the produced atomic replacement becomes unsafe',
    ],
    maximumRuntimeMs: 345_000,
    noProgressMs: 120_000,
  },
  {
    id: 'audit-rotation',
    selected: ['verifies actual audit files and the rotated generation'],
    maximumRuntimeMs: 180_000,
    noProgressMs: 120_000,
  },
]

export const EXPECTED_DESELECTED_CASES = [
  'records bounded cleanup phases and entry ordinals',
  'reports an allowlisted cleanup error and leaves teardown fatal',
  'does not append after rotated audit verification rejects the destination',
  'rechecks a replaced consent file instead of returning cached grants',
  'rechecks a replaced consent directory before returning cached grants',
  'retains inherited effective access after an atomic consent replacement',
  'preserves consent corruption recovery as a verified inherited-DACL file',
  'rejects an unsafe user-data parent before creating consent files',
  'does not append to an audit file with unauthorized effective access',
]

export function focusedCaseCount(manifest) {
  return manifest.selected.length + manifest.deselected.length
}

export function validateFocusedManifest(manifest) {
  const selected = manifest?.selected
  const deselected = manifest?.deselected
  if (
    !Array.isArray(selected) ||
    !Array.isArray(deselected) ||
    selected.length !== EXPECTED_FOCUSED_PROCESSES.flatMap(value => value.selected).length ||
    JSON.stringify(deselected) !== JSON.stringify(EXPECTED_DESELECTED_CASES) ||
    deselected.length !== EXPECTED_DESELECTED_CASES.length ||
    [...selected, ...deselected].some(title => typeof title !== 'string' || title.length === 0) ||
    new Set([...selected, ...deselected]).size !== selected.length + deselected.length
  ) {
    throw new Error('Focused case manifest must contain five selected and nine deselected cases')
  }
  const normalizedProcesses = Array.isArray(manifest.processes)
    ? manifest.processes.map(process => ({
        id: process?.id,
        selected: process?.selected,
        maximumRuntimeMs: process?.maximumRuntimeMs,
        noProgressMs: process?.noProgressMs,
      }))
    : manifest.processes
  if (JSON.stringify(normalizedProcesses) !== JSON.stringify(EXPECTED_FOCUSED_PROCESSES)) {
    throw new Error(
      'Focused process selection or hard runtime limits differ from the approved plan'
    )
  }
  const processCases = manifest.processes.flatMap(process => process.selected)
  if (
    new Set(processCases).size !== selected.length ||
    selected.some(title => !processCases.includes(title)) ||
    processCases.some(title => !selected.includes(title))
  ) {
    throw new Error('Focused processes must partition the five selected cases exactly once')
  }
  return manifest
}

export function focusedTestNamePattern(processSpec) {
  const expected = EXPECTED_FOCUSED_PROCESSES.find(value => value.id === processSpec?.id)
  if (!expected || JSON.stringify(processSpec) !== JSON.stringify(expected))
    throw new Error('Unexpected focused process')
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `^Windows plugin storage DACL privacy (?:${processSpec.selected.map(escape).join('|')})$`
}

function assertProcessResult(result, processSpec, manifest) {
  if (
    result?.processId !== processSpec.id ||
    !/^[a-f0-9]{40}$/.test(result.sourceSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(result.harnessSha ?? '') ||
    !Array.isArray(result.selected) ||
    JSON.stringify(result.selected) !== JSON.stringify(processSpec.selected) ||
    result.passed !== processSpec.selected.length ||
    result.skippedInProcess !== focusedCaseCount(manifest) - processSpec.selected.length ||
    result.intentionallyDeselectedSkipped !== manifest.deselected.length ||
    result.deferredRequiredCasesSkipped !==
      manifest.selected.length - processSpec.selected.length ||
    !Number.isSafeInteger(result.elapsedMs) ||
    result.elapsedMs < 1 ||
    result.elapsedMs > processSpec.maximumRuntimeMs ||
    !Number.isSafeInteger(result.cleanupPhases) ||
    result.cleanupPhases < processSpec.selected.length
  ) {
    throw new Error(`Focused process ${processSpec.id} did not produce complete passing evidence`)
  }
}

export function aggregateFocusedResults(results, manifest) {
  validateFocusedManifest(manifest)
  if (!Array.isArray(results) || results.length !== EXPECTED_FOCUSED_PROCESSES.length)
    throw new Error('Focused aggregate is missing one or more process results')
  const sourceShas = new Set()
  const harnessShas = new Set()
  const completedCases = []
  let elapsedMs = 0
  const processes = []
  for (const [index, expected] of EXPECTED_FOCUSED_PROCESSES.entries()) {
    const result = results[index]
    assertProcessResult(result, expected, manifest)
    sourceShas.add(result.sourceSha)
    harnessShas.add(result.harnessSha)
    completedCases.push(...result.selected)
    elapsedMs += result.elapsedMs
    processes.push({
      id: expected.id,
      elapsedMs: result.elapsedMs,
      selectedPassed: result.passed,
      inProcessSkipped: result.skippedInProcess,
      cleanupPhases: result.cleanupPhases,
    })
  }
  if (
    sourceShas.size !== 1 ||
    harnessShas.size !== 1 ||
    completedCases.length !== manifest.selected.length ||
    new Set(completedCases).size !== manifest.selected.length ||
    manifest.selected.some(title => !completedCases.includes(title)) ||
    completedCases.some(title => !manifest.selected.includes(title)) ||
    elapsedMs > 525_000
  ) {
    throw new Error('Focused aggregate does not prove five distinct exact-source selected cases')
  }
  return {
    sourceSha: [...sourceShas][0],
    harnessSha: [...harnessShas][0],
    totalProcessElapsedMs: elapsedMs,
    requiredCases: manifest.selected.length,
    passedRequiredCases: completedCases.length,
    intentionallyDeselectedCases: manifest.deselected.length,
    intentionallyDeselectedSkippedInEachProcess: manifest.deselected.length,
    deferredRequiredCaseSkipsAcrossProcesses: manifest.selected.length,
    processes,
  }
}

export async function executeFocusedSequence(manifest, runAndVerify) {
  validateFocusedManifest(manifest)
  if (typeof runAndVerify !== 'function') throw new Error('Focused process runner is required')
  const results = []
  for (const processSpec of manifest.processes) {
    const result = await runAndVerify(processSpec)
    assertProcessResult(result, processSpec, manifest)
    if (
      results.length > 0 &&
      (result.sourceSha !== results[0].sourceSha || result.harnessSha !== results[0].harnessSha)
    ) {
      throw new Error('Focused process source or harness identity changed between processes')
    }
    results.push(result)
  }
  return aggregateFocusedResults(results, manifest)
}
