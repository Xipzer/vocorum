// Linux: the app under tauri-driver and WebKitWebDriver (WebDriver), in its own
// D-Bus session so a monitor sees every notification it sends. Updates run the
// AppImage itself, without a driver.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppRun, Launch } from './types.ts'

const MEASURE = path.resolve(import.meta.dirname, '../../apps/desktop/scripts/measure.mjs')
// A command put in front of every app run (a sandbox overlay, say): space separated.
const wrap = (process.env['VOCORUM_E2E_WRAP'] ?? '').split(' ').filter(Boolean)
const display = { DISPLAY: process.env['DISPLAY'] || ':0', WAYLAND_DISPLAY: process.env['WAYLAND_DISPLAY'] || 'wayland-0', XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] || '/mnt/wslg/runtime-dir' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function findPid(dataDir: string): number | null {
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'vocorum-app') continue
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`VOCORUM_DATA_DIR=${dataDir}`)) return Number(pid)
    } catch {}
  }
  return null
}

function measure(pid: number, seconds: number) {
  const out = execFileSync('node', [MEASURE, '--pid', String(pid), '--seconds', String(seconds)], { encoding: 'utf8' })
  const json = JSON.parse(out.slice(out.indexOf('{')))
  return { memoryMB: json.memoryMB as number, cpuPercent: json.cpuPercent as number }
}

export async function launchLinux({ app, link, env = {} }: Launch): Promise<AppRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-e2e-'))
  const dataDir = path.join(dir, 'profile')
  const monitor = path.join(dir, 'notifications.log')
  const port = 4444 + Math.floor(Math.random() * 1000)
  const driver = process.env['VOCORUM_E2E_WEBDRIVER'] ?? 'WebKitWebDriver'
  const script = `dbus-monitor --session "interface='org.freedesktop.Notifications'" > '${monitor}' 2>&1 & exec tauri-driver --port ${port} --native-port ${port + 1} --native-driver '${driver}'`
  const child: ChildProcess = spawn(wrap[0] ?? 'dbus-run-session', [...wrap.slice(1), ...(wrap.length ? ['dbus-run-session'] : []), '--', 'sh', '-c', script], {
    env: { ...process.env, ...display, VOCORUM_DATA_DIR: dataDir, VOCORUM_NO_APPROVAL_KEY: '1', APPIMAGE_EXTRACT_AND_RUN: '1', ...env },
    stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'driver.log'), 'w')],
  })
  const base = `http://127.0.0.1:${port}`
  let session: string | null = null
  for (let i = 0; i < 50 && !session; i++) {
    await sleep(200)
    const r = await fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capabilities: { alwaysMatch: { 'tauri:options': { application: app, args: ['--pair', link] } } } }) }).catch(() => null)
    if (r?.ok) session = ((await r.json()) as { value: { sessionId: string } }).value.sessionId
  }
  if (!session) throw new Error(`tauri-driver did not start the app (see ${dir}/driver.log)`)
  return {
    dir,
    async eval<T>(expression: string): Promise<T> {
      const script = `const done = arguments[arguments.length - 1]; Promise.resolve().then(async () => (${expression})).then((v) => done({ v }), (e) => done({ e: String(e) }))`
      const r = await fetch(`${base}/session/${session}/execute/async`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script, args: [] }) })
      const body = (await r.json()) as { value: { v?: T; e?: string; message?: string } }
      if (!r.ok || body.value.e || body.value.message) throw new Error(body.value.e ?? body.value.message ?? `WebDriver ${r.status}`)
      return body.value.v as T
    },
    async measure(seconds: number) {
      const pid = findPid(dataDir)
      if (!pid) throw new Error('the app process is gone')
      return measure(pid, seconds)
    },
    async notified(text: string) {
      return fs.existsSync(monitor) && fs.readFileSync(monitor, 'utf8').includes(text)
    },
    async stop() {
      await fetch(`${base}/session/${session}`, { method: 'DELETE' }).catch(() => {})
      child.kill()
      const pid = findPid(dataDir)
      if (pid) process.kill(pid)
      await sleep(500)
    },
  }
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// Runs an older AppImage paired to the hub and waits until it has replaced itself with `to`.
export async function updateLinux({ from, to, link, timeoutMs = 300_000 }: { from: string; to: string; link: string; timeoutMs?: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-e2e-update-'))
  const dataDir = path.join(dir, 'profile')
  const file = path.join(dir, 'Vocorum.AppImage')
  fs.copyFileSync(from, file)
  fs.chmodSync(file, 0o755)
  // Releases before 0.2.4 ignore VOCORUM_DATA_DIR: keep the person's own profile aside meanwhile.
  const profiles = [path.join(os.homedir(), '.config/dev.xipz.vocorum'), path.join(os.homedir(), '.local/share/dev.xipz.vocorum')]
  const aside = profiles.filter((p) => fs.existsSync(p)).map((p) => (fs.renameSync(p, `${p}.e2e-aside`), p))
  const child = spawn(file, ['--hidden', '--pair', link], {
    env: { ...process.env, ...display, VOCORUM_DATA_DIR: dataDir, VOCORUM_NO_APPROVAL_KEY: '1', VOCORUM_UPDATE_AUTO: '1', APPIMAGE_EXTRACT_AND_RUN: '1' },
    stdio: ['ignore', 'ignore', fs.openSync(path.join(os.tmpdir(), 'vocorum-e2e-update.log'), 'w')],
    detached: true,
  })
  child.unref()
  const want = sha256(to)
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      await sleep(3000)
      if (sha256(file) === want) {
        // The updated app starts again on its own.
        for (let i = 0; i < 20 && !(findPid(dataDir) ?? appImagePid(file)); i++) await sleep(1000)
        return { replaced: true, running: Boolean(findPid(dataDir) ?? appImagePid(file)) }
      }
    }
    return { replaced: false, running: Boolean(findPid(dataDir) ?? appImagePid(file)) }
  } finally {
    const pid = findPid(dataDir) ?? appImagePid(file)
    if (pid) process.kill(pid)
    await sleep(1000)
    for (const p of profiles) fs.rmSync(p, { recursive: true, force: true })
    for (const p of aside) fs.renameSync(`${p}.e2e-aside`, p)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// An app started from this AppImage (old releases do not carry VOCORUM_DATA_DIR).
function appImagePid(file: string): number | null {
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'vocorum-app') continue
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`APPIMAGE=${file}`)) return Number(pid)
    } catch {}
  }
  return null
}
