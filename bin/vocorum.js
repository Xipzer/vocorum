#!/usr/bin/env node
// Runs src/cli.ts through tsx, from any working directory.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const loader = pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href
const child = spawn(process.execPath, ['--import', loader, path.join(root, 'src/cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
