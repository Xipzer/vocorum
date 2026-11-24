// CLI commands for getting started, migrating from Discord and checking the
// hub. Every command takes --json, so an agent can drive it and read results.
//
//   setup [--port N] [--address IP] [--name a,b] [--allow CIDR,...] [--no-service] [--dry-run] [--yes]
//   doctor
//   pair <device> [--ttl 30m] [--person <username>]   one link and a QR code for a new device
//   config get [key] | config set <key> <value>
//   discord scan [<guild id>...|all]          read only: what is there and what the bot cannot read
//   discord import <guild id>...|all [--archive DIR] [--no-files] [--detach]
//   discord status
//   discord purge <guild id> [--older-than 7d] [--authors me,bot] [--keep ID,...] [--threads] [--kimaki-keep]
//   discord purge --execute <plan id> [--detach]
//   discord report
//   kimaki setup <machine> [--guild ID|NAME,...] [--kimaki PATH] [--lock-port N] [--peer-data-dir DIR] [--no-service] [-- kimaki args]
//                 a Kimaki on this machine that lives on the hub, beside any Kimaki on Discord
//   request invite <username> [--guild ID|NAME] [--reason TEXT]       changes the owner approves with a passkey
//   request role <username> <role name> [--remove] [--guild ID|NAME]
//   request channel <channel name|id> <username|role name> [--allow view,send,...] [--deny view,...]
//   request raw <METHOD> <route> [json body]
//   requests [list] | requests deny <id> | requests undo <id>      undo files the reversing change as a new request
//   Discord token: --token-file F (mode 0600), or DISCORD_BOT_TOKEN, or --kimaki (this machine's Kimaki bot).

import fs from 'node:fs'
import path from 'node:path'
import { hubPaths, initHub, loadConfig, type HubConfig } from './config.ts'

const paths = hubPaths()
const repo = path.resolve(import.meta.dirname, '..')

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') break
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (BOOLEAN.has(name) || next === undefined || next.startsWith('--')) flags[name] = true
    else {
      flags[name] = next
      i++
    }
  }
  return { flags, positional }
}
const BOOLEAN = new Set(['no-service', 'remove', 'json', 'yes', 'dry-run', 'no-service', 'detach', 'no-files', 'threads', 'kimaki-keep', 'kimaki'])

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined)

export function duration(text: string): number {
  const match = /^(\d+)\s*(m|min|h|d)?$/.exec(text.trim())
  if (!match) throw new Error(`Bad duration "${text}": use 30m, 2h or 7d`)
  const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 'm']!
  return Number(match[1]) * unit
}

function requireConfig(): HubConfig {
  const config = loadConfig(paths)
  if (!config) throw new Error(`No hub at ${paths.root}. Run: vocorum setup`)
  return config
}

// The links a new device opens: the setup page by address (works before any
// trust or DNS exists), and the app with the code in the fragment, which no
// server ever logs.
export function pairingLinks(config: HubConfig, code: string) {
  const l = config.privateListener
  if (!l) return { setup: null, app: `http://localhost:${config.port}/#pair=${code}` }
  const host = l.address.includes(':') ? `[${l.address}]` : l.address
  return { setup: l.httpPort === null ? null : `http://${host}:${l.httpPort}/?code=${code}`, app: `https://${l.names[0]}:${l.port}/#pair=${code}` }
}

const CONFIG_KEYS: Record<string, (value: string) => unknown> = {
  ownerUsername: (v) => v,
  ownerDiscordIds: (v) => {
    const ids = v.split(',').map((s) => s.trim()).filter(Boolean)
    if (!ids.every((id) => /^\d{17,20}$/.test(id))) throw new Error('ownerDiscordIds: Discord user ids, comma separated')
    return ids
  },
  botUsername: (v) => v,
  guildName: (v) => v,
  publicUrl: (v) => (v === 'none' ? null : new URL(v).origin),
  tailscaleLogin: (v) => (v === 'none' ? null : v),
}

async function discordRest(flags: Record<string, string | true>) {
  const { discordToken } = await import('./discord/local.ts')
  const { DiscordRest } = await import('./discord/rest.ts')
  return new DiscordRest(await discordToken({ tokenFile: str(flags['token-file']), kimaki: flags['kimaki'] === true ? true : str(flags['kimaki']) }))
}

export async function onboardCommand(argv: string[]): Promise<boolean> {
  const { flags, positional } = parse(argv)
  const [command, sub, ...rest] = positional
  const json = flags['json'] === true
  const emit = async (value: unknown, text: () => unknown) => (json ? console.log(JSON.stringify(value, null, 1)) : await text())

  if (command === 'setup') {
    const { setup } = await import('./setup.ts')
    const result = await setup(paths, {
      port: str(flags['port']) ? Number(flags['port']) : undefined,
      address: str(flags['address']),
      names: str(flags['name'])?.split(','),
      allow: str(flags['allow'])?.split(','),
      service: flags['no-service'] !== true,
      yes: flags['yes'] === true,
      dryRun: flags['dry-run'] === true,
      json,
      repo,
    })
    const config = loadConfig(paths)
    const links = result.pairing && config ? pairingLinks(config, result.pairing.code) : null
    await emit({ ...result, links }, async () => {
      if (flags['dry-run']) return console.log('\nDry run: nothing changed. Run again without --dry-run.')
      const { printChecks } = await import('./doctor.ts')
      console.log('')
      printChecks(result.checks)
      if (links && result.pairing) await printPairing(links, result.pairing.code, result.pairing.ttlMinutes)
    })
    return true
  }
  if (command === 'doctor') {
    const { doctor, printChecks } = await import('./doctor.ts')
    const checks = await doctor(paths, { repo })
    await emit(checks, () => printChecks(checks))
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1
    return true
  }
  if (command === 'pair') {
    const name = [sub, ...rest].join(' ').trim()
    if (!name) throw new Error('usage: pair <device name> [--ttl 30m]')
    const config = requireConfig()
    const ttlMs = duration(str(flags['ttl']) ?? '30m')
    if (ttlMs > 24 * 3_600_000) throw new Error('A pairing code lives at most 24 hours')
    const { HubStore } = await import('./store.ts')
    const store = new HubStore(`file:${paths.hubDb}`)
    await store.migrate()
    let code: string
    try {
      code = await store.createPairing(name, { ttlMs })
    } finally {
      store.close()
    }
    const links = pairingLinks(config, code)
    await emit({ device: name, code, expires_in_minutes: ttlMs / 60_000, links }, () => printPairing(links, code, ttlMs / 60_000))
    return true
  }
  if (command === 'config') {
    if (sub === 'get' || sub === undefined) {
      const config = requireConfig()
      const key = rest[0]
      const value = key ? (config as Record<string, unknown>)[key] : config
      await emit(value ?? null, () => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)))
      return true
    }
    if (sub === 'set') {
      requireConfig()
      const [key, ...value] = rest
      const parseValue = key ? CONFIG_KEYS[key] : undefined
      if (!key || !parseValue || value.length === 0) throw new Error(`usage: config set <key> <value>. Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`)
      const updated = initHub(paths, { [key]: parseValue(value.join(' ')) } as Partial<HubConfig>)
      await emit({ [key]: (updated as Record<string, unknown>)[key], restart: true }, () => console.log(`${key} set. Restart the hub to apply: systemctl --user restart vocorum`))
      return true
    }
    throw new Error('usage: config get [key] | config set <key> <value>')
  }
  if (command === 'kimaki' && sub === 'setup') {
    const machine = rest[0]
    if (!machine) throw new Error('usage: kimaki setup <machine> [--guild ID|NAME,...] [--kimaki PATH] [--lock-port N] [--peer-data-dir DIR] [--no-service]')
    const config = requireConfig()
    const extra = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : []
    const guildNames = str(flags['guild'])?.split(',') ?? []
    const { HubStore } = await import('./store.ts')
    const store = new HubStore(`file:${paths.hubDb}`)
    await store.migrate()
    const guilds: string[] = []
    try {
      await store.ensureGuild(config.guildId, config.guildName)
      for (const g of guildNames) {
        const found = await store.findGuild(g.trim())
        if (!found) throw new Error(`No server "${g}". See: vocorum guilds list`)
        guilds.push(found.id)
      }
    } finally {
      store.close()
    }
    const { kimakiSetup } = await import('./kimaki-setup.ts')
    const result = await kimakiSetup(config, paths, { machine, guilds, kimaki: str(flags['kimaki']), lockPort: str(flags['lock-port']) ? Number(flags['lock-port']) : undefined, peerDataDir: str(flags['peer-data-dir']), service: flags['no-service'] !== true, extraArgs: extra })
    await emit(result, () => {
      console.log(`Hub bot "${machine}" made. Its token is only in ${result.envFile} (0600).`)
      console.log(result.unit ? `Service: ${result.unit} (started). Log: ${result.log}` : `Start it with:\n  ${result.command}`)
      console.log(`It uses its own data folder (${result.dataDir}) and lock port ${result.lockPort}, so it never answers for a Kimaki on Discord.`)
      console.log('Then, in the hub: run /model in its first channel to pick your usual model (a fresh Kimaki may start on a free one with tight limits).')
    })
    return true
  }
  if (command === 'request' || command === 'requests') {
    await requestCommand(command, sub, rest, flags, json)
    return true
  }
  if (command === 'discord') {
    await discordCommand(sub, rest, flags, json, argv)
    return true
  }
  return false
}

async function printPairing(links: { setup: string | null; app: string }, code: string, minutes: number) {
  const { qrTerminal } = await import('./qr.ts')
  const first = links.setup ?? links.app
  console.log(`\nPair a device (code ${code}, single use, ${minutes} minutes):`)
  console.log(qrTerminal(first))
  console.log(`Scan it with the device's camera, or open: ${first}`)
  if (links.setup) console.log(`The page shows what to install for that device, then opens the app with the code filled in.\nAlready trusted? Open ${links.app} directly.`)
  console.log('A new code any time: vocorum pair <device name>')
}

async function discordCommand(sub: string | undefined, rest: string[], flags: Record<string, string | true>, json: boolean, argv: string[]) {
  const emit = async (value: unknown, text: () => unknown) => (json ? console.log(JSON.stringify(value, null, 1)) : await text())
  const guilds = rest.length === 0 || rest[0] === 'all' ? ('all' as const) : rest
  if (sub === 'scan') {
    const { scan } = await import('./discord/import.ts')
    const result = await scan(await discordRest(flags), guilds)
    await emit(result, () => {
      console.log(`Bot: ${result.bot.name} (${result.bot.id})`)
      if (result.message_content_intent === false) console.log('PROBLEM: the bot has no Message Content intent, so other people\'s text arrives empty. Turn it on: Discord developer portal, your app, Bot, Privileged Gateway Intents, Message Content.')
      for (const g of result.guilds) {
        console.log(`\n${g.name} (${g.id}): ${g.channels} channels in ${g.categories} categories, ${g.threads} threads (${g.thread_messages} messages in threads)`)
        if (g.unreadable.length) console.log(`  the bot cannot read ${g.unreadable.length}: ${g.unreadable.slice(0, 10).join(', ')}${g.unreadable.length > 10 ? ', …' : ''}`)
      }
      console.log(`\nImport takes about ${result.estimate.import_minutes} minutes; deleting it all from Discord later about ${result.estimate.purge_hours} hours.`)
      console.log('Next: vocorum discord import <guild id> (or all) --detach')
    })
    return
  }
  if (sub === 'import') {
    const config = requireConfig()
    if (flags['detach'] === true) {
      if (process.env['DISCORD_BOT_TOKEN'] && !flags['token-file'] && !flags['kimaki']) throw new Error('With --detach, pass the token as --token-file (a file only you can read) or use --kimaki, so it never sits in a service definition.')
      const { detach } = await import('./discord/local.ts')
      console.log(await detach(paths, 'import', argv))
      return
    }
    if (!(config.ownerDiscordIds ?? []).length) console.error('Note: your own Discord user id is not set, so your Discord messages will show under your Discord name, not as you. Set it first with: vocorum config set ownerDiscordIds <your Discord user id> (then restart the hub).')
    const { importDiscord } = await import('./discord/import.ts')
    const report = await importDiscord(await discordRest(flags), config, paths, { guilds, archive: str(flags['archive']), files: flags['no-files'] !== true, log: json ? () => {} : console.log })
    await emit(report, () => {
      const gaps = Object.values(report.guilds).reduce((n, g) => n + Object.keys(g.gaps).length + g.files_failed, 0)
      console.log(gaps ? `\nSome messages or files did not arrive. Run the same command again; it resumes.` : '\nEverything arrived. Report: ~/.vocorum/import/report.json')
      if (report.secrets.length) console.log(`\n${report.secrets.length} secrets appeared in Discord messages. Rotate them (vocorum discord report lists them, masked).`)
    })
    return
  }
  if (sub === 'status') {
    const { readJson } = await import('./discord/local.ts')
    const { statusOf } = await import('./discord/purge.ts')
    const imported = readJson<Record<string, unknown> | null>(path.join(paths.root, 'import', 'report.json'), null)
    const purges = statusOf(paths)
    await emit({ import: imported, purges }, () => {
      if (imported) {
        const report = imported as { finished: string | null; guilds: Record<string, { name: string; complete: number; channels: number; threads: number; messages_created: number; files_copied: number; files_missing: number; gaps: object }> }
        console.log(`Import ${report.finished ? `finished ${report.finished.slice(0, 16)}` : 'running (or stopped; run it again to resume)'}`)
        for (const g of Object.values(report.guilds)) console.log(`  ${g.name}: ${g.complete} of ${g.channels + g.threads} complete, ${g.messages_created} messages, ${g.files_copied} files copied, ${g.files_missing} gone on Discord, ${Object.keys(g.gaps).length} with gaps`)
      } else console.log('No import yet.')
      for (const p of purges) console.log(`Purge ${p.plan} (${p.guild}): ${p.deleted} of ${p.planned} deleted, ${p.failed} failed, ${p.threads_deleted} threads. ${p.finished ? 'Finished' : 'Running or stopped'}.`)
    })
    return
  }
  if (sub === 'purge') {
    const config = requireConfig()
    const { executePlan, loadPlan, makePlan, summarise } = await import('./discord/purge.ts')
    const planId = str(flags['execute'])
    if (planId) {
      const plan = loadPlan(paths, planId)
      if (flags['detach'] === true) {
        const { detach } = await import('./discord/local.ts')
        console.log(await detach(paths, `purge-${planId}`, argv))
        return
      }
      const progress = await executePlan(await discordRest(flags), paths, plan, { log: json ? () => {} : console.log })
      await emit(progress, () => console.log(`Deleted ${progress.deleted}, threads ${progress.threads_deleted}, failed ${progress.failed}${progress.failed ? ` (${JSON.stringify(progress.failures_by_code)}). Run the same command again to retry` : ''}. Then: vocorum discord report`))
      return
    }
    const guild = rest[0]
    if (!guild || !/^\d{1,20}$/.test(guild)) throw new Error('usage: discord purge <guild id> [--older-than 7d] [--authors me,bot] [--keep ID,...] [--threads] [--kimaki-keep]')
    const plan = await makePlan(await discordRest(flags), config, paths, {
      guild,
      olderThanDays: duration(str(flags['older-than']) ?? '7d') / 86_400_000,
      authors: (str(flags['authors']) ?? 'me,bot').split(','),
      keep: (str(flags['keep']) ?? '').split(',').filter(Boolean),
      threads: flags['threads'] === true,
      kimakiKeep: flags['kimaki-keep'] === true,
    })
    const summary = summarise(plan)
    await emit(summary, () => {
      console.log(`Plan ${plan.id} for ${summary.guild}: delete ${summary.messages} messages in ${summary.channels} channels (${summary.with_secrets} with secrets first), and ${summary.threads_to_delete} threads. About ${summary.estimate_minutes} minutes.`)
      const s = summary.not_touched
      console.log(`Not touched: ${s.other_authors} by other people, ${s.recent} too recent, ${s.kept} in kept threads, ${s.not_copied} whose files the hub does not have yet, ${s.not_from_discord} written in the hub.`)
      if (s.not_copied) console.log('Copy those files first: vocorum discord import <guild id>, then plan again.')
      console.log(`Deleting on Discord cannot be undone. When the person has read this, run: vocorum discord purge --execute ${plan.id} --detach`)
    })
    return
  }
  if (sub === 'report') {
    const { writeReport } = await import('./discord/purge.ts')
    const file = writeReport(paths)
    await emit({ report: file }, () => console.log(`${fs.readFileSync(file, 'utf8')}\nWritten to ${file}`))
    return
  }
  throw new Error('usage: discord scan|import|status|purge|report (see vocorum help)')
}

const PERMISSION_NAMES: Record<string, string> = {
  view: 'VIEW_CHANNEL', send: 'SEND_MESSAGES', history: 'READ_MESSAGE_HISTORY', threads: 'SEND_MESSAGES_IN_THREADS', files: 'ATTACH_FILES', react: 'ADD_REACTIONS', commands: 'USE_APPLICATION_COMMANDS', manage: 'MANAGE_CHANNELS', 'manage-messages': 'MANAGE_MESSAGES', 'manage-threads': 'MANAGE_THREADS', pin: 'PIN_MESSAGES',
}

async function requestCommand(command: string, sub: string | undefined, rest: string[], flags: Record<string, string | true>, json: boolean) {
  const config = requireConfig()
  const { HubAdmin, openTwin } = await import('./discord/local.ts')
  const admin = new HubAdmin(config, paths)
  const emit = async (value: unknown, text: () => unknown) => (json ? console.log(JSON.stringify(value, null, 1)) : await text())
  if (command === 'requests') {
    if (sub === 'undo') {
      const id = rest[0]
      if (!id) throw new Error('usage: requests undo <id>')
      const created = await admin.call<{ id: string; summary: string }>('POST', `/admin/requests/${encodeURIComponent(id)}/undo`, { origin: process.env['OPENCODE_SESSION_ID'] ? `agent session ${process.env['OPENCODE_SESSION_ID']}` : 'cli' }, { tries: 1 })
      await emit(created, () => console.log(`Request ${created.id}: ${created.summary}. It waits for the owner's approval like any other.`))
      return
    }
    if (sub === 'deny') {
      const id = rest[0]
      if (!id) throw new Error('usage: requests deny <id>')
      await emit(await admin.call('POST', `/admin/requests/${encodeURIComponent(id)}/deny`, {}, { tries: 1 }), () => console.log(`Denied ${id}.`))
      return
    }
    const { requests } = await admin.call<{ requests: Array<{ id: string; status: string; summary: string; origin: string; created_at: number }> }>('GET', '/admin/requests', undefined, { tries: 1 })
    await emit(requests, () => {
      for (const r of requests) console.log(`${r.id}\t${r.status}\t${new Date(r.created_at).toISOString().slice(0, 16)}\t${r.summary}\t(from ${r.origin})`)
      if (!requests.length) console.log('No requests.')
    })
    return
  }
  const twin = openTwin(paths)
  const one = async (sql: string, args: string[]) => (await twin.execute({ sql, args })).rows[0]
  try {
    const guildArg = str(flags['guild'])
    const guild = guildArg ? await one('SELECT id, name FROM Guild WHERE id = ? OR name = ?', [guildArg, guildArg]) : await one('SELECT id, name FROM Guild WHERE id = ?', [config.guildId])
    if (!guild) throw new Error(`No server "${guildArg}"`)
    const guildId = String(guild['id'])
    const person = async (name: string) => {
      const row = await one('SELECT id, username FROM User WHERE (username = ? OR id = ?) AND bot = 0', [name.toLowerCase(), name])
      if (!row) throw new Error(`No person "${name}" on the hub`)
      return String(row['id'])
    }
    let input: { method: string; route: string; body: unknown; summary: string }
    if (sub === 'invite') {
      const username = rest[0]
      if (!username) throw new Error('usage: request invite <username> [--guild ID|NAME]')
      input = { method: 'POST', route: `/client/guilds/${guildId}/invites`, body: { username }, summary: `Invite ${username} to ${guild['name']}` }
    } else if (sub === 'role') {
      const [name, ...roleWords] = rest
      const roleName = roleWords.join(' ')
      if (!name || !roleName) throw new Error('usage: request role <username> <role name> [--remove] [--guild ID|NAME]')
      const userId = await person(name)
      const role = await one('SELECT id, name FROM Role WHERE guildId = ? AND lower(name) = lower(?)', [guildId, roleName])
      if (!role) throw new Error(`No role "${roleName}" in ${guild['name']}`)
      const member = await one('SELECT roles FROM GuildMember WHERE guildId = ? AND userId = ?', [guildId, userId])
      if (!member) throw new Error(`${name} is not in ${guild['name']}`)
      const roles = new Set(JSON.parse(String(member['roles'])) as string[])
      if (flags['remove'] === true) roles.delete(String(role['id']))
      else roles.add(String(role['id']))
      input = { method: 'PUT', route: `/client/guilds/${guildId}/members/${userId}/roles`, body: { roles: [...roles] }, summary: `${flags['remove'] === true ? 'Take' : 'Give'} the role ${role['name']} ${flags['remove'] === true ? 'from' : 'to'} ${name} in ${guild['name']}` }
    } else if (sub === 'channel') {
      const [channelArg, target] = rest
      if (!channelArg || !target) throw new Error('usage: request channel <channel name|id> <username|role name> [--allow view,send] [--deny view]')
      const channel = await one('SELECT id, name FROM Channel WHERE guildId = ? AND (id = ? OR name = ?) AND type IN (0, 4, 5, 15)', [guildId, channelArg, channelArg.replace(/^#/, '')])
      if (!channel) throw new Error(`No channel "${channelArg}" in ${guild['name']}`)
      const role = await one('SELECT id FROM Role WHERE guildId = ? AND lower(name) = lower(?)', [guildId, target === 'everyone' ? '@everyone' : target])
      const targetId = role ? String(role['id']) : target === 'everyone' ? guildId : await person(target)
      const { P } = await import('./access.ts')
      const bits = (list: string | undefined) =>
        (list ?? '').split(',').filter(Boolean).reduce((acc, name) => {
          const key = PERMISSION_NAMES[name] ?? name.toUpperCase()
          const bit = (P as Record<string, bigint>)[key]
          if (bit === undefined) throw new Error(`Unknown permission "${name}". Use: ${Object.keys(PERMISSION_NAMES).join(', ')}`)
          return acc | bit
        }, 0n)
      const allow = bits(str(flags['allow']) ?? (flags['deny'] ? '' : 'view,send,history,threads'))
      const deny = bits(str(flags['deny']))
      input = { method: 'PUT', route: `/client/channels/${channel['id']}/permissions/${targetId}`, body: { type: role || target === 'everyone' ? 0 : 1, allow: String(allow), deny: String(deny) }, summary: `#${channel['name']}: ${allow ? `allow ${str(flags['allow']) ?? 'view,send,history,threads'}` : ''}${allow && deny ? ', ' : ''}${deny ? `deny ${str(flags['deny'])}` : ''} for ${target}` }
    } else if (sub === 'raw') {
      const [method, route, body] = rest
      if (!method || !route) throw new Error('usage: request raw <METHOD> <route> [json body]')
      input = { method, route, body: body ? JSON.parse(body) : {}, summary: str(flags['summary']) ?? `${method} ${route}` }
    } else throw new Error('usage: request invite|role|channel|raw ... (see vocorum help)')
    const origin = str(flags['origin']) ?? (process.env['OPENCODE_SESSION_ID'] ? `agent session ${process.env['OPENCODE_SESSION_ID']}` : 'cli')
    const created = await admin.call<{ id: string; summary: string }>('POST', '/admin/requests', { ...input, reason: str(flags['reason']) ?? '', origin }, { tries: 1 })
    await emit(created, () => console.log(`Request ${created.id}: ${created.summary}\nIt waits for the owner, who approves it in the app with a passkey (24 hours). Check: vocorum requests`))
  } finally {
    twin.close()
  }
}
