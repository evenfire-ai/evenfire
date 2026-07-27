export function scheduleAfterFirstPaint(task: () => Promise<unknown>): void {
  let didRun = false
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  const run = () => {
    if (didRun) return
    didRun = true
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
    void task().catch(() => undefined)
  }
  if (typeof requestAnimationFrame === 'function') {
    fallbackTimer = setTimeout(run, 1000)
    requestAnimationFrame(() => requestAnimationFrame(run))
    return
  }
  setTimeout(run, 0)
}
