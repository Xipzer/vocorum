import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: path.join(import.meta.dirname, 'dist'), emptyOutDir: true, sourcemap: false, target: 'es2022' },
})
