export class GfsSubjectBatchError extends Error {
  readonly failedSubjectKeys: string[]
  readonly succeededSubjectKeys: string[]

  constructor(
    actionLabel: string,
    succeededSubjectKeys: string[],
    failures: Array<{ subjectKey: string; message: string }>
  ) {
    const failedSummary = failures
      .map(failure => `${failure.subjectKey} (${failure.message})`)
      .join(', ')
    const succeededSummary = succeededSubjectKeys.length
      ? ` Succeeded: ${succeededSubjectKeys.join(', ')}.`
      : ''
    super(`${actionLabel} failed for ${failedSummary}.${succeededSummary}`)
    this.name = 'GfsSubjectBatchError'
    this.failedSubjectKeys = failures.map(failure => failure.subjectKey)
    this.succeededSubjectKeys = succeededSubjectKeys
  }
}

export async function runGfsSubjectBatch(
  actionLabel: string,
  subjectKeys: string[],
  action: (subjectKey: string) => Promise<void>
): Promise<string[]> {
  const succeededSubjectKeys: string[] = []
  const failures: Array<{ subjectKey: string; message: string }> = []

  for (const subjectKey of subjectKeys) {
    try {
      await action(subjectKey)
      succeededSubjectKeys.push(subjectKey)
    } catch (error) {
      failures.push({
        subjectKey,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (failures.length > 0) {
    throw new GfsSubjectBatchError(actionLabel, succeededSubjectKeys, failures)
  }
  return succeededSubjectKeys
}
