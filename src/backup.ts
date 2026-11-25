// `vocorum backup` and `vocorum restore`: everything a hub is, so it can come
// back on another machine with every paired device still trusting it.
//
// A backup holds both databases (a consistent snapshot while the hub runs),
// the config, the secrets (admin token, cookie signing key, push keys, bot env
// files), the CA and server certificate, the stored files, and the hub's own
// Kimaki data (its sessions and their threads). Stored files are hard links
// when the backup is on the same disk: no extra space. A manifest records
// what was there, and restore checks the copy against it.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HubPaths } from './config.ts'

// Never part of a backup: older backups, logs, pid files, SQLite's side files (the databases
// are copied by SQLite itself), and Kimaki's lock files (they belong to a running process).
const SKIP = /^(backups|.*\.log|.*\.pid|.*\.db-(wal|shm|journal)|lock-port|lock-token)$/
const DATABASES = ['hub.db', 'twin.db']
// The hub's own Kimaki and the admin agent's: their databases go through SQLite as well.
const KIMAKI_DIRS = ['kimaki-data', 'admin-kimaki']
const KIMAKI_DATABASES = ['kimaki.db', 'discord-sessions.db']
// Files that are never changed once written: linked instead of copied.
const LINKED = new Set(['attachments', 'media', 'apps'])
const BIG = 1024 * 1024

export type Manifest = {
  format: 1
  created: string
  host: string
  ca_fingerprint: string | null
  counts: { messages: number; channels: number; guilds: number; attachments: number; devices: number; bots: number; people: number; kimaki_sessions: number }
  files: number
}

async function counts(root: string): Promise<Manifest['counts']> {
  const { openSqlite } = await import('./sqlite.ts')
  const one = async (file: string, sql: string) => {
    if (!fs.existsSync(file)) return 0
    const db = openSqlite(`file:${file}`)
    try {
      return Number((await db.execute(sql)).rows[0]?.['n'] ?? 0)
    } catch {
      return 0
    } finally {
      db.close()
    }
  }
  const twin = path.join(root, 'twin.db')
  const hub = path.join(root, 'hub.db')
  let sessions = 0
  const kimaki = path.join(root, 'kimaki-data', 'kimaki.db')
  if (fs.existsSync(kimaki)) {
    const { createClient } = await import('@libsql/client')
    const db = createClient({ url: `file:${kimaki}` })
    sessions = await db.execute('SELECT count(*) AS n FROM thread_sessions').then((r) => Number(r.rows[0]?.['n'] ?? 0), () => 0)
    db.close()
  }
  return {
    messages: await one(twin, 'SELECT count(*) AS n FROM Message'),
    channels: await one(twin, 'SELECT count(*) AS n FROM Channel'),
    guilds: await one(twin, 'SELECT count(*) AS n FROM Guild'),
    attachments: await one(hub, 'SELECT count(*) AS n FROM attachments'),
    devices: await one(hub, 'SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL'),
    bots: await one(hub, 'SELECT count(*) AS n FROM bots WHERE revoked_at IS NULL'),
    people: await one(twin, 'SELECT count(*) AS n FROM User WHERE bot = 0'),
    kimaki_sessions: sessions,
  }
}

function fingerprintOf(root: string) {
  const file = path.join(root, 'ca', 'ca.crt')
  return fs.existsSync(file) ? new crypto.X509Certificate(fs.readFileSync(file)).fingerprint256 : null
}

// A file into the copy: linked when it never changes (or is big and only ever replaced), else copied.
function place(from: string, to: string, link: boolean) {
  if (link) {
    try {
      fs.linkSync(from, to)
      return
    } catch {
      // Another disk: a real copy.
    }
  }
  fs.copyFileSync(from, to)
}

function copyTree(from: string, to: string, link: (file: string, size: number) => boolean): number {
  let files = 0
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.test(entry.name)) continue
    const a = path.join(from, entry.name)
    const b = path.join(to, entry.name)
    if (entry.isDirectory()) files += copyTree(a, b, link)
    else if (entry.isFile()) {
      place(a, b, link(a, fs.statSync(a).size))
      files++
    }
  }
  return files
}

export async function backup(paths: HubPaths, dir: string, { files = true } = {}) {
  const started = Date.now()
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty. Give a new folder.`)
  if (path.resolve(dir).startsWith(path.resolve(paths.root) + path.sep) && !path.resolve(dir).startsWith(path.join(path.resolve(paths.root), 'backups') + path.sep)) throw new Error('Put the backup outside the hub folder, or in its backups folder.')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { openSqlite } = await import('./sqlite.ts')
  // VACUUM INTO reads one snapshot, so each copy is consistent while the hub writes.
  for (const name of DATABASES) {
    const db = openSqlite(`file:${path.join(paths.root, name)}`)
    try {
      await db.execute({ sql: 'VACUUM INTO ?', args: [path.join(dir, name)] })
    } finally {
      db.close()
    }
  }
  const { createClient } = await import('@libsql/client')
  let count = 0
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    const from = path.join(paths.root, entry.name)
    const to = path.join(dir, entry.name)
    if (SKIP.test(entry.name) || DATABASES.includes(entry.name)) continue
    if (entry.isFile()) {
      fs.copyFileSync(from, to)
      count++
    } else if (!entry.isDirectory()) continue
    else if (LINKED.has(entry.name)) {
      if (files) count += copyTree(from, to, () => true)
    } else if (KIMAKI_DIRS.includes(entry.name)) {
      // Kimaki keeps its database open: SQLite copies it, the rest is copied as files.
      count += copyTree(from, to, () => false)
      for (const name of KIMAKI_DATABASES) {
        const file = path.join(from, name)
        if (!fs.existsSync(file)) continue
        fs.rmSync(path.join(to, name), { force: true })
        const db = createClient({ url: `file:${file}` })
        try {
          await db.execute({ sql: 'VACUUM INTO ?', args: [path.join(to, name)] })
        } finally {
          db.close()
        }
      }
    } else count += copyTree(from, to, (_, size) => size > BIG)
  }
  const manifest: Manifest = { format: 1, created: new Date().toISOString(), host: os.hostname(), ca_fingerprint: fingerprintOf(paths.root), counts: await counts(dir), files: count }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 })
  protect(dir)
  return { dir, manifest, seconds: (Date.now() - started) / 1000 }
}

// Owner only: the folder and everything in it.
function protect(dir: string) {
  if (process.platform === 'win32') return
  const walk = (p: string) => {
    const stat = fs.lstatSync(p)
    if (stat.isDirectory()) {
      fs.chmodSync(p, 0o700)
      for (const entry of fs.readdirSync(p)) walk(path.join(p, entry))
    } else if (stat.isFile() && stat.nlink === 1) fs.chmodSync(p, 0o600)
  }
  walk(dir)
}

// Restores a backup into this machine's hub folder. The folder must be empty, or --replace
// moves what is there aside first. The hub must not be running.
export async function restore(paths: HubPaths, dir: string, { replace = false } = {}) {
  const started = Date.now()
  const source = path.resolve(dir)
  for (const required of ['config.json', 'hub.db', 'twin.db', 'admin-token', 'signing-key']) if (!fs.existsSync(path.join(source, required))) throw new Error(`${source} is not a Vocorum backup (no ${required}).`)
  const manifest = fs.existsSync(path.join(source, 'manifest.json')) ? (JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')) as Manifest) : null
  const root = path.resolve(paths.root)
  const { loadConfig } = await import('./config.ts')
  const current = loadConfig(paths)
  if (current) {
    const answering = await fetch(`http://127.0.0.1:${current.port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)
    if (answering) throw new Error(`A hub is running from ${root}. Stop it first (vocorum uninstall --keep-data stops it and removes its service, or stop the service), then restore.`)
  }
  let movedAside: string | null = null
  if (fs.existsSync(root) && fs.readdirSync(root).length) {
    if (!replace) throw new Error(`${root} is not empty. Restore into an empty folder (set VOCORUM_DIR), or pass --replace to move what is there aside first.`)
    movedAside = `${root}.before-restore-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
    fs.renameSync(root, movedAside)
  }
  // Links when the backup is on this disk (no extra space); copies otherwise.
  const files = copyTree(source, root, (file) => LINKED.has(path.relative(source, file).split(path.sep)[0]!))
  fs.rmSync(path.join(root, 'manifest.json'), { force: true })
  protect(root)
  const now = await counts(root)
  const fingerprint = fingerprintOf(root)
  const problems: string[] = []
  if (manifest) {
    for (const [key, value] of Object.entries(manifest.counts)) if (now[key as keyof Manifest['counts']] !== value) problems.push(`${key}: ${now[key as keyof Manifest['counts']]} restored, ${value} in the backup`)
    if (manifest.ca_fingerprint !== fingerprint) problems.push('the CA differs from the backup\'s')
  }
  const config = loadConfig(paths)!
  return { root, from: source, manifest, counts: now, ca_fingerprint: fingerprint, problems, moved_aside: movedAside, files, address: config.privateListener?.address ?? null, names: config.privateListener?.names ?? [], seconds: (Date.now() - started) / 1000 }
}
