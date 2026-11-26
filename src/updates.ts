// Hub updates: seeing that a newer version is published, and installing it.
//
// A hub is a git checkout. Its updates come from the place it was cloned from
// (the checkout's own remote and branch), so a mirror or a fork keeps updating
// from its own source. Every published commit is a release: its title and its
// "- " lines are the change log people read.
//
// Checking asks the remote for one commit id. Only when that differs is the
// new history fetched. Installing takes a backup, fast-forwards, installs the
// packages, builds, restarts the hub and waits for it to answer; if any of
// that fails the previous version is put back and started again.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { HttpError } from './auth.ts'
import { initHub, loadConfig, type HubPaths } from './config.ts'
import { readJson } from './http.ts'
import type { Hub } from './hub.ts'

export type Release = { commit: string; date: string; title: string; notes: string[] }
export type Run = { from: string; to: string; started_at: number; finished_at: number | null; status: 'running' | 'done' | 'failed'; step: string; error: string | null }
export type UpdateMode = 'off' | 'notify' | 'auto'
export type Checked =
  | { supported: false; reason: string }
  | { supported: true; current: Release; source: string; checked_at: number; target: string | null; available: Release[]; blocked: string | null }

const stateFile = (paths: HubPaths) => path.join(paths.root, 'update.json')
type Saved = { checked?: Checked; run?: Run }
const load = (paths: HubPaths): Saved => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(paths), 'utf8')) as Saved
  } catch {
    return {}
  }
}
const save = (paths: HubPaths, change: Saved) => {
  const next = { ...load(paths), ...change }
  fs.writeFileSync(`${stateFile(paths)}.tmp`, `${JSON.stringify(next, null, 1)}\n`, { mode: 0o600 })
  fs.renameSync(`${stateFile(paths)}.tmp`, stateFile(paths))
}

// A failed command's whole output, for the update log.
export class CommandError extends Error {
  constructor(message: string, readonly output: string) {
    super(message)
  }
}

function run(cmd: string, args: string[], cwd: string, timeout = 600_000, searchPath = process.env['PATH'] ?? ''): Promise<string> {
  // git must never stop to ask for a password: a hub nobody is watching would hang. node's own
  // folder goes on the PATH so package scripts find pnpm from a service's bare environment.
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${searchPath}`, GIT_TERMINAL_PROMPT: '0', CI: '1' }, shell: process.platform === 'win32' && cmd !== 'git' }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      const what = `${path.basename(cmd).replace(/\.cmd$/, '')} ${args.find((a) => !a.startsWith('-')) ?? ''}`.trim()
      const said = (stderr || '').trim().split('\n').filter(Boolean)
      reject(new CommandError(`${what} failed${(error as NodeJS.ErrnoException).code === 'ENOENT' ? ': not found (ENOENT)' : said.length === 1 ? `: ${said[0]}` : ''}`, `$ ${cmd} ${args.join(' ')}\n${stdout}\n${stderr}`))
    }),
  )
}
const git = (repo: string, args: string[], timeout = 60_000) => run('git', args, repo, timeout).then((out) => out.trim())

const FORMAT = '%H%x1f%cI%x1f%s%x1f%b%x1e'
function releases(log: string): Release[] {
  return log.split('\x1e').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [commit = '', date = '', title = '', body = ''] = entry.split('\x1f')
    return { commit, date, title, notes: body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2)) }
  })
}

// Where this checkout updates from, or why it cannot.
async function source(repo: string): Promise<{ remote: string; branch: string } | string> {
  if (!fs.existsSync(path.join(repo, '.git'))) return 'This hub was not installed with git, so it cannot update itself. Update it the way it was installed.'
  const branch = await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')
  if (!branch) return 'This checkout is not on a branch. Check out the branch you installed (usually main) to get updates.'
  const upstream = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')
  if (upstream.includes('/')) return { remote: upstream.slice(0, upstream.indexOf('/')), branch: upstream.slice(upstream.indexOf('/') + 1) }
  const remotes = (await git(repo, ['remote']).catch(() => '')).split('\n').filter(Boolean)
  if (remotes.includes('origin')) return { remote: 'origin', branch }
  return 'This checkout has no remote to update from. It is updated by hand.'
}

// Asks the remote what is newest. Reads only; nothing in the checkout changes.
export async function check(paths: HubPaths, repo: string): Promise<Checked> {
  const from = await source(repo)
  const done = (checked: Checked) => {
    save(paths, { checked })
    return checked
  }
  if (typeof from === 'string') return done({ supported: false, reason: from })
  const [current] = releases(await git(repo, ['log', '-1', `--format=${FORMAT}`]))
  if (!current) return done({ supported: false, reason: 'This checkout has no commits.' })
  const base = { supported: true as const, current, source: `${from.remote}/${from.branch}`, checked_at: Date.now() }
  const ancestor = (a: string, b: string) => git(repo, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false)
  // A checkout with commits of its own is someone's fork: they update it by hand and are not
  // nagged. Known from what was last fetched, so such a hub never contacts its remote at all.
  const own: Checked = { supported: false, reason: 'This checkout has commits of its own, so it is updated by hand with git.' }
  const tracking = `refs/remotes/${from.remote}/${from.branch}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', tracking]).then(() => true, () => false)) && !(await ancestor('HEAD', tracking))) return done(own)
  const listed = await git(repo, ['ls-remote', from.remote, `refs/heads/${from.branch}`], 30_000)
  const target = listed.split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{40,64}$/.test(target)) throw new Error(`${from.remote} has no branch ${from.branch}`)
  if (target === current.commit) return done({ ...base, target: null, available: [], blocked: null })
  if (!(await git(repo, ['cat-file', '-e', `${target}^{commit}`]).then(() => true, () => false))) await git(repo, ['fetch', '--quiet', '--no-tags', from.remote, from.branch], 300_000)
  // The remote is behind this checkout: nothing to install.
  if (await ancestor(target, 'HEAD')) return done({ ...base, target: null, available: [], blocked: null })
  const available = releases(await git(repo, ['log', `--format=${FORMAT}`, `HEAD..${target}`]))
  if (!(await ancestor('HEAD', target))) return done(own)
  const changed = (await git(repo, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean).map((l) => l.trim().replace(/^\S+\s+/, ''))
  const blocked = changed.length ? `Files in this checkout were changed by hand (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}). Undo those changes, or update by hand with git.` : null
  return done({ ...base, target, available, blocked })
}

// pnpm for a hub whose service has a bare PATH: the one on the PATH, the one beside node, or
// corepack's. Package scripts call pnpm again by name, so the one that works gets a small
// launcher of that name inside node_modules, first on the PATH for everything that is run.
async function pnpmPath(repo: string): Promise<string> {
  const node = path.dirname(process.execPath)
  const win = process.platform === 'win32'
  const tries: Array<[string, string[]]> = [['pnpm', []], [path.join(node, win ? 'pnpm.cmd' : 'pnpm'), []], [path.join(node, win ? 'corepack.cmd' : 'corepack'), ['pnpm']]]
  for (const [cmd, prefix] of tries) {
    if (!(await run(cmd, [...prefix, '--version'], repo, 120_000).then(() => true, () => false))) continue
    if (cmd === 'pnpm') return process.env['PATH'] ?? ''
    const dir = path.join(repo, 'node_modules', '.cache', 'vocorum-bin')
    fs.mkdirSync(dir, { recursive: true })
    const quoted = [cmd, ...prefix].map((part) => `"${part}"`).join(' ')
    if (win) fs.writeFileSync(path.join(dir, 'pnpm.cmd'), `@${quoted} %*\r\n`)
    else fs.writeFileSync(path.join(dir, 'pnpm'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700 })
    return `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`
  }
  throw new Error('pnpm is not installed where the hub can find it. Run: corepack enable')
}

// The checkout has a commit newer than its build (pulled by hand without building), so the
// hub would run old code. A folder without git, or not built at all, is not "stale".
export async function staleBuild(repo: string): Promise<boolean> {
  if (!fs.existsSync(path.join(repo, '.git'))) return false
  const times = ['dist/hub.mjs', 'web/dist/index.html'].map((f) => fs.statSync(path.join(repo, f), { throwIfNoEntry: false })?.mtimeMs)
  if (times.some((t) => t === undefined)) return false
  const committed = Number(await git(repo, ['log', '-1', '--format=%ct']).catch(() => '0')) * 1000
  return committed > Math.min(...(times as number[]))
}

// Builds the app and the hub bundle (vocorum setup on a fresh clone, and every update).
export async function build(repo: string, { install = true } = {}) {
  const searchPath = await pnpmPath(repo)
  if (install) await run('pnpm', ['install', '--frozen-lockfile'], repo, 900_000, searchPath)
  await run('pnpm', ['build'], repo, 900_000, searchPath)
}

// Installs what check() found. Returns what happened; throws only before anything changed.
export async function apply(paths: HubPaths, repo: string, { log = () => {} }: { log?: (line: string) => void } = {}): Promise<Run | null> {
  const checked = await check(paths, repo)
  if (!checked.supported) throw new Error(checked.reason)
  if (!checked.target || checked.available.length === 0) return null
  if (checked.blocked) throw new Error(checked.blocked)
  const active = load(paths).run
  if (active?.status === 'running' && Date.now() - active.started_at < 30 * 60_000) throw new Error('An update is already running. Follow it with: vocorum update --status')
  const state: Run = { from: checked.current.commit, to: checked.target, started_at: Date.now(), finished_at: null, status: 'running', step: 'backup', error: null }
  const step = (name: string, line: string) => {
    state.step = name
    save(paths, { run: state })
    log(line)
  }
  const { restartHub } = await import('./setup.ts')
  step('backup', 'Backing up the hub')
  const { backup } = await import('./backup.ts')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const kept = path.join(paths.root, 'backups', `pre-update-${stamp}`)
  await backup(paths, kept)
  // Two earlier ones are enough to go back with; each holds a copy of both databases.
  const older = fs.readdirSync(path.join(paths.root, 'backups')).filter((d) => d.startsWith('pre-update-')).sort().slice(0, -3)
  for (const d of older) fs.rmSync(path.join(paths.root, 'backups', d), { recursive: true, force: true })
  try {
    step('download', `Getting ${checked.available.length === 1 ? 'the new version' : `${checked.available.length} new versions`}`)
    await git(repo, ['merge', '--ff-only', '--quiet', checked.target])
    step('build', 'Installing packages and building')
    await build(repo)
    step('restart', 'Restarting the hub')
    await restartHub(paths, repo)
    state.status = 'done'
    state.step = 'done'
  } catch (error) {
    const details = path.join(paths.root, 'update.log')
    fs.appendFileSync(details, `\n${new Date().toISOString()} updating ${state.from.slice(0, 7)} to ${state.to.slice(0, 7)}: ${(error as Error).message}\n${error instanceof CommandError ? error.output : ''}\n`, { mode: 0o600 })
    state.error = `${(error as Error).message}. Details: ${details}`
    log(`That did not work: ${state.error}`)
    step('rollback', 'Putting the previous version back')
    // Safe: check() refused to start with hand-changed files, so only our own merge is undone.
    await git(repo, ['reset', '--hard', '--quiet', state.from]).catch(() => {})
    await build(repo).catch(() => {})
    await restartHub(paths, repo).catch((e: Error) => log(`The previous version did not start either: ${e.message}`))
    state.status = 'failed'
    state.step = 'failed'
  }
  state.finished_at = Date.now()
  save(paths, { run: state })
  if (state.status === 'done') await check(paths, repo).catch(() => {})
  log(state.status === 'done' ? `Updated. A backup from before is in ${kept}` : `The hub is back on the version it had. The backup from before is in ${kept}`)
  return state
}

export const modeOf = (config: { updates?: string | null } | null): UpdateMode => (config?.updates === 'off' || config?.updates === 'auto' ? config.updates : 'notify')

const HOUR = 3_600_000

// Inside the running hub: checks on a timer, tells the owner's devices, and starts an update
// when the owner asks or (in auto mode) when no agent is working.
export class Updates {
  private timer: NodeJS.Timeout | null = null
  private repo = path.resolve(import.meta.dirname, '..')
  private checking: Promise<Checked> | null = null

  constructor(private readonly hub: Hub) {}

  private get paths() {
    return this.hub.options.paths
  }

  get mode(): UpdateMode {
    return modeOf(this.hub.options.config)
  }

  start() {
    // A restart from the app's own update can end the updater before it wrote its last line.
    const last = load(this.paths).run
    if (last?.status === 'running' && last.step === 'restart') void git(this.repo, ['rev-parse', 'HEAD']).then((head) => head === last.to && save(this.paths, { run: { ...last, status: 'done', step: 'done', finished_at: Date.now() } }), () => {})
    // The admin agent's rules and limits belong to the version that runs: an update brings new ones.
    if (this.hub.options.config.adminGuildId) void import('./admin.ts').then(({ writeWorkspace }) => writeWorkspace(this.paths)).catch(() => {})
    if (this.mode === 'off') return
    // Shortly after start, then every six hours. One request each; never keeps the process alive.
    const tick = () => void this.check().catch(() => {})
    this.timer = setTimeout(() => {
      tick()
      this.timer = setInterval(tick, 6 * HOUR).unref()
    }, 60_000).unref()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  summary() {
    const saved = load(this.paths)
    const run = saved.run && saved.run.status === 'running' && Date.now() - saved.run.started_at > 30 * 60_000 ? { ...saved.run, status: 'failed' as const, error: 'The update stopped without finishing.' } : (saved.run ?? null)
    return { mode: this.mode, checked: saved.checked ?? null, run }
  }

  async check(): Promise<Checked> {
    this.checking ??= (async () => {
      const before = load(this.paths).checked
      try {
        const checked = await check(this.paths, this.repo)
        const had = before?.supported ? before.target : null
        if (checked.supported && checked.target && checked.target !== had) this.hub.events.send('HUB_UPDATE', this.summary(), { hubOwner: true })
        // Automatic installs do not retry a version that failed: the owner can, by hand.
        const failed = load(this.paths).run
        if (checked.supported && checked.target && !checked.blocked && this.mode === 'auto' && this.idle() && !(failed?.status === 'failed' && failed.to === checked.target)) await this.begin()
        return checked
      } finally {
        this.checking = null
      }
    })()
    return this.checking
  }

  // Nobody's agent is in the middle of a turn.
  private idle() {
    return this.hub.sessions.list().every((s) => s.state !== 'busy')
  }

  // The update runs as its own process: it has to outlive the hub it restarts.
  private async begin() {
    const active = load(this.paths).run
    if (active?.status === 'running' && Date.now() - active.started_at < 30 * 60_000) return
    const { detach } = await import('./discord/local.ts')
    const { backgroundPid } = await import('./setup.ts')
    // A hub run as a service is restarted by its service manager, so the updater needs a unit of
    // its own to outlive it. A hub run in the background is started again by the updater itself.
    await detach(this.paths, 'update', ['update', '--yes'], { cli: path.join(this.repo, 'bin/vocorum.js'), unit: backgroundPid(this.paths) === null })
  }

  // GET /client/hub/update, POST …/check, POST (install), PUT { mode }. The hub's owner only.
  async handleClient(req: http.IncomingMessage, pathname: string, userId: string): Promise<unknown | undefined> {
    if (!pathname.startsWith('/client/hub/update')) return undefined
    if (!this.hub.access.isHubOwner(userId)) throw new HttpError(403, 'Only the hub owner manages updates')
    const method = req.method ?? 'GET'
    if (pathname === '/client/hub/update' && method === 'GET') return this.summary()
    if (pathname === '/client/hub/update/check' && method === 'POST') {
      await this.check().catch((error: Error) => {
        throw new HttpError(502, `Could not check for updates: ${error.message}`)
      })
      return this.summary()
    }
    if (pathname === '/client/hub/update' && method === 'POST') {
      const checked = load(this.paths).checked
      if (!checked?.supported || !checked.target) throw new HttpError(409, 'There is no update to install')
      if (checked.blocked) throw new HttpError(409, checked.blocked)
      await this.begin()
      return { started: true }
    }
    if (pathname === '/client/hub/update' && method === 'PUT') {
      const mode = (await readJson(req))['mode']
      if (mode !== 'off' && mode !== 'notify' && mode !== 'auto') throw new HttpError(400, 'mode is off, notify or auto')
      // config.json may have been changed by the CLI since start: only this key is written.
      initHub(this.paths, { updates: mode === 'notify' ? null : mode })
      this.hub.options.config.updates = loadConfig(this.paths)?.updates ?? null
      this.stop()
      this.start()
      return this.summary()
    }
    throw new HttpError(404, 'Not found')
  }
}
