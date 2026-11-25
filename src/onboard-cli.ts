// CLI commands for getting started, migrating from Discord and checking the
// hub. Every command takes --json, so an agent can drive it and read results.
//
//   setup [--port N] [--address IP] [--name a,b] [--allow CIDR,...] [--no-service] [--dry-run] [--yes]
//   doctor | restart
//   backup [DIR] [--no-files]                 a consistent copy while the hub runs
//   pair <device> [--ttl 30m] [--person <username>]   one link and a QR code for a new device
//   config get [key] | config set <key> <value>
//   discord scan [<guild id>...|all]          read only: what is there and what the bot cannot read
//   discord import <guild id>...|all [--archive DIR] [--no-files] [--detach]
//   discord status
//   discord purge <guild id> [--channels IDS] [--older-than 7d] [--authors me,bot] [--keep ID,...] [--threads] [--kimaki-keep]
//   discord purge --execute <plan id> [--detach]
//   discord report
//   kimaki setup <machine> [--guild ID|NAME,...] [--kimaki PATH] [--lock-port N] [--peer-data-dir DIR] [--no-service] [-- kimaki args]
//                 a Kimaki on this machine that lives on the hub, beside any Kimaki on Discord
//   admin setup [--kimaki PATH] [--model M] [--no-service] | admin status     a private Admin server with your own admin agent
//   channels list [--guild ID|NAME]
//   invite <username> [--server NAME] [--name TEXT] | welcome <username> | access <username>   friends
//   projects add <folder> [--guild ID|NAME] | projects list                    a hub Kimaki channel for a folder
//   request invite <username> [--guild ID|NAME] [--reason TEXT]       changes the owner approves with a passkey
//   request remove <username> [--guild ID|NAME]
//   request role <username> <role name> [--remove] [--guild ID|NAME]
//   request channel <channel name|id> <username|role name> [--allow view,send,...] [--deny view,...]
//   request raw <METHOD> <route> [json body]
//   requests [list] | requests deny <id> | requests undo <id>      undo files the reversing change as a new request
//   Discord token: --token-file F (mode 0600), or DISCORD_BOT_TOKEN, or --kimaki (this machine's Kimaki bot).

import fs from 'node:fs'
import os from 'node:os'
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
const TOKEN_HELP = `Discord token, in this order: --token-file FILE (a file only you can read, chmod 600),
the DISCORD_BOT_TOKEN environment variable, or --kimaki (this machine's Kimaki bot).
The token is never printed or written anywhere.`

export const HELP: Record<string, string> = {
  setup: `vocorum setup [--port N] [--address IP] [--name NAME,...] [--allow CIDR,...] [--no-service] [--dry-run] [--yes] [--json]

Sets up the hub on this machine in one go, and is safe to run again.
  - Checks Node 22+, the build and openssl.
  - Picks a private address: your Tailscale IP, else a WireGuard address, else this machine only.
  - Names the hub: your Tailscale machine name first (devices need no DNS setup), then hub.home.arpa.
    The certificate comes from the hub's own authority, so the names never reach public certificate logs.
  - Creates ~/.vocorum, turns on HTTPS for your own devices, installs and starts the service,
    adds a vocorum command to ~/.local/bin, checks everything, and prints a pairing link and QR code.

  --dry-run     show what it would do, change nothing
  --yes         go ahead without asking (agents: only after the person said yes)
  --address IP  listen on this private address instead of the one found
  --name A,B    hub names, the first is the app address
  --allow CIDR  networks allowed to connect (default: the tailnet)
  --port N      local port for a new hub (default 47100)
  --no-service  do not install a service; start it with: vocorum start`,
  doctor: `vocorum doctor [--json]

Checks every layer a device or bot goes through and prints the command that fixes
each problem. Read only. Exits 1 when something fails.`,
  pair: `vocorum pair <device name> [--ttl 30m] [--person USERNAME] [--app] [--json]

Makes a single-use pairing code and prints one link and a QR code. The link opens
the hub's setup page by address, which works before the device trusts anything; it
shows what to install for that device and then opens the app with the code filled in.

  --ttl 30m          how long the code works (at most 24h; default 30m)
  --person USERNAME  a device for someone you invited (default: you)
  --app              QR for the Vocorum app instead of the browser (the app checks the
                     hub's certificate itself: no profile, DNS step or passkey needed)`,
  config: `vocorum config get [KEY] [--json]
vocorum config set KEY VALUE

Keys you can set: ownerUsername, ownerDiscordIds (your Discord user ids, comma
separated), botUsername, guildName, publicUrl (or none), tailscaleLogin (or none).
Restart the hub afterwards: vocorum restart`,
  admin: `vocorum admin setup [--kimaki PATH] [--model PROVIDER/MODEL] [--no-service] [--json]
vocorum admin status [--json]

setup makes a private server called Admin with one channel, #admin, where you ask
your own agent to run the hub in plain words: devices, people, access, privacy,
projects, backups, moving from Discord. It is a Kimaki of its own on this machine,
working in <state>/admin. Its tools are only vocorum commands: reading runs, every
change shows you the exact command to accept, and anything that widens access is
a request you approve with your passkey. Nobody else can join the Admin server and
no other bot can read or post there. status checks all of that.`,
  invite: `vocorum invite <username> [--server NAME] [--name "Display name"] [--json]

Brings a friend onto the hub. They get their own server (Friends) unless you pass
--server, so they never see your machines or their agent sessions. Prints a message
to send them (what to install, a setup link with a single-use 24-hour code, the
fingerprint to check) and your part in Tailscale: share this computer with them,
and optionally limit shared users to Vocorum's ports. Their Tailscale account is
learned when they pair; afterwards only that account works for them.
See what they can see: vocorum access <username>. Remove: vocorum people remove <username>.`,
  welcome: `vocorum welcome <username> [--json]

A fresh 24-hour link and message for someone already invited (a new device, or the
first code ran out).`,
  access: `vocorum access <username> [--json]

What one person can see and do: servers, channels, roles, whether they can give
orders to agents, their devices and Tailscale account.`,
  projects: `vocorum projects add <folder> [--guild ID|NAME] [--json]
vocorum projects list [--json]

add makes a channel for a folder in the hub's Kimaki (from vocorum kimaki setup):
a message there starts an agent session in that folder.`,
  request: `vocorum request invite <username> [--guild ID|NAME] [--reason TEXT]
vocorum request remove <username> [--guild ID|NAME] [--reason TEXT]
vocorum request role <username> <role name> [--remove] [--guild ID|NAME]
vocorum request channel <channel> <username|role|everyone> [--allow view,send,...] [--deny view,...]
vocorum request raw <METHOD> <route> [json body]

Files a change for the owner, who approves it in the app's Inbox with a passkey.
The card describes the change in the hub's words; --reason is shown beside it.
Requests wait 24 hours. Nothing can change the Admin server this way.`,
  backup: `vocorum backup [DIR] [--no-files] [--json]

A consistent copy of the hub while it runs: both databases, the config, the
secrets and the CA, the hub's Kimaki data (its sessions and their threads), and
the stored files as hard links when DIR is on the same disk (no extra space;
--no-files leaves them out). Owner only (0600, folders 0700). A manifest lists
what is in it. Default DIR: <state>/backups/<time>; copy it to another disk or
machine to survive losing this one. Take one before an import, a purge or an update.
Restore with: vocorum restore DIR`,
  export: `vocorum export DIR [--json]

Everything you can read, as plain files that need nothing from Vocorum: every
server's channels and threads and your own direct messages (never other
people's), each as Markdown to read and JSON Lines to process, every stored file
under its name, and people.json. DIR must be outside the hub folder.`,
  uninstall: `vocorum uninstall [--yes] [--delete-data] [--json]

Takes this hub off this machine: stops and removes its service and its Kimaki
and admin agent services (systemd, launchd or Task Scheduler), stops background
processes, and removes the vocorum command setup made. Without --yes it only
lists what it would do. Data is kept unless --delete-data: export or back it up
first (vocorum export DIR, vocorum backup DIR). It then lists what to do by hand:
the certificate and passkey on each device, Tailscale shares, this code folder.`,
  restore: `vocorum restore DIR [--replace] [--json]

Puts a backup back: into an empty hub folder (a new machine: set VOCORUM_DIR or
use ~/.vocorum), or over the current one with --replace (what is there is moved
aside, never deleted). The hub must not be running. Checks the copy against the
backup's manifest, then: vocorum setup. Devices keep trusting the hub when this
machine has the old hub's address and name (same CA); with a new address the
hub makes a new CA, and devices install it again from the setup page.`,
  restart: `vocorum restart

Restarts this hub's service (systemd or launchd) and waits until it answers.
Without a service (no service manager, or --no-service) it restarts the hub's
background process (hub.pid in the state folder).`,
  'discord scan': `vocorum discord scan [GUILD_ID ...|all] [--token-file FILE|--kimaki] [--json]

Read only. Shows each Discord server's channels and threads, what the bot cannot
read, whether the bot has the Message Content intent, and how long an import and a
cleanup would take.

${TOKEN_HELP}`,
  'discord import': `vocorum discord import GUILD_ID ...|all [--channels IDS] [--token-file FILE|--kimaki] [--archive DIR] [--no-files] [--detach] [--json]

Copies Discord servers into the hub with their Discord ids: channels, active and
archived threads, every message, files (while Discord still has them), avatars and
server icons. History is marked read. Runs beside the hub and slows down when the hub
gets busy. Checks every channel and resumes where it stopped when run again.
Writes ~/.vocorum/import/report.json, including secrets it saw (masked).
Set your Discord user id first: vocorum config set ownerDiscordIds <id>

  --channels IDS  only these channels and their threads (comma separated)
  --detach     keep running in the background (needs --token-file or --kimaki)
  --archive D  also read an earlier archive (D/<guild>/<channel>.jsonl)
  --no-files   skip files (not recommended: Discord's file links expire)

${TOKEN_HELP}`,
  'discord status': `vocorum discord status [--json]

Shows how far the import and any cleanup have got.`,
  'discord purge': `vocorum discord purge GUILD_ID [--channels IDS] [--older-than 7d] [--authors me,bot] [--keep ID,...] [--threads] [--kimaki-keep] [--token-file FILE|--kimaki] [--json]
vocorum discord purge --execute PLAN_ID [--token-file FILE|--kimaki] [--detach] [--json]

Deleting on Discord cannot be undone, so this works in two steps.
The first form only writes a plan and prints its id and what it would delete. It
only plans messages the hub already holds with their files; nothing can turn that off.
The second form runs exactly that plan, can be stopped and run again, and logs every
failure with Discord's error code.

  --older-than 7d   keep messages, and whole threads, active in this period (default 7d)
  --authors LIST    whose messages: me, bot, all, or Discord user ids (default me,bot)
  --channels IDS    only these channels and their threads
  --keep IDS        channels or threads to leave alone
  --threads         also delete threads nobody else wrote in
  --kimaki-keep     leave threads with scheduled Kimaki work alone
  --detach          run in the background; follow it with: vocorum discord status

${TOKEN_HELP}`,
  'discord report': `vocorum discord report [--json]

Writes ~/.vocorum/purge/PURGE-REPORT.md: what the hub holds, what was deleted, what
failed and why, secrets to rotate (masked), what Discord still keeps, and the steps
only you can do on Discord.`,
}

function help(key: string) {
  console.log(HELP[key] ?? Object.values(HELP).map((h) => h.split('\n')[0]).join('\n'))
}

const BOOLEAN = new Set(['help', 'replace', 'delete-data', 'app', 'no-service', 'remove', 'json', 'yes', 'dry-run', 'no-service', 'detach', 'no-files', 'threads', 'kimaki-keep'])

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
// The Vocorum apps pair from their own link instead, which carries the CA's
// fingerprint: no certificate or DNS setup and no passkey on those devices.
export async function pairingLinks(config: HubConfig, code: string) {
  const l = config.privateListener
  if (!l) return { setup: null, app: `http://localhost:${config.port}/#pair=${code}`, native: null }
  const host = l.address.includes(':') ? `[${l.address}]` : l.address
  const { appPairLink } = await import('./private-listener.ts')
  const caCert = path.join(paths.ca, 'ca.crt')
  const native = fs.existsSync(caCert) ? appPairLink(l, caCert, code) : null
  return { setup: l.httpPort === null ? null : `http://${host}:${l.httpPort}/?code=${code}`, app: `https://${l.names[0]}:${l.port}/#pair=${code}`, native }
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
  return new DiscordRest(await discordToken({ tokenFile: str(flags['token-file']), kimaki: flags['kimaki'] === true ? true : str(flags['kimaki']), stateDir: paths.root }))
}

export async function onboardCommand(argv: string[]): Promise<boolean> {
  // `vocorum ... | head` closes the pipe early: that is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
  })
  const { flags, positional } = parse(argv)
  const [command, sub, ...rest] = positional
  if (command === 'help' && sub && (HELP[sub] || HELP[`${sub} ${rest[0]}`])) {
    help(HELP[sub] ? sub : `${sub} ${rest[0]}`)
    return true
  }
  // Anywhere, also after `--`: a request for help never runs the command.
  if (flags['help'] === true || argv.includes('--help') || argv.includes('-h')) {
    const key = command === 'discord' ? `discord ${sub}` : String(command)
    if (HELP[key]) {
      help(key)
      return true
    }
    // Never run a command when help was asked for: the main CLI prints it.
    return false
  }
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
    const links = result.pairing && config ? await pairingLinks(config, result.pairing.code) : null
    await emit({ ...result, links }, async () => {
      if (flags['dry-run']) return console.log('\nDry run: nothing changed. Run again without --dry-run.')
      const { printChecks } = await import('./doctor.ts')
      console.log('')
      printChecks(result.checks)
      if (links && result.pairing) await printPairing(links, result.pairing.code, result.pairing.ttlMinutes)
    })
    return true
  }
  if (command === 'admin') {
    const config = requireConfig()
    const admin = await import('./admin.ts')
    if (sub === 'setup') {
      const result = await admin.adminSetup(config, paths, { ...(str(flags['kimaki']) && { kimaki: str(flags['kimaki'])! }), ...(str(flags['model']) && { model: str(flags['model'])! }), service: flags['no-service'] !== true })
      await emit(result, () => {
        for (const s of result.steps) console.log(`✓ ${s.step.padEnd(10)} ${s.detail}`)
        console.log(`\nOpen the Admin server in the app and write in #admin, for example: "is everything ok?" or "pair my new laptop".`)
      })
      return true
    }
    if (sub === 'status' || !sub) {
      const checks = await admin.adminStatus(config, paths)
      const { printChecks } = await import('./doctor.ts')
      await emit(checks, () => printChecks(checks))
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1
      return true
    }
    throw new Error('usage: vocorum admin setup|status')
  }
  if (command === 'invite' || command === 'welcome') {
    const config = requireConfig()
    const username = sub?.toLowerCase()
    if (!username) throw new Error(`usage: vocorum ${command} <username>${command === 'invite' ? ' [--server NAME] [--name "Display name"]' : ''}`)
    const { HubAdmin } = await import('./discord/local.ts')
    const { HubStore } = await import('./store.ts')
    const { FRIENDS_SERVER, invitation } = await import('./friends.ts')
    const admin = new HubAdmin(config, paths)
    const store = new HubStore(`file:${paths.hubDb}`)
    let code: string
    let server: string
    try {
      await store.migrate()
      if (command === 'invite') {
        // A server of their own unless told otherwise: Home holds the machines and their agent sessions.
        const wanted = str(flags['server']) ?? FRIENDS_SERVER
        let guild = await store.findGuild(wanted)
        if (!guild && !str(flags['server'])) {
          guild = await store.addGuild(FRIENDS_SERVER)
          await admin.call('POST', '/admin/reload', {})
        }
        if (!guild) throw new Error(`No server "${wanted}". See: vocorum guilds list`)
        server = guild.name
        const invited = await admin.call<{ code: string }>('POST', '/admin/people', { username, guilds: [guild.id], ...(str(flags['name']) && { global_name: str(flags['name']) }) }, { tries: 1 })
        code = invited.code
      } else {
        const { openTwin } = await import('./discord/local.ts')
        const twin = openTwin(paths)
        const row = (await twin.execute({ sql: 'SELECT id, globalName FROM User WHERE username = ? AND bot = 0', args: [username] })).rows[0]
        if (row?.['globalName'] && !str(flags['name'])) flags['name'] = String(row['globalName'])
        const servers = row ? (await twin.execute({ sql: 'SELECT g.name FROM GuildMember m JOIN Guild g ON g.id = m.guildId WHERE m.userId = ?', args: [String(row['id'])] })).rows.map((r) => String(r['name'])) : []
        twin.close()
        if (row && String(row['id']) === config.ownerUserId) throw new Error(`${username} is you, the hub's owner: pair your own device with vocorum pair <device name>.`)
        if (!row) throw new Error(`No one called "${username}" on the hub. Someone from an imported Discord server: check the username (vocorum people list), or import the server first. Your own Discord account is you here (vocorum pair <device name>). Someone new: vocorum invite ${username}`)
        code = await store.createPairing(`${username}'s device`, { userId: String(row['id']), ttlMs: 24 * 3_600_000 })
        server = servers.length ? servers.join(', ') : 'their servers'
      }
    } finally {
      store.close()
    }
    const links = await pairingLinks(config, code)
    const result = await invitation(config, paths, { username, displayName: str(flags['name']) ?? null, server, code, hours: 24, links, local: flags['local'] === true })
    await emit(result, () => {
      console.log(`${command === 'invite' ? `Invited ${username} to ${server}.` : `A new link for ${username}.`} Send them this:\n`)
      console.log(result.message.split('\n').map((line) => `  ${line}`).join('\n'))
      console.log('\nYour part:')
      for (const step of result.owner_steps) console.log(`  - ${step}`)
    })
    return true
  }
  if (command === 'access') {
    const config = requireConfig()
    if (!sub) throw new Error('usage: vocorum access <username>')
    const { HubAdmin } = await import('./discord/local.ts')
    type Access = { username: string; owner: boolean; tailscale_login: string | null; devices: string[]; servers: Array<{ name: string; owner: boolean; roles: string[]; drives_agents: boolean; manages_people: boolean; channels: Array<{ name: string; category: string | null; send: boolean }> }> }
    const result = await new HubAdmin(config, paths).call<Access>('GET', `/admin/people/${encodeURIComponent(sub)}/access`, undefined, { tries: 1 })
    await emit(result, () => {
      console.log(`${result.username}${result.owner ? ' (owner: sees everything)' : ''}. Devices: ${result.devices.join(', ') || 'none yet'}. Tailscale: ${result.tailscale_login ?? 'learned when they pair'}.`)
      for (const g of result.servers) {
        console.log(`\n${g.name}${g.roles.length ? ` (roles: ${g.roles.join(', ')})` : ''}`)
        if (g.drives_agents) console.log('  ! can give orders to agents on your machines (a shell there)')
        if (g.manages_people) console.log('  ! can manage people or roles')
        for (const c of g.channels) console.log(`  #${c.name}${c.category ? ` in ${c.category}` : ''}${c.send ? '' : ' (read only)'}`)
      }
      if (!result.servers.length) console.log('No servers: they see nothing.')
      console.log('\nNever: the Admin server, other people\'s direct messages, devices, services, requests or hub settings.')
    })
    return true
  }
  if (command === 'channels' && (sub === 'list' || !sub)) {
    requireConfig()
    const { openTwin } = await import('./discord/local.ts')
    const twin = openTwin(paths)
    try {
      const guildArg = str(flags['guild'])
      const rows = (await twin.execute({ sql: `SELECT c.id, c.name, c.type, c.parentId, g.name AS guild FROM Channel c JOIN Guild g ON g.id = c.guildId WHERE c.type IN (0, 2, 4, 5, 15) ${guildArg ? 'AND (g.id = ? OR g.name = ?)' : ''} ORDER BY g.name, c.position`, args: guildArg ? [guildArg, guildArg] : [] })).rows
      const kinds: Record<number, string> = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 15: 'forum' }
      const list = rows.map((r) => ({ id: String(r['id']), name: String(r['name'] ?? ''), kind: kinds[Number(r['type'])] ?? String(r['type']), category: r['parentId'] ? String(rows.find((x) => String(x['id']) === String(r['parentId']))?.['name'] ?? '') : null, server: String(r['guild']) }))
      await emit(list, () => {
        for (const c of list) console.log(`${c.server}\t${c.kind === 'category' ? '' : '#'}${c.name}\t${c.kind}${c.category ? `\tin ${c.category}` : ''}\t${c.id}`)
      })
    } finally {
      twin.close()
    }
    return true
  }
  if (command === 'projects') {
    const config = requireConfig()
    const { projects } = await import('./admin.ts')
    const result = await projects(config, paths, sub === 'add' ? { add: rest[0] ?? '', ...(str(flags['guild']) && { guild: str(flags['guild'])! }) } : {})
    await emit(result, () => {
      if (sub === 'add') console.log(`Channel #${result.added?.channel ?? '?'} for ${result.added?.directory ?? rest[0]}.`)
      else for (const p of result.list) console.log(`#${p.channel}\t${p.directory}`)
    })
    return true
  }
  if (command === 'backup') {
    requireConfig()
    const { backup } = await import('./backup.ts')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const dir = path.resolve(sub ?? path.join(paths.root, 'backups', stamp))
    const result = await backup(paths, dir, { files: flags['no-files'] !== true })
    const c = result.manifest.counts
    await emit({ backup: result.dir, ...result.manifest, seconds: result.seconds }, () => {
      console.log(`Backed up to ${result.dir} in ${result.seconds.toFixed(1)} s: ${c.messages} messages, ${c.attachments} stored files, ${c.devices} devices, ${c.bots} bots, ${c.kimaki_sessions} Kimaki sessions.`)
      if (dir.startsWith(path.join(paths.root, 'backups'))) console.log('It is on this disk. To survive a dead disk or machine, copy it elsewhere, for example: tar -C ' + path.dirname(dir) + ' -cf ~/vocorum-backup.tar ' + path.basename(dir))
    })
    return true
  }
  if (command === 'restore') {
    if (!sub) throw new Error('usage: vocorum restore <backup folder> [--replace]')
    const { restore } = await import('./backup.ts')
    const result = await restore(paths, path.resolve(sub), { replace: flags['replace'] === true })
    const os2 = await import('node:os')
    const here = Object.values(os2.networkInterfaces()).flat().map((i) => i?.address)
    const elsewhere = result.address && !here.includes(result.address)
    await emit({ ...result, address_on_this_machine: !elsewhere }, () => {
      console.log(`Restored into ${result.root} in ${result.seconds.toFixed(1)} s: ${result.counts.messages} messages, ${result.counts.attachments} stored files, ${result.counts.devices} devices, ${result.counts.bots} bots, ${result.counts.kimaki_sessions} Kimaki sessions. CA ${result.ca_fingerprint?.slice(0, 23)}…`)
      if (result.moved_aside) console.log(`What was there before is in ${result.moved_aside}.`)
      console.log(`${result.from} still holds the hub's keys: keep it as private as the hub, or delete it once the hub runs.`)
      for (const p of result.problems) console.log(`  ! ${p}`)
      if (elsewhere) {
        console.log(`\nThe hub listened on ${result.address}, which is not an address of this machine.`)
        console.log('For every device to keep trusting it with nothing to redo, give this machine that address and name:')
        console.log(`  in Tailscale's admin console, remove the old machine, rename this one to its name, and set its IPv4 to ${result.address} (Machines, the menu, Edit machine IPv4).`)
        console.log(`Then: vocorum setup. With another address instead (vocorum setup --address <ip>) the hub makes a new CA, and every device installs it again from the setup page; passkeys keep working while the name (${result.names[0]}) stays.`)
      } else console.log('\nNext: vocorum setup (installs the service here and checks everything; it keeps the names and the CA).')
    })
    if (result.problems.length) process.exitCode = 1
    return true
  }
  if (command === 'export') {
    const config = requireConfig()
    if (!sub) throw new Error('usage: vocorum export <folder>')
    const { exportHub } = await import('./leave.ts')
    const result = await exportHub(config, paths, path.resolve(sub))
    await emit(result, () => console.log(`Exported ${result.messages} messages (${result.channels} channels, ${result.threads} threads, ${result.direct_messages} direct message conversations, in ${result.servers} servers) and ${result.files} files, to ${result.dir} in ${result.seconds.toFixed(1)} s. Start with README.txt.${result.files_missing ? ` ${result.files_missing} files were never stored on the hub; README.txt lists them.` : ''}`))
    return true
  }
  if (command === 'uninstall') {
    const { loadConfig } = await import('./config.ts')
    const { uninstall } = await import('./leave.ts')
    const deleteData = flags['delete-data'] === true
    const result = await uninstall(loadConfig(paths), paths, { execute: flags['yes'] === true, deleteData, repo })
    await emit(result, () => {
      if (flags['yes'] !== true) console.log('vocorum uninstall would:')
      for (const s of result.steps) console.log(`  ${s.done ? 'done' : '-'} ${s.detail}`)
      if (!result.steps.length) console.log('  nothing: no service, process or command of this hub here.')
      if (flags['yes'] !== true) console.log(`\nNothing changed. Run again with --yes to do it${deleteData ? '' : ' (data is kept; add --delete-data to delete it, after vocorum export <folder> or vocorum backup <folder> outside it)'}.`)
      console.log('\nBy hand:')
      for (const line of result.by_hand) console.log(`  - ${line}`)
    })
    return true
  }
  if (command === 'restart') {
    const config = requireConfig()
    const { serviceName } = await import('./setup.ts')
    const { hubLatency } = await import('./doctor.ts')
    const { execFile } = await import('node:child_process')
    const { serviceManager, backgroundPid, stopBackground, startBackground } = await import('./setup.ts')
    const unit = serviceName(paths)
    const manager = await serviceManager()
    const { launchdFile, launchdLabel, restartTask, taskState } = await import('./platform.ts')
    const installed = manager === 'systemd' ? fs.existsSync(path.join(os.homedir(), `.config/systemd/user/${unit}.service`)) : manager === 'launchd' ? fs.existsSync(launchdFile(unit)) : manager === 'task' ? (await taskState(unit)) !== null : false
    // No service: the hub runs as a background process (setup started it, or the @reboot line).
    if (!installed || backgroundPid(paths)) {
      await stopBackground(paths)
      if (typeof (await hubLatency(config, paths)) === 'number') throw new Error('A hub is answering that vocorum did not start (no service, no hub.pid). Stop it where it runs, then: vocorum restart')
      await startBackground(paths, repo)
    } else if (manager === 'task') await restartTask(unit, config.port)
    else {
      const [cmd, args] = manager === 'launchd' ? ['launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${launchdLabel(unit)}`]] : ['systemctl', ['--user', 'restart', unit]]
      await new Promise<void>((resolve, reject) => execFile(cmd as string, args as string[], (error) => (error ? reject(new Error(`${cmd} failed: ${error.message}. Is the service installed? vocorum setup`)) : resolve())))
    }
    const started = Date.now()
    let latency: number | null | 'other' = null
    while (Date.now() - started < 30_000 && typeof latency !== 'number') {
      await new Promise((r) => setTimeout(r, 300))
      latency = await hubLatency(config, paths)
    }
    if (typeof latency !== 'number') throw new Error(`The hub did not come back within 30 s. ${installed && manager === 'systemd' ? `journalctl --user -u ${unit} -n 50` : `See the end of ${path.join(paths.root, 'hub.log')}`}`)
    await emit({ restarted: unit, seconds: (Date.now() - started) / 1000 }, () => console.log(`Restarted ${unit}; answering after ${((Date.now() - started) / 1000).toFixed(1)} s.`))
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
      let userId: string | null = null
      const person = str(flags['person'])
      if (person) {
        const { openTwin } = await import('./discord/local.ts')
        const twin = openTwin(paths)
        try {
          const row = (await twin.execute({ sql: 'SELECT id FROM User WHERE username = ? AND bot = 0', args: [person.toLowerCase()] })).rows[0]
          if (!row) throw new Error(`No person "${person}". Invite them first: vocorum people invite ${person}`)
          userId = String(row['id']) === config.ownerUserId ? null : String(row['id'])
        } finally {
          twin.close()
        }
      }
      code = await store.createPairing(name, { ttlMs, userId })
    } finally {
      store.close()
    }
    const links = await pairingLinks(config, code)
    await emit({ device: name, code, expires_in_minutes: ttlMs / 60_000, links, app_installers: links.setup ? await appInstallers() : [] }, () => printPairing(links, code, ttlMs / 60_000, flags['app'] === true))
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
      await emit({ [key]: (updated as Record<string, unknown>)[key], restart: true }, () => console.log(`${key} set. Restart the hub to apply: vocorum restart`))
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

const SYSTEMS: Record<string, string> = { darwin: 'Mac', windows: 'Windows', linux: 'Linux' }

// Desktop app installers published with `vocorum apps publish`; the setup page offers them while the code is valid.
async function appInstallers() {
  const { AppReleases } = await import('./app-releases.ts')
  try {
    return new AppReleases(paths.apps).installers().map((i) => ({ platform: i.platform, version: i.version, file: i.file, size: i.size }))
  } catch {
    return []
  }
}

async function printPairing(links: { setup: string | null; app: string; native: string | null }, code: string, minutes: number, forApp = false) {
  const { qrTerminal } = await import('./qr.ts')
  const lasts = `Code ${code} works once, for ${minutes} minutes.`
  const installers = links.setup ? await appInstallers() : []
  const offer = installers.length ? `The setup page also has the Vocorum app for ${[...new Set(installers.map((i) => SYSTEMS[i.platform.split('-')[0]!] ?? i.platform))].join(', ')} (${installers[0]!.version}), while this code is valid.` : null
  if (forApp && links.native) {
    console.log(`\nPair the Vocorum app. ${lasts}\n`)
    console.log(qrTerminal(links.native))
    console.log(`Scan it with the phone's camera, or open this on the device:\n  ${links.native}`)
    if (offer) console.log(`\nApp not installed yet? ${offer}\n  ${links.setup}`)
    return
  }
  const first = links.setup ?? links.app
  console.log(`\nPair a device. ${lasts}\n`)
  console.log(qrTerminal(first))
  console.log(`Scan it with the device's camera, or open:\n  ${first}`)
  if (links.setup) console.log(`That page shows what to install, then opens Vocorum with the code filled in.${offer ? `\n${offer}` : ''}\n\nAlready set up?   ${links.app}`)
  if (links.native) console.log(`The Vocorum app?  vocorum pair <device> --app`)
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
      if (result.message_content_intent === null) console.log('Message Content intent: could not check (Discord did not show this bot\'s settings). If other people\'s messages import empty, turn it on in the developer portal, then import again.')
      for (const g of result.guilds) {
        console.log(`\n${g.name} (${g.id}): ${g.channels} channels in ${g.categories} categories, ${g.threads} threads (${g.thread_messages} messages in threads)`)
        if (g.owner_id && !(loadConfig(paths)?.ownerDiscordIds ?? []).includes(g.owner_id)) console.log(`  owner: ${g.owner_id}. If that is you: vocorum config set ownerDiscordIds ${g.owner_id}`)
        if (g.unreadable.length) console.log(`  the bot cannot read ${g.unreadable.length}: ${g.unreadable.slice(0, 10).join(', ')}${g.unreadable.length > 10 ? ', …' : ''}`)
        const c = g.community
        console.log(`  comes across: ${c.voice_channels ? `${c.voice_channels} voice channels (not their text chat), ` : ''}${c.roles} roles, ${c.member_list ? 'the member list with everyone\'s roles' : 'no member list'}, permissions of ${c.channels_with_permissions} channels, ${c.emoji} custom emoji${c.forums ? `, ${c.forums} forums (posts as threads, no tags)` : ''}${c.private_threads ? `, ${c.private_threads} private threads` : ''}, pins and reactions`)
        if (!c.member_list) console.log('  PROBLEM: no member list (and no roles per person, or who is in private threads) without the Server Members intent: Discord developer portal, your app, Bot, Privileged Gateway Intents, Server Members.')
        if (c.stage_channels) console.log(`  stays on Discord: ${c.stage_channels} stage or directory channels`)
      }
      console.log(`\nImport takes about ${result.estimate.import_minutes} minute${result.estimate.import_minutes === 1 ? '' : 's'} plus channel history; deleting its threads from Discord later (purge --threads) about ${result.estimate.purge_hours < 1 ? `${Math.max(1, Math.round(result.estimate.purge_hours * 60))} minutes` : `${result.estimate.purge_hours} hours`}, plus about 2 minutes per 1000 channel messages.`)
      console.log('Next: vocorum discord import <guild id> (or all) --detach')
    })
    return
  }
  if (sub === 'import') {
    const config = requireConfig()
    if (flags['detach'] === true) {
      if (process.env['DISCORD_BOT_TOKEN'] && !flags['token-file'] && !flags['kimaki']) throw new Error('With --detach, pass the token as --token-file (a file only you can read) or use --kimaki, so it never sits in a service definition.')
      const { detach } = await import('./discord/local.ts')
      const message = await detach(paths, 'import', argv)
      await emit({ detached: true, message }, () => console.log(message))
      return
    }
    if (!(config.ownerDiscordIds ?? []).length) console.error('Note: your own Discord user id is not set, so your Discord messages will show under your Discord name, not as you. Set it first with: vocorum config set ownerDiscordIds <your Discord user id> (then restart the hub).')
    const { importDiscord } = await import('./discord/import.ts')
    const report = await importDiscord(await discordRest(flags), config, paths, { guilds, channels: (str(flags['channels']) ?? '').split(',').filter(Boolean), archive: str(flags['archive']), files: flags['no-files'] !== true, log: json ? () => {} : console.log })
    await emit(report, () => {
      const gaps = Object.values(report.guilds).reduce((n, g) => n + Object.keys(g.gaps).length + g.files_failed, 0)
      console.log(gaps ? `\nSome messages or files did not arrive. Run the same command again; it resumes.` : `\nEverything arrived. Report: ${path.join(paths.root, 'import', 'report.json')}`)
      const admins = Object.values(report.guilds).flatMap((g) => g.community?.admins ?? [])
      const others = [...new Set(admins)].filter((a) => a !== 'you')
      if (others.length) console.log(`\nPeople who are administrators on Discord, and so on the hub once they join: ${others.slice(0, 20).join(', ')}${others.length > 20 ? ', …' : ''}.`)
      if (Object.values(report.guilds).some((g) => g.community?.members)) console.log('Members came across without a way to sign in. For each person who should join: vocorum welcome <their Discord username> (vocorum people list shows them), then send them what it prints.')
      if (report.secrets.length) console.log(`\n${report.secrets.length} secret${report.secrets.length === 1 ? "" : "s"} appeared in Discord messages. Rotate them (vocorum discord report lists them, masked).`)
    })
    return
  }
  if (sub === 'status') {
    const { readJson } = await import('./discord/local.ts')
    const { statusOf } = await import('./discord/purge.ts')
    const imported = readJson<Record<string, unknown> | null>(path.join(paths.root, 'import', 'report.json'), null)
    const purges = statusOf(paths)
    const { jobs } = await import('./discord/local.ts')
    const background = await jobs(paths)
    await emit({ import: imported, purges, jobs: background }, () => {
      for (const j of background) console.log(`${j.name}: ${j.running ? 'running' : 'not running'} (started ${j.started.slice(0, 16)}${j.unit ? `, ${j.unit}` : ''})${j.running ? '' : `. Last line of ${j.log}: ${j.last}`}`)
      if (imported) {
        const report = imported as { finished: string | null; guilds: Record<string, { name: string; complete: number; channels: number; threads: number; messages_created: number; files_copied: number; files_missing: number; gaps: object }> }
        console.log(`Import ${report.finished ? `finished ${report.finished.slice(0, 16)}` : 'running (or stopped; run it again to resume)'}`)
        for (const g of Object.values(report.guilds)) console.log(`  ${g.name}: ${g.complete} of ${g.channels + g.threads} complete, ${g.messages_created} new messages in the last run, ${g.files_copied} files copied, ${g.files_missing} gone on Discord, ${Object.keys(g.gaps).length} with gaps`)
      } else console.log('No import yet.')
      for (const p of purges) console.log(`Purge ${p.plan} (${p.guild}): ${p.deleted} of ${p.planned} deleted, ${p.already_gone ?? 0} were already gone, ${p.failed} failed, ${p.threads_deleted} threads. ${p.finished ? 'Finished' : 'Running or stopped'}.`)
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
        const message = await detach(paths, `purge-${planId}`, argv)
        await emit({ detached: true, plan: planId, message }, () => console.log(message))
        return
      }
      const progress = await executePlan(await discordRest(flags), paths, plan, { log: json ? () => {} : console.log })
      await emit(progress, () => console.log(`Deleted ${progress.deleted}, threads ${progress.threads_deleted}, failed ${progress.failed}${progress.failed ? ` (${JSON.stringify(progress.failures_by_code)}). Run the same command again to retry` : ''}. Then: vocorum discord report`))
      return
    }
    const guild = rest[0]
    if (!guild || !/^\d{1,20}$/.test(guild)) throw new Error('usage: discord purge <guild id> [--channels IDS] [--older-than 7d] [--authors me,bot] [--keep ID,...] [--threads] [--kimaki-keep]')
    const plan = await makePlan(await discordRest(flags), config, paths, {
      guild,
      olderThanDays: duration(str(flags['older-than']) ?? '7d') / 86_400_000,
      authors: (str(flags['authors']) ?? 'me,bot').split(','),
      keep: (str(flags['keep']) ?? '').split(',').filter(Boolean),
      threads: flags['threads'] === true,
      kimakiKeep: flags['kimaki-keep'] === true,
      ...(str(flags['channels']) && { channels: str(flags['channels'])!.split(',').filter(Boolean) }),
    })
    const summary = summarise(plan)
    const token = typeof flags['token-file'] === 'string' ? ` --token-file ${flags['token-file']}` : flags['kimaki'] ? ' --kimaki' : ''
    const next = `vocorum discord purge --execute ${plan.id}${token} --detach`
    await emit({ ...summary, next }, () => {
      console.log(`Plan ${plan.id} for ${summary.guild}: delete ${summary.messages} messages in ${summary.channels} channels and threads (${summary.with_secrets} with secrets first), and ${summary.threads_to_delete} threads. About ${summary.estimate_minutes} minute${summary.estimate_minutes === 1 ? "" : "s"}.`)
      if (summary.with_threads_option) console.log(`With --threads, ${summary.with_threads_option.threads} threads nobody else wrote in (${summary.with_threads_option.messages} of these messages) go whole, one request each: about ${summary.with_threads_option.estimate_minutes} minutes. The threads then disappear from Discord too.`)
      const s = summary.not_touched
      console.log(`Not touched: ${s.other_authors} by other people, ${s.recent} too recent, ${s.kept} in kept threads, ${s.not_copied} whose files the hub does not have yet, ${s.not_from_discord} written in the hub.`)
      if (s.not_copied) console.log('Copy those files first: vocorum discord import <guild id>, then plan again.')
      const bots = summary.other_authors.filter((a) => a.bot)
      if (bots.length) console.log(`Left as other people's, but bots or webhooks: ${bots.map((a) => `${a.name} (${a.id}, ${a.messages})`).join(', ')}. To include them: --authors me,bot,${bots.map((a) => a.id).join(',')}`)
      console.log(`Deleting on Discord cannot be undone. When the person has read this, run: ${next}`)
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

// Where the app opens a request's card (shown inline in a chat message, or in the Inbox).
function requestLink(config: HubConfig, id: string) {
  const l = config.privateListener
  return `${l ? `https://${l.names[0]}:${l.port}` : `http://localhost:${config.port}`}/#/requests/${id}`
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
      const link = requestLink(config, created.id)
      await emit({ ...created, link }, () => console.log(`Request ${created.id}: ${created.summary}. It waits for the owner's approval like any other.\nApprove: ${link}`))
      return
    }
    if (sub === 'deny') {
      const id = rest[0]
      if (!id) throw new Error('usage: requests deny <id>')
      await emit(await admin.call('POST', `/admin/requests/${encodeURIComponent(id)}/deny`, {}, { tries: 1 }), () => console.log(`Denied ${id}.`))
      return
    }
    const listed = await admin.call<{ requests: Array<{ id: string; status: string; summary: string; origin: string; created_at: number }> }>('GET', '/admin/requests', undefined, { tries: 1 })
    const requests = listed.requests.map((r) => ({ ...r, ...(r.status === 'pending' && { link: requestLink(config, r.id) }) }))
    await emit(requests, () => {
      for (const r of requests) console.log(`${r.id}\t${r.status}\t${new Date(r.created_at).toISOString().slice(0, 16)}\t${r.summary}\t(from ${r.origin})${r.status === 'pending' ? `\t${requestLink(config, r.id)}` : ''}`)
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
    } else if (sub === 'remove') {
      const name = rest[0]
      if (!name) throw new Error('usage: request remove <username> [--guild ID|NAME]')
      input = { method: 'DELETE', route: `/client/guilds/${guildId}/members/${await person(name)}`, body: {}, summary: '' }
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
    } else throw new Error('usage: request invite|remove|role|channel|raw ... (see vocorum help)')
    // Never taken from a flag: the card says where a request came from, and an agent must not choose it.
    const origin = process.env['OPENCODE_SESSION_ID'] ? `agent session ${process.env['OPENCODE_SESSION_ID']}` : 'cli'
    const created = await admin.call<{ id: string; summary: string }>('POST', '/admin/requests', { ...input, reason: str(flags['reason']) ?? '', origin }, { tries: 1 })
    const link = requestLink(config, created.id)
    await emit({ ...created, link }, () => console.log(`Request ${created.id}: ${created.summary}\nIt waits for the owner, who approves it with a passkey (24 hours).\nApprove: ${link}`))
  } finally {
    twin.close()
  }
}
