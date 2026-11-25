import path from 'node:path'
import { defineConfig, mergeConfig } from 'vite'
import appConfig from './vite.config'

// The hidden page the main process draws the chat's Mermaid diagrams in. It
// is built beside the app into ui-dist, after the app build has emptied it.
export default mergeConfig(
  appConfig,
  defineConfig({
    build: {
      emptyOutDir: false,
      rollupOptions: { input: { diagram: path.resolve(__dirname, 'diagram.html') } },
    },
  })
)
