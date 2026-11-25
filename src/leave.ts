// Leaving: `vocorum export` writes everything you can read into plain files
// any program opens, and `vocorum uninstall` takes the hub off this machine.
//
// The export holds every server's channels and threads and your own direct
// messages (never other people's), each as Markdown to read and JSON Lines to
// process, every stored file under its own name, and who is who. It needs
// nothing from Vocorum to read.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HubConfig, HubPaths } from './config.ts'

type Row = Record<string, unknown>
const THREADS = new Set([10, 11, 12])
const safe = (name: string) => (name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 80) || 'unnamed')

export async function exportHub(config: HubConfig, paths: HubPaths, dir: string) {
  const started = Date.now()
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty. Give a new folder.`)
  if (path.resolve(dir).startsWith(path.resolve(paths.root) + path.sep)) throw new Error('Put the export outside the hub folder: uninstall may delete that folder.')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { openSqlite } = await import('./sqlite.ts')
  const twin = openSqlite(paths.twinDb)
  const hub = openSqlite(paths.hubDb)
  try {
    const rows = async (db: typeof twin, sql: string, args: Array<string | number> = []) => (await db.execute({ sql, args })).rows as Row[]
    const users = new Map((await rows(twin, 'SELECT id, username, globalName, bot FROM User')).map((u) => [String(u['id']), u]))
    const name = (id: string) => {
      const u = users.get(id)
      return u ? String(u['globalName'] ?? u['username']) : id
    }
    const files = new Map((await rows(hub, 'SELECT id, filename FROM attachments')).map((a) => [String(a['id']), String(a['filename'])]))
    const dms = (await rows(hub, 'SELECT channel_id, user_a, user_b, machine FROM dm_channels WHERE user_a = ? OR user_b = ?', [config.ownerUserId, config.ownerUserId]).catch(() => [])) as Row[]
    const guilds = await rows(twin, 'SELECT id, name FROM Guild ORDER BY createdAt')
    const channels = await rows(twin, 'SELECT id, guildId, type, name, parentId, position FROM Channel ORDER BY position, id')
    const byId = new Map(channels.map((c) => [String(c['id']), c]))
    let messages = 0
    let copied = 0
    const written = { channels: 0, threads: 0 }
    const missing: string[] = []

    const write = async (folder: string, channel: Row, title: string) => {
      const list = await rows(twin, 'SELECT id, authorId, content, timestamp, editedTimestamp, attachments, embeds, messageReference, pinned FROM Message WHERE channelId = ? ORDER BY length(id), id', [String(channel['id'])])
      if (!list.length) return
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
      const base = path.join(folder, safe(String(channel['name'] ?? channel['id'])))
      const md: string[] = [`# ${title}`, '']
      const jsonl: string[] = []
      let day = ''
      for (const m of list) {
        const id = String(m['id'])
        const at = String(m['timestamp'] ?? '')
        const author = String(m['authorId'])
        const content = String(m['content'] ?? '').replace(/<@!?(\d+)>/g, (_, u: string) => `@${name(u)}`)
        const attached: Array<{ id: string; filename: string; path: string | null }> = []
        for (const a of JSON.parse(String(m['attachments'] ?? '[]')) as Array<{ id: string; filename: string; missing?: boolean }>) {
          const stored = files.get(a.id)
          const from = stored ? path.join(paths.root, 'attachments', a.id, stored) : null
          if (from && fs.existsSync(from)) {
            const to = path.join(dir, 'files', id, safe(a.filename))
            fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
            try {
              fs.linkSync(from, to)
            } catch {
              fs.copyFileSync(from, to)
            }
            copied++
            attached.push({ id: a.id, filename: a.filename, path: path.relative(dir, to) })
          } else {
            missing.push(`${a.filename} (message ${id})`)
            attached.push({ id: a.id, filename: a.filename, path: null })
          }
        }
        if (at.slice(0, 10) !== day) {
          day = at.slice(0, 10)
          md.push(`## ${day}`, '')
        }
        md.push(`**${name(author)}** ${at.slice(11, 16)}${m['editedTimestamp'] ? ' (edited)' : ''}${Number(m['pinned']) ? ' (pinned)' : ''}`)
        if (content) md.push(content)
        for (const a of attached) md.push(a.path ? `[${a.filename}](${path.relative(folder, path.join(dir, a.path)).split(path.sep).join('/')})` : `${a.filename} (not stored on the hub)`)
        md.push('')
        jsonl.push(JSON.stringify({ id, channel_id: String(channel['id']), author: { id: author, name: name(author) }, timestamp: at, edited_timestamp: m['editedTimestamp'] ?? null, content: String(m['content'] ?? ''), attachments: attached, embeds: JSON.parse(String(m['embeds'] ?? '[]')), reply_to: m['messageReference'] ? (JSON.parse(String(m['messageReference'])) as { message_id?: string }).message_id ?? null : null, pinned: Boolean(Number(m['pinned'])) }))
        messages++
      }
      fs.writeFileSync(`${base}.md`, `${md.join('\n')}\n`, { mode: 0o600 })
      fs.writeFileSync(`${base}.jsonl`, `${jsonl.join('\n')}\n`, { mode: 0o600 })
      if (THREADS.has(Number(channel['type']))) written.threads++
      else if (Number(channel['type']) !== 1) written.channels++
    }

    for (const g of guilds) {
      const root = path.join(dir, 'servers', safe(String(g['name'])))
      for (const c of channels.filter((c) => c['guildId'] === g['id'] && !THREADS.has(Number(c['type'])) && Number(c['type']) !== 4)) {
        const category = c['parentId'] ? byId.get(String(c['parentId'])) : null
        const folder = category ? path.join(root, safe(String(category['name']))) : root
        await write(folder, c, `#${c['name']} in ${g['name']}`)
        for (const t of channels.filter((t) => THREADS.has(Number(t['type'])) && t['parentId'] === c['id'])) await write(path.join(folder, `${safe(String(c['name']))} threads`), t, `${t['name']} (a thread in #${c['name']})`)
      }
    }
    for (const dm of dms) {
      const other = String(dm['user_a']) === config.ownerUserId ? String(dm['user_b']) : String(dm['user_a'])
      const channel = byId.get(String(dm['channel_id']))
      if (channel) await write(path.join(dir, 'direct messages'), { ...channel, name: dm['machine'] ? `${name(other)} on ${dm['machine']}` : name(other) }, `Direct messages with ${name(other)}`)
    }
    const people = [...users.values()].map((u) => ({ id: String(u['id']), username: String(u['username']), name: u['globalName'] ?? null, bot: Boolean(Number(u['bot'])) }))
    fs.writeFileSync(path.join(dir, 'people.json'), `${JSON.stringify(people, null, 1)}\n`, { mode: 0o600 })
    fs.writeFileSync(
      path.join(dir, 'README.txt'),
      [
        `Exported from a Vocorum hub on ${new Date().toISOString().slice(0, 10)}.`,
        '',
        'servers/<server>/<category>/<channel>.md      to read: one file per channel, oldest first (no category folder when it has none)',
        'servers/<server>/.../<channel>.jsonl          to process: one message per line (JSON)',
        'servers/<server>/.../<channel> threads/       the channel\'s threads, the same way',
        'direct messages/                              your own direct messages',
        'files/<message id>/<file name>                every stored file, linked from the messages',
        'people.json                                   who each id is',
        '',
        'Other people\'s direct messages are not included.',
        ...(missing.length ? ['', `${missing.length} files were never stored on the hub (they stayed on Discord or were lost there):`, ...missing.slice(0, 200).map((m) => `  ${m}`)] : []),
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    return { dir, messages, files: copied, files_missing: missing.length, servers: guilds.length, channels: written.channels, threads: written.threads, direct_messages: dms.length, seconds: (Date.now() - started) / 1000 }
  } finally {
    twin.close()
    hub.close()
  }
}

// What uninstall removes, in order. Data only with deleteData.
export async function uninstall(config: HubConfig | null, paths: HubPaths, { execute, deleteData, repo }: { execute: boolean; deleteData: boolean; repo: string }) {
  const { serviceName, backgroundPid } = await import('./setup.ts')
  const { launchdFile, launchdLabel, taskName, taskState, removeTask, WINDOWS } = await import('./platform.ts')
  const { adminPaths } = await import('./admin.ts')
  const { execFile } = await import('node:child_process')
  const run = (cmd: string, args: string[]) => new Promise<void>((resolve) => execFile(cmd, args, { windowsHide: true }, () => resolve()))
  const hubUnit = serviceName(paths)
  const units = [hubUnit, hubUnit === 'vocorum' ? 'kimaki-hub' : `kimaki-${hubUnit}`, `kimaki-${hubUnit}-admin`.replace('kimaki-vocorum-admin', 'kimaki-admin')]
  const steps: Array<{ step: string; detail: string; done: boolean }> = []
  const step = async (s: string, detail: string, action: () => Promise<void> | void) => {
    if (execute) await action()
    steps.push({ step: s, detail, done: execute })
  }
  // Services: the agents first, then the hub.
  for (const unit of [...units].reverse()) {
    if (process.platform === 'linux') {
      const file = path.join(os.homedir(), `.config/systemd/user/${unit}.service`)
      if (fs.existsSync(file)) await step('service', `stop and remove ${file}`, async () => {
        await run('systemctl', ['--user', 'disable', '--now', unit])
        fs.rmSync(file)
        await run('systemctl', ['--user', 'daemon-reload'])
      })
    } else if (process.platform === 'darwin') {
      const file = launchdFile(unit)
      if (fs.existsSync(file)) await step('service', `stop and remove ${file}`, async () => {
        await run('launchctl', ['bootout', `gui/${process.getuid?.()}/${launchdLabel(unit)}`])
        fs.rmSync(file)
      })
    } else if (WINDOWS && (await taskState(unit)) !== null) await step('service', `stop and remove the scheduled task ${taskName(unit)}`, async () => {
      await run('schtasks', ['/End', '/TN', taskName(unit)])
      await removeTask(unit)
    })
  }
  // Processes started without a service.
  const pids: Array<[string, number | null]> = [['hub', backgroundPid(paths)], ['admin agent', readPid(adminPaths(paths).pid)]]
  for (const [what, pid] of pids) if (pid) await step('process', `stop the ${what} (pid ${pid})`, () => {
    try {
      process.kill(pid)
    } catch {}
  })
  if (WINDOWS && config) {
    const { pidOnPort } = await import('./platform.ts')
    const pid = await pidOnPort(config.port)
    if (pid) await step('process', `stop the hub (pid ${pid})`, () => run('taskkill', ['/PID', String(pid), '/T', '/F']))
  }
  // The vocorum command, when it is the one setup made for this checkout.
  // The command only ever belongs to the usual hub (~/.vocorum).
  const usual = path.resolve(paths.root) === path.join(os.homedir(), '.vocorum')
  const link = path.join(os.homedir(), '.local/bin/vocorum')
  const shim = path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WindowsApps', 'vocorum.cmd')
  if (usual && fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === path.join(repo, 'bin/vocorum.js')) await step('command', `remove ${link}`, () => fs.rmSync(link))
  if (usual && WINDOWS && fs.existsSync(shim) && fs.readFileSync(shim, 'utf8').includes(repo)) await step('command', `remove ${shim}`, () => fs.rmSync(shim))
  if (deleteData && fs.existsSync(paths.root)) await step('data', `delete ${paths.root} (messages, files, keys, backups in it)`, () => fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 10 }))
  else if (fs.existsSync(paths.root)) steps.push({ step: 'data', detail: `kept: ${paths.root} (delete it with --delete-data, or by hand)`, done: false })
  return {
    steps,
    by_hand: [
      `Your devices: remove the hub's certificate (iPhone and iPad: Settings, General, VPN & Device Management; Mac: Keychain Access, System; Android: Settings, Security, Encryption & credentials, User credentials; Windows: certmgr.msc, Trusted Root Certification Authorities) and its passkey (in your password manager, under ${config?.privateListener?.names[0] ?? 'the hub name'}). Uninstall the Vocorum app where you installed it.`,
      'Tailscale: revoke any machine shares you made for friends.',
      `This code: delete ${repo} when you no longer need it.`,
      'Kimaki on Discord keeps its own data in ~/.kimaki; it is not part of the hub.',
    ],
  }
}

function readPid(file: string): number | null {
  if (!fs.existsSync(file)) return null
  const pid = Number(fs.readFileSync(file, 'utf8'))
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}
