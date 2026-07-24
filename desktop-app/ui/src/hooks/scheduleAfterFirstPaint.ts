export function scheduleAfterFirstPaint(task: () => Promise<unknown>): void {
  const run = () => {
    void task().catch(() => undefined)
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(run))
    return
  }
  setTimeout(run, 0)
}
