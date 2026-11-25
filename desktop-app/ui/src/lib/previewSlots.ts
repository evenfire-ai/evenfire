type ReleaseSlot = () => void

type PreviewSlots = Readonly<{ acquire: (signal?: AbortSignal) => Promise<ReleaseSlot> }>

function closedError(): Error {
  return new Error('The preview closed before its turn')
}

/** FIFO semaphore; an aborted waiter leaves the queue. */
export function createPreviewSlots(limit: number): PreviewSlots {
  let running = 0
  const waiting: Array<() => void> = []

  const take = (): ReleaseSlot => {
    running += 1
    let released = false
    return () => {
      if (released) return
      released = true
      running -= 1
      waiting.shift()?.()
    }
  }

  return {
    acquire: signal => {
      if (signal?.aborted) return Promise.reject(closedError())
      if (running < limit) return Promise.resolve(take())
      return new Promise((resolve, reject) => {
        const start = () => {
          signal?.removeEventListener('abort', leave)
          resolve(take())
        }
        const leave = () => {
          const index = waiting.indexOf(start)
          if (index !== -1) waiting.splice(index, 1)
          reject(closedError())
        }
        waiting.push(start)
        signal?.addEventListener('abort', leave, { once: true })
      })
    },
  }
}
