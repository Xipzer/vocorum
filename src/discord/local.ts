// What the Discord tools need on this machine: the Discord bot token (never
// printed or written), the running hub's admin routes, read-only access to the
// hub's databases for verification, and job state under ~/.vocorum.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { openSqlite } from '../sqlite.ts'
import { readSecret, type HubConfig, type HubPaths } from '../config.ts'

export type TokenSource = { tokenFile?: string; kimaki?: boolean | string; stateDir?: string }

// Order: --token-file, DISCORD_BOT_TOKEN, --kimaki (this machine's Kimaki bot).
export async function discordToken(source: TokenSource): Promise<string> {
  if (source.tokenFile) {
    // The hub's own secrets (admin token, bot env files, keys) live there: never sent anywhere as a Discord token.
    if (source.stateDir) {
      const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p))
      const rel = path.relative(real(source.stateDir), real(source.tokenFile))
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`${source.tokenFile} is inside the hub's folder, where its own secrets are. Keep the Discord token somewhere else.`)
    }
    const mode = fs.statSync(source.tokenFile).mode & 0o077
    if (mode) console.error(`Warning: ${source.tokenFile} is readable by other users. Run: chmod 600 ${source.tokenFile}`)
    return fs.readFileSync(source.tokenFile, 'utf8').trim()
  }
  if (process.env['DISCORD_BOT_TOKEN']) return process.env['DISCORD_BOT_TOKEN'].trim()
  if (source.kimaki) {
    const dir = typeof source.kimaki === 'string' ? source.kimaki : path.join(os.homedir(), '.kimaki')
    const file = path.join(dir, 'kimaki.db')
    if (!fs.existsSync(file)) throw new Error(`No Kimaki database at ${file}`)
    const db = createClient({ url: `file:${file}` })
    try {
      const rows = await db.execute("SELECT token FROM bot_tokens ORDER BY (bot_mode = 'self_hosted') DESC, last_used_at DESC LIMIT 1")
      const token = rows.rows[0]?.['token']
      if (typeof token !== 'string' || !token) throw new Error('Kimaki has no saved bot token')
      return token
    } finally {
      db.close()
    }
  }
  throw new Error('No Discord bot token. Pass --token-file <file> (mode 0600), set DISCORD_BOT_TOKEN, or --kimaki to use this machine\'s Kimaki bot.')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The running hub's /admin routes (loopback, admin token). Retries while the hub restarts:
// everything the tools send is an upsert.
export class HubAdmin {
  private readonly token: string
  constructor(
    private readonly config: HubConfig,
    paths: HubPaths,
  ) {
    this.token = readSecret(paths.adminToken)
  }

  get base() {
    return `http://127.0.0.1:${this.config.port}`
  }

  async call<T = Record<string, unknown>>(method: string, route: string, body?: unknown, { raw = false, tries = 60 } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    if (body !== undefined) headers['content-type'] = raw ? 'application/octet-stream' : 'application/json'
    for (let attempt = 0; attempt < tries; attempt++) {
      let response: Response
      try {
        response = await fetch(`${this.base}${route}`, { method, headers, body: body === undefined ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
      } catch {
        await sleep(5000)
        continue
      }
      const json = (await response.json().catch(() => ({}))) as T & { error?: string }
      if (!response.ok) throw new Error(`hub ${method} ${route} answered ${response.status}: ${json.error ?? ''}`)
      return json
    }
    throw new Error('The hub is not answering. Start it (vocorum restart) and run this again; it resumes.')
  }

  // How long a cheap request takes, in ms (Infinity when it does not answer).
  async latency(): Promise<number> {
    const started = performance.now()
    try {
      await fetch(`${this.base}/admin/none`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) })
      return performance.now() - started
    } catch {
      return Infinity
    }
  }

  // Back-pressure: never let a long job make the hub slow for people using it.
  async yieldToHub() {
    for (let i = 0; i < 60; i++) {
      const ms = await this.latency()
      if (ms < 250) return
      await sleep(Math.min(10_000, 500 * (i + 1)))
    }
  }
}

export function openTwin(paths: HubPaths) {
  return openSqlite(paths.twinDb)
}

// hub.db and twin.db go through the same SQLite as the running hub
// (node:sqlite): two SQLite libraries on one file in one process can corrupt it.
export function openHubDb(paths: HubPaths) {
  return openSqlite(paths.hubDb)
}

export function jobDir(paths: HubPaths, name: 'import' | 'purge') {
  const dir = path.join(paths.root, name)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

// Atomic write, 0600.
export function writeJson(file: string, value: unknown) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}

// Secrets people and agents pasted into chats. High-confidence kinds only for
// the rotate list; values are only ever shown masked.
export const SECRET_PATTERNS: Record<string, RegExp> = {
  discord_token: /[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/g,
  openai_or_anthropic_key: /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  github_token: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/g,
  aws_key: /AKIA[0-9A-Z]{16}/g,
  google_key: /AIza[0-9A-Za-z_-]{35}/g,
  slack_token: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  telegram_bot_token: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
  private_key_block: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  env_secret: /^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|SEED|MNEMONIC|PRIVATE)[A-Z0-9_]*\s*=\s*\S{8,}/gm,
}

export const mask = (value: string) => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : '(short)')

type Text = { content?: string; embeds?: unknown[]; components?: unknown[] }
export function messageText(m: Text): string {
  const parts = [m.content ?? '']
  for (const e of (m.embeds ?? []) as Array<{ title?: string; description?: string; fields?: Array<{ name?: string; value?: string }> }>) {
    parts.push(e.title ?? '', e.description ?? '', ...(e.fields ?? []).map((f) => `${f.name ?? ''} ${f.value ?? ''}`))
  }
  const walk = (cs: unknown[] | undefined) => {
    for (const c of (cs ?? []) as Array<{ content?: string; label?: string; components?: unknown[] }>) {
      if (c.content) parts.push(c.content)
      if (c.label) parts.push(c.label)
      walk(c.components)
    }
  }
  walk(m.components)
  return parts.join('\n')
}

export function findSecrets(m: Text): Array<{ kind: string; value: string }> {
  const text = messageText(m)
  const found: Array<{ kind: string; value: string }> = []
  for (const [kind, re] of Object.entries(SECRET_PATTERNS)) for (const match of text.matchAll(re)) found.push({ kind, value: match[0] })
  // KEY=ghp_... is one secret, not two: keep the most specific match.
  return found.filter((f) => !found.some((o) => o !== f && o.value.length < f.value.length && f.value.includes(o.value)))
}

// Runs this same command again as its own service, so it survives the agent's
// shell and machine restarts. systemd-run where there is systemd, else a
// detached process with its output in a log file.
export async function detach(paths: HubPaths, name: string, argv: string[]): Promise<string> {
  const { spawn, spawnSync } = await import('node:child_process')
  const log = path.join(paths.root, `${name}.log`)
  const node = process.execPath
  const cli = path.resolve(import.meta.dirname, '../../bin/vocorum.js')
  const args = [cli, ...argv.filter((a) => a !== '--detach')]
  const unit = `vocorum-${name}-${Date.now().toString(36)}`
  const hasSystemd = process.platform === 'linux' && (spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout ?? '').trim() !== ''
  if (hasSystemd) {
    const result = spawnSync('systemd-run', ['--user', `--unit=${unit}`, '--collect', `--setenv=VOCORUM_DIR=${paths.root}`, ...(process.env['VOCORUM_DISCORD_API'] ? ['--setenv=VOCORUM_DISCORD_API'] : []), '-p', `StandardOutput=append:${log}`, '-p', `StandardError=append:${log}`, node, ...args], { encoding: 'utf8', env: process.env })
    if (result.status === 0) {
      recordJob(paths, { name, unit, pid: null, log, started: new Date().toISOString() })
      return `Running as ${unit}. Follow it with: vocorum discord status (log: ${log})`
    }
  }
  const out = fs.openSync(log, 'a', 0o600)
  const child = spawn(node, args, { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, VOCORUM_DIR: paths.root } })
  child.unref()
  recordJob(paths, { name, unit: null, pid: child.pid ?? null, log, started: new Date().toISOString() })
  return `Running in the background (pid ${child.pid}). Follow it with: vocorum discord status (log: ${log})`
}

export type Job = { name: string; unit: string | null; pid: number | null; log: string; started: string }

function recordJob(paths: HubPaths, job: Job) {
  const file = path.join(paths.root, 'jobs.json')
  writeJson(file, [...readJson<Job[]>(file, []).filter((j) => j.name !== job.name), job])
}

// Background jobs and whether they still run; a stopped one shows its last log line.
export async function jobs(paths: HubPaths): Promise<Array<Job & { running: boolean; last: string }>> {
  const { spawnSync } = await import('node:child_process')
  return readJson<Job[]>(path.join(paths.root, 'jobs.json'), []).map((job) => {
    let running = false
    if (job.unit) running = spawnSync('systemctl', ['--user', 'is-active', job.unit], { encoding: 'utf8' }).stdout.trim() === 'active'
    else if (job.pid) {
      try {
        process.kill(job.pid, 0)
        running = true
      } catch {}
    }
    const lines = fs.existsSync(job.log) ? fs.readFileSync(job.log, 'utf8').trim().split('\n') : []
    return { ...job, running, last: lines.at(-1) ?? '' }
  })
}
