import { expect } from 'vitest'

/** The test running now, recorded on each request a watch harness sends. */
export const currentTest = () => expect.getState().currentTestName ?? '<outside a test>'
