import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** The renderer alone, in a browser, against a running agent server. For
 *  building the UI without launching Electron — and the seed of the web app. */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  build: {
    assetsInlineLimit: (file) => (file.includes('material-icon-theme') ? false : undefined)
  },
  server: { port: 5173, strictPort: true }
})
