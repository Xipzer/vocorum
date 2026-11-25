// The Vocorum apps, served by the hub itself (no third-party host).
// - `vocorum apps publish <dir>` stores one release: its installers and update
//   bundles with their minisign signatures, as `cargo tauri build` made and
//   signed them. The hub never signs anything; the apps check updates against
//   the publisher key built into them.
// - Signed-in devices ask for updates (Tauri's updater format) and download them.
// - A device holding a valid pairing code can download the first installer
//   from the setup page, with its size and SHA-256 shown.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { HttpError } from './auth.ts'

export type Release = {
  version: string
  notes: string
  pub_date: string
  files: Record<string, { update?: string; install?: string }>
}
type Manifest = Record<string, { size: number; sha256: string }>

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/
// <os>-<arch>, or with a bundle suffix (Tauri's bundle names) when one OS has
// several update formats, e.g. linux-x86_64-appimage next to linux-x86_64-deb.
const PLATFORM = /^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)(?:-(appimage|deb|rpm|nsis|msi|app))?$/
const BUNDLE = /^(appimage|deb|rpm|nsis|msi|app|unknown)$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/

// Semantic version order (pre-releases before their release).
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2)
    return { parts: core.split('.').map(Number), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.parts[i] ?? 0) !== (y.parts[i] ?? 0)) return (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}

function readRelease(file: string): Release {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Release>
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) throw new Error('release.json: version must look like 1.2.3')
  if (!raw.files || typeof raw.files !== 'object') throw new Error('release.json: files is required')
  for (const [platform, entry] of Object.entries(raw.files)) {
    if (!PLATFORM.test(platform)) throw new Error(`release.json: unknown platform ${platform} (e.g. windows-x86_64, darwin-aarch64, linux-x86_64, linux-x86_64-deb)`)
    for (const name of [entry?.update, entry?.install]) if (name !== undefined && (typeof name !== 'string' || !FILE.test(name))) throw new Error(`release.json: bad file name ${String(name)}`)
  }
  return { version: raw.version, notes: typeof raw.notes === 'string' ? raw.notes : '', pub_date: typeof raw.pub_date === 'string' ? raw.pub_date : new Date().toISOString(), files: raw.files as Release['files'] }
}

export class AppReleases {
  constructor(private readonly dir: string) {}

  // --- publishing (CLI)

  publish(source: string) {
    const release = readRelease(path.join(source, 'release.json'))
    const target = path.join(this.dir, release.version)
    if (fs.existsSync(target)) throw new Error(`Version ${release.version} is already published. Remove it first: vocorum apps remove ${release.version}`)
    const names = new Set<string>()
    for (const entry of Object.values(release.files)) {
      if (entry.update) {
        names.add(entry.update)
        // Updates must come with their signature; the hub never makes one.
        if (!fs.existsSync(path.join(source, `${entry.update}.sig`))) throw new Error(`${entry.update}.sig is missing: build with updater artifacts on`)
        names.add(`${entry.update}.sig`)
      }
      if (entry.install) names.add(entry.install)
    }
    for (const name of names) if (!fs.statSync(path.join(source, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`${name} is listed in release.json but missing`)
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const staging = fs.mkdtempSync(path.join(this.dir, '.publish-'))
    const manifest: Manifest = {}
    for (const name of names) {
      fs.copyFileSync(path.join(source, name), path.join(staging, name))
      const data = fs.readFileSync(path.join(staging, name))
      manifest[name] = { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
    }
    fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify(release, null, 1))
    fs.writeFileSync(path.join(staging, 'files.json'), JSON.stringify(manifest, null, 1))
    fs.chmodSync(staging, 0o700)
    fs.renameSync(staging, target)
    return { version: release.version, files: Object.keys(manifest).length }
  }

  remove(version: string) {
    if (!VERSION.test(version)) throw new Error('Not a version')
    const target = path.join(this.dir, version)
    if (!fs.existsSync(target)) return false
    fs.rmSync(target, { recursive: true, force: true })
    return true
  }

  list(): Release[] {
    if (!fs.existsSync(this.dir)) return []
    return fs
      .readdirSync(this.dir)
      .filter((v) => VERSION.test(v) && fs.existsSync(path.join(this.dir, v, 'files.json')))
      .map((v) => readRelease(path.join(this.dir, v, 'release.json')))
      .sort((a, b) => compareVersions(b.version, a.version))
  }

  private manifest(version: string): Manifest {
    return JSON.parse(fs.readFileSync(path.join(this.dir, version, 'files.json'), 'utf8')) as Manifest
  }

  // --- updates (signed-in devices)

  // Tauri's updater answer, or null when the device is up to date. An app that
  // says its bundle gets that kind (<os>-<arch>-<bundle>) or else the plain
  // <os>-<arch> one; an app that does not (older apps) gets the plain one only.
  update(target: string, arch: string, current: string, origin: string, bundle?: string | null) {
    const platform = `${target}-${arch}`
    if (!PLATFORM.test(platform) || platform.split('-').length !== 2) throw new HttpError(400, 'Unknown target or arch')
    if (bundle != null && !BUNDLE.test(bundle)) throw new HttpError(400, 'Unknown bundle')
    const keys = bundle ? [`${platform}-${bundle}`, platform] : [platform]
    const pick = (r: Release) => keys.map((k) => r.files[k]?.update).find(Boolean)
    const latest = this.list().find(pick)
    if (!latest || (VERSION.test(current) && compareVersions(latest.version, current) <= 0)) return null
    const file = pick(latest)!
    return {
      version: latest.version,
      notes: latest.notes,
      pub_date: latest.pub_date,
      url: `${origin}/client/app/files/${latest.version}/${encodeURIComponent(file)}`,
      signature: fs.readFileSync(path.join(this.dir, latest.version, `${file}.sig`), 'utf8').trim(),
    }
  }

  // A file of a published release: only those its release.json lists (and update signatures).
  file(version: string, name: string): { path: string; size: number; sha256: string } | null {
    if (!VERSION.test(version) || !FILE.test(name) || !fs.existsSync(path.join(this.dir, version, 'files.json'))) return null
    const entry = this.manifest(version)[name]
    return entry ? { path: path.join(this.dir, version, name), ...entry } : null
  }

  // --- first install (pairing code holders)

  // The newest installer per platform, with size and SHA-256.
  installers(): Array<{ platform: string; version: string; file: string; size: number; sha256: string }> {
    const out = new Map<string, { platform: string; version: string; file: string; size: number; sha256: string }>()
    for (const release of this.list()) {
      for (const [platform, entry] of Object.entries(release.files)) {
        if (!entry.install || out.has(platform) || [...out.values()].some((i) => i.version === release.version && i.file === entry.install)) continue
        const info = this.file(release.version, entry.install)
        if (info) out.set(platform, { platform, version: release.version, file: entry.install, size: info.size, sha256: info.sha256 })
      }
    }
    return [...out.values()].sort((a, b) => a.platform.localeCompare(b.platform))
  }

  installerFile(name: string) {
    const found = this.installers().find((i) => i.file === name)
    return found ? this.file(found.version, found.file) : null
  }
}

// Streams a file with Range support, as a download.
export function sendDownload(req: http.IncomingMessage, res: http.ServerResponse, file: { path: string; size: number }, name: string) {
  const headers = { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : file.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : file.size - 1
    start = Math.max(0, start)
    end = Math.min(end, file.size - 1)
    if (start > end || start >= file.size) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${file.size}` }).end()
      return
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${file.size}`, 'content-length': String(end - start + 1) })
    if (req.method === 'HEAD') return void res.end()
    fs.createReadStream(file.path, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(file.size) })
  if (req.method === 'HEAD') return void res.end()
  fs.createReadStream(file.path).pipe(res)
}
