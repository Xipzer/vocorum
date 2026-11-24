// The CLI's help: grouped, plain, and never a side effect. Asking for help with any
// command prints help and changes nothing.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { printChecks } from '../src/doctor.ts'

const bin = path.resolve(import.meta.dirname, '../bin/vocorum.js')
const run = (...args: string[]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-help-'))
  const out = spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, VOCORUM_DIR: path.join(dir, 'state'), NO_COLOR: '1' }, encoding: 'utf8' })
  const created = fs.existsSync(path.join(dir, 'state'))
  fs.rmSync(dir, { recursive: true, force: true })
  return { ...out, created }
}

test('vocorum on its own prints the commands in groups', () => {
  const { stdout, status } = run()
  expect(status).toBe(0)
  for (const group of ['Get started', 'Move from Discord', 'Bots and machines', 'People and devices', 'Servers and settings']) expect(stdout).toContain(group)
  expect(stdout).not.toContain('src/')
})

test('--help prints a command\'s options and never runs it', () => {
  for (const command of ['init', 'start', 'bots', 'people', 'devices', 'guilds', 'machines', 'private', 'kimaki', 'requests', 'request', 'discord']) {
    const { stdout, status, created } = run(command, '--help')
    expect(status, command).toBe(0)
    expect(stdout, command).toMatch(new RegExp(`vocorum (${command}|discord)`))
    expect(created, command).toBe(false)
  }
})

test('an unknown command says so, shows the commands and fails', () => {
  const { stdout, stderr, status } = run('frobnicate')
  expect(status).toBe(1)
  expect(stderr).toContain('Unknown command: frobnicate')
  expect(stdout).toContain('Get started')
})

test('doctor output: plain names in a column, fixes underneath, a summary with real plurals', () => {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
  printChecks([
    { id: 'node', status: 'ok', detail: 'Node 22.1.0' },
    { id: 'listen-address', status: 'fail', detail: 'nothing listens', fix: 'vocorum restart' },
    { id: 'name hub-1.example.ts.net', status: 'warn', detail: 'does not resolve here' },
    { id: 'ffmpeg', status: 'warn', detail: 'not installed', fix: 'install ffmpeg' },
  ])
  log.mockRestore()
  const text = lines.join('\n')
  expect(text).toContain('Node.js')
  expect(text).toContain('Listening on')
  expect(text).toContain('Name hub-1.example.ts.net')
  expect(text).toContain('Fix: vocorum restart')
  expect(text).toContain('1 problem to fix, 2 warnings.')
  expect(text).not.toContain('(s)')
})
