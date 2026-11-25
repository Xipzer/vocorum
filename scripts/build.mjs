// Bundles the hub (and the twin's TypeScript source) into dist/hub.mjs so
// the service runs on plain node: no tsx transpiler resident in memory.
// npm dependencies stay external and load from node_modules.

import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const twin = path.resolve(root, 'vendor/discord-digital-twin')

await build({
  entryPoints: [path.join(root, 'src/cli.ts')],
  outfile: path.join(root, 'dist/hub.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'external-packages',
      setup(b) {
        // Bundle the workspace twin (TypeScript source); every other package stays external.
        // Bare package names only: a Windows path (C:\\...) starts with a letter too.
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('discord-digital-twin') || path.isAbsolute(args.path) ? undefined : { path: args.path, external: true }))
      },
    },
  ],
  // External packages resolve from the twin's node_modules too (prisma, libsql).
  nodePaths: [path.join(twin, 'node_modules')],
})
fs.copyFileSync(path.join(twin, 'src/schema.sql'), path.join(root, 'dist/schema.sql'))
console.log('built dist/hub.mjs')
