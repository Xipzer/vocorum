#!/usr/bin/env node
// Runs src/cli.ts through tsx, from any working directory. On a fresh clone it installs
// the packages first (setup then builds the app), so the first command is the only one.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const loaderFile = path.join(root, 'node_modules/tsx/dist/loader.mjs')

if (!fs.existsSync(loaderFile)) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 16)) {
    console.error(`Vocorum needs Node.js 22.16 or newer (this is ${process.versions.node}).`)
    process.exit(1)
  }
  console.error('First run: installing packages. This takes a minute or two.')
  // pnpm as it is on this machine: on the PATH, through corepack (it ships with Node), or fetched by npx.
  const win = process.platform === 'win32'
  const beside = (name) => path.join(path.dirname(process.execPath), win ? `${name}.cmd` : name)
  const wanted = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager ?? 'pnpm'
  const launchers = [['pnpm'], [beside('corepack'), 'pnpm'], ['corepack', 'pnpm'], [beside('npx'), '--yes', wanted], ['npx', '--yes', wanted]]
  // The packages' own scripts call pnpm by name: whichever way works gets a launcher of that
  // name, first on the PATH (the same folder src/updates.ts uses).
  const bin = path.join(root, 'node_modules', '.cache', 'vocorum-bin')
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  let installed = false
  let said = ''
  for (const [cmd, ...prefix] of launchers) {
    if (spawnSync(cmd, [...prefix, '--version'], { cwd: root, shell: win, env, stdio: 'ignore' }).status !== 0) continue
    if (cmd !== 'pnpm') {
      fs.mkdirSync(bin, { recursive: true })
      const quoted = [cmd, ...prefix].map((part) => `"${part}"`).join(' ')
      if (win) fs.writeFileSync(path.join(bin, 'pnpm.cmd'), `@${quoted} %*\r\n`)
      else fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 })
    }
    const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, encoding: 'utf8', shell: win, env })
    installed = result.status === 0
    if (!installed) said = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n')
    break
  }
  if (!installed || !fs.existsSync(loaderFile)) {
    console.error(`${said ? `${said}\n\n` : ''}The packages could not be installed. Get pnpm (corepack enable, or npm install -g pnpm), then run in ${root}:\n  pnpm install`)
    process.exit(1)
  }
}

const loader = pathToFileURL(loaderFile).href
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', loader, path.join(root, 'src/cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
