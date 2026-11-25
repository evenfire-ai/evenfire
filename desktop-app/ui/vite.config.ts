import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'

const desktopPackageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
) as { version?: string }

export default defineConfig({
  root: path.resolve(__dirname),
  // Electron loads via file:// — absolute paths (/assets/...) break.
  // './' generates relative paths (./assets/...) that work with loadFile().
  base: './',
  plugins: [react()],
  define: {
    __DESKTOP_APP_VERSION__: JSON.stringify(desktopPackageJson.version || 'unknown'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@constants': path.resolve(__dirname, 'src/constants'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@lib': path.resolve(__dirname, 'src/lib'),
      '@pages': path.resolve(__dirname, 'src/pages'),
      '@contexts': path.resolve(__dirname, 'src/contexts'),
      '@styles': path.resolve(__dirname, 'src/styles'),
      '@types': path.resolve(__dirname, 'src/types'),
      // Its browser build needs a document, which the Markdown worker lacks.
      'decode-named-character-reference': path.resolve(
        __dirname,
        '../node_modules/decode-named-character-reference/index.js'
      ),
    },
  },
  optimizeDeps: {
    // These linked workspace packages are CommonJS; prebundle them for Vite's dev server.
    include: ['@clerum/gfs-interaction-policy', '@clerum/desktop-app-links'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, '../ui-dist'),
    emptyOutDir: true,
    // The CSP blocks fonts inlined as data: URLs.
    assetsInlineLimit: (filePath: string) =>
      /\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined,
  },
})
