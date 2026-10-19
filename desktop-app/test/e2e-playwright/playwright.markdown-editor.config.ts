import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/markdown-source-editor.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:5174',
  },
  webServer: {
    command: 'npm run dev:renderer -- --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174/markdown-source-editor-test.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
