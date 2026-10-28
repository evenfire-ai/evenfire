import { installAntdDomEnvironment } from './antdDomEnvironment'

if (typeof window !== 'undefined') installAntdDomEnvironment()

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
})
