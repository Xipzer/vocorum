import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VOCORUM_PROFILE=1 builds with React's profiling renderer, so the stall log can say which
// part of the app a slow event spent its time in. Ordinary builds are unaffected.
const profile = Boolean(process.env.VOCORUM_PROFILE)

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: profile ? { alias: { 'react-dom/client': 'react-dom/profiling' } } : undefined,
  build: { outDir: path.join(import.meta.dirname, 'dist'), emptyOutDir: true, sourcemap: false, target: 'es2022' },
})
