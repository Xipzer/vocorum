// vocorum CLI. State lives in ~/.vocorum (VOCORUM_DIR overrides).
//
//   init [--public-url URL|none] [--tailscale-login LOGIN] [--port N]
//   start
//   bots add <machine> [--guild ID|NAME,...] [--out PATH] [--local]   mint a clientId:secret, print or write the Kimaki env once
//   bots list | bots revoke <machine>
//   bots guilds <machine> <ID|NAME,...>             set which guilds a bot is in (default: the primary one)
//   guilds add <name> | guilds list | guilds rename <ID|NAME> <new name>
//   people invite <username> [--guild ID|NAME,...] [--tailscale-login LOGIN]   a person with a 24-hour pairing code
//   people list | people remove <username>                                   (the hub must be running)
//   machines icon <machine> avatar|guild_icon <image file|none>                 a machine's bot avatar or server icon
//   devices add <name> [--ttl 30m]                  one-time pairing code, valid 10 minutes unless --ttl
//   devices list | devices revoke <id|name>
//   apps publish <dir> | apps list | apps remove <version>   Vocorum app releases the hub serves to its devices
//   private setup --address IP [--name hub.home.arpa] [--port 47443] [--http-port 47080|off] [--allow CIDR,...]
//                 HTTPS on one private address with the hub's own CA (restart the hub after)
//   private status | private off | private retire-legacy   (stop serving the previous CA's certificate)
//   setup | doctor | pair <device> | config get|set | discord scan|import|status|purge|report
//                 getting started and moving from Discord: see src/onboard-cli.ts (all take --json)

import fs from 'node:fs'
import { botEnv, hubPaths, initHub, loadConfig, readSecret, type HubConfig } from './config.ts'
import { HubStore } from './store.ts'

const paths = hubPaths()
const args = process.argv.slice(2)

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}
function bool(name: string): boolean {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return false
  args.splice(index, 1)
  return true
}

function requireConfig(): HubConfig {
  const config = loadConfig(paths)
  if (!config) {
    console.error(`No hub at ${paths.root}. Run: vocorum init`)
    process.exit(1)
  }
  return config
}

async function withStore<T>(fn: (store: HubStore) => Promise<T>): Promise<T> {
  const store = new HubStore(`file:${paths.hubDb}`)
  await store.migrate()
  try {
    return await fn(store)
  } finally {
    store.close()
  }
}

// Tells a running hub to pick up bot and device changes.
async function reload(config: HubConfig) {
  const response = await fetch(`http://127.0.0.1:${config.port}/admin/reload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${readSecret(paths.adminToken)}` },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null)
  console.error(response?.ok ? 'Running hub reloaded.' : 'Hub not running; changes apply on next start.')
}

async function guildList(store: HubStore, config: HubConfig) {
  await store.ensureGuild(config.guildId, config.guildName)
  return store.listGuilds()
}

// "Home,Friends" or ids, to guild ids; every entry must exist.
async function resolveGuilds(store: HubStore, config: HubConfig, list: string) {
  await store.ensureGuild(config.guildId, config.guildName)
  const ids: string[] = []
  for (const entry of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const guild = await store.findGuild(entry)
    if (!guild) throw new Error(`No guild "${entry}". See: guilds list`)
    ids.push(guild.id)
  }
  if (ids.length === 0) throw new Error('Name at least one guild')
  return ids
}

// Commands that need the running hub (they create Discord-side state in the twin).
async function admin(config: HubConfig, method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${readSecret(paths.adminToken)}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!response) throw new Error('The hub is not running. Start it first.')
  const json = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new Error(json.error ?? `hub answered ${response.status}`)
  return json
}

async function adminBytes(config: HubConfig, path: string, body: Buffer) {
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${readSecret(paths.adminToken)}`, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!response) throw new Error('The hub is not running. Start it first.')
  const json = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new Error(json.error ?? `hub answered ${response.status}`)
  return json
}

const ago = (ms: number | null) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-')

const HELP = `vocorum: your own hub for people, devices and agents. State lives in ~/.vocorum
(set VOCORUM_DIR to keep it elsewhere).

Get started
  setup                    set up the hub on this machine (safe to run again)
  doctor                   check everything, and say how to fix what is wrong
  pair <device>            a link and QR code that signs a new device in
  restart                  restart the hub
  backup [dir]             a consistent copy of the hub while it runs
  restore <dir>            put a backup back, here or on a new machine
  export <dir>             everything you can read, as plain files (for leaving)
  uninstall                remove the hub's services and command (data kept unless --delete-data)

Move from Discord
  discord scan             what is there, and what the bot cannot read (read only)
  discord import           copy servers, channels, threads and files into the hub
  discord status           how far an import or a purge has got
  discord purge            plan, then delete, what you moved off Discord
  discord report           what moved, what was deleted, what Discord still keeps

Bots and machines
  kimaki setup <machine>   a Kimaki on this machine that lives on the hub
  bots add|list|revoke|guilds
  machines icon <machine> avatar|guild_icon <image file|none>

People and devices
  invite <name>            bring a friend: a message to send, a 24-hour link, your Tailscale steps
  access <name>            what one person can see and do
  people invite|list|remove
  devices add|list|revoke
  requests [list]|deny|undo    changes agents asked for, which you approve in the app
  request invite|remove|role|channel|raw
  admin setup|status       a private Admin server where you ask your own agent to run the hub
  projects add|list        a channel for a project folder in the hub's Kimaki

Servers and settings
  guilds add|list|rename
  channels list            every channel, by server
  config get|set
  private setup|status|off|retire-legacy    HTTPS on one private address

Add --help to a command for its options. Setup, doctor, pair, config and discord take --json.`

const COMMAND_HELP: Record<string, string> = {
  init: 'vocorum init [--public-url URL|none] [--tailscale-login LOGIN] [--port N]\n\nCreates ~/.vocorum, or updates it. vocorum setup does this and more.',
  start: 'vocorum start\n\nRuns the hub in this terminal. The service does this for you after vocorum setup.',
  bots: `vocorum bots add <machine> [--guild ID|NAME,...] [--out PATH] [--local]
vocorum bots list
vocorum bots revoke <machine>
vocorum bots guilds <machine> <ID|NAME,...>

add makes a bot login for a machine and prints it once (or writes it to --out).
guilds sets which servers the bot is in (default: the first one).`,
  people: `vocorum people invite <username> [--guild ID|NAME,...] [--tailscale-login LOGIN]
vocorum people list
vocorum people remove <username>

invite makes an account with a pairing code that works for 24 hours. The hub must be running.`,
  devices: `vocorum devices add <name> [--ttl 30m]
vocorum devices list
vocorum devices revoke <id|name>

add makes a single-use pairing code (10 minutes unless --ttl). vocorum pair also prints a QR code.`,
  guilds: 'vocorum guilds add <name>\nvocorum guilds list\nvocorum guilds rename <ID|NAME> <new name>',
  machines: "vocorum machines icon <machine> avatar|guild_icon <image file|none>\n\nSets a machine's bot picture or its server icon.",
  discord: `vocorum discord scan       what is there, and what the bot cannot read (read only)
vocorum discord import     copy servers into the hub
vocorum discord status     how far an import or a purge has got
vocorum discord purge      plan, then delete, what you moved off Discord
vocorum discord report     what moved, what was deleted, what Discord still keeps

Add --help to each for its options, for example: vocorum discord import --help`,
  kimaki: `vocorum kimaki setup <machine> [--guild ID|NAME,...] [--kimaki PATH] [--lock-port N] [--peer-data-dir DIR] [--no-service] [-- kimaki args]

Runs a Kimaki on this machine that lives on the hub, beside any Kimaki on Discord.`,
  requests: `vocorum requests [list]
vocorum requests deny <id>
vocorum requests undo <id>

Changes agents asked for. You approve them in the app with your passkey; undo files the
reversing change as a new request.`,
  request: `vocorum request invite <username> [--guild ID|NAME] [--reason TEXT]
vocorum request role <username> <role name> [--remove] [--guild ID|NAME]
vocorum request channel <channel name|id> <username|role name> [--allow view,send,...] [--deny view,...]
vocorum request raw <METHOD> <route> [json body]

Asks the owner for a change. Nothing happens until they approve it in the app.`,
  private: `vocorum private setup --address IP [--name hub.home.arpa] [--port 47443] [--http-port 47080|off] [--allow CIDR,...]
vocorum private status
vocorum private off
vocorum private retire-legacy

setup serves HTTPS on one private address with the hub's own certificate (restart the hub after).
retire-legacy stops serving the previous certificate after a change of names.`,
}

async function main() {
  const { onboardCommand } = await import('./onboard-cli.ts')
  if (await onboardCommand(args)) return
  // --help never runs a command: the command's own options, else the overview.
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    const topic = args[0] === 'help' ? args[1] : args[0]
    console.log((topic && COMMAND_HELP[topic]) || HELP)
    return
  }
  const publicUrl = flag('public-url')
  const tailscaleLogin = flag('tailscale-login')
  const port = flag('port')
  const envFile = flag('out')
  const local = bool('local')
  const address = flag('address')
  const listenName = flag('name')
  const httpPort = flag('http-port')
  const allow = flag('allow')
  const guildFlag = flag('guild')
  const ttl = flag('ttl')
  const personLogin = tailscaleLogin
  const [command, sub, name] = args

  switch (`${command ?? ''} ${sub ?? ''}`.trim()) {
    case 'init':
    case `init ${sub}`: {
      const config = initHub(paths, {
        ...(publicUrl !== undefined && { publicUrl: publicUrl === 'none' ? null : publicUrl }),
        ...(tailscaleLogin !== undefined && { tailscaleLogin: tailscaleLogin === 'none' ? null : tailscaleLogin }),
        ...(port !== undefined && { port: Number(port) }),
      })
      console.log(`Hub at ${paths.root}`)
      console.log(`  guild ${config.guildName} (${config.guildId}), port ${config.port}`)
      console.log(`  public URL: ${config.publicUrl ?? 'none (loopback only)'}`)
      console.log(`  Tailscale login: ${config.tailscaleLogin ?? 'not set: every human request is rejected'}`)
      return
    }
    case 'start': {
      const config = requireConfig()
      const { Hub } = await import('./hub.ts')
      const hub = new Hub({ paths, config })
      // A bug in one request must not take every bot and device down with it.
      process.on('uncaughtException', (error) => console.error('[vocorum] uncaught', error))
      process.on('unhandledRejection', (error) => console.error('[vocorum] unhandled rejection', error))
      await hub.start()
      console.log(`vocorum listening on ${hub.localUrl} (loopback only)`)
      let stopping = false
      const stop = async () => {
        if (stopping) return
        stopping = true
        // Never hang a restart: whatever has not closed after 5s is cut.
        setTimeout(() => {
          console.error('vocorum: stop took over 5s, exiting anyway')
          process.exit(0)
        }, 5000).unref()
        const started = Date.now()
        await hub.stop()
        console.log(`vocorum stopped in ${Date.now() - started} ms`)
        process.exit(0)
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      return
    }
    case 'bots add': {
      const config = requireConfig()
      if (!name) throw new Error('usage: bots add <machine> [--guild ID|NAME,...] [--out PATH] [--local]')
      const bot = await withStore(async (store) => {
        const guildIds = guildFlag ? await resolveGuilds(store, config, guildFlag) : []
        const minted = await store.addBot(name)
        if (guildIds.length) await store.setBotGuilds(name, guildIds)
        return minted
      })
      const env = botEnv(config, bot, { local })
      if (envFile) {
        fs.writeFileSync(envFile, `${env}\n`, { mode: 0o600 })
        fs.chmodSync(envFile, 0o600)
        console.error(`Wrote the Kimaki env for "${name}" to ${envFile} (0600). It is not shown again.`)
      } else {
        console.error(`Kimaki env for "${name}". Shown once; store it as a 0600 env file on that machine:\n`)
        console.log(env)
      }
      await reload(config)
      return
    }
    case 'bots list': {
      const config = requireConfig()
      const { bots, guilds, memberships } = await withStore(async (store) => ({ bots: await store.listBots(), guilds: await guildList(store, config), memberships: await store.botGuilds() }))
      const guildName = (id: string) => guilds.find((g) => g.id === id)?.name ?? id
      for (const bot of bots) {
        const ids = memberships.get(bot.machine) ?? [config.guildId]
        console.log(`${bot.machine}\tclient ${bot.clientId.slice(0, 8)}…\tcreated ${ago(bot.createdAt)}\t${bot.revokedAt ? `revoked ${ago(bot.revokedAt)}` : 'active'}\tin ${ids.map(guildName).join(', ')}`)
      }
      if (bots.length === 0) console.log('No bots.')
      return
    }
    case 'bots revoke': {
      const config = requireConfig()
      if (!name) throw new Error('usage: bots revoke <machine>')
      const revoked = await withStore((store) => store.revokeBot(name))
      console.log(revoked ? `Revoked bot "${name}".` : `No active bot "${name}".`)
      await reload(config)
      return
    }
    case 'bots guilds': {
      const config = requireConfig()
      const list = args.slice(3).join(' ')
      if (!name || !list) throw new Error('usage: bots guilds <machine> <ID|NAME,...>')
      await withStore(async (store) => {
        if (!(await store.listBots()).some((b) => b.machine === name && !b.revokedAt)) throw new Error(`No active bot "${name}".`)
        await store.setBotGuilds(name, await resolveGuilds(store, config, list))
      })
      console.log(`Bot "${name}" is now in: ${list}`)
      await reload(config)
      return
    }
    case 'guilds add': {
      const config = requireConfig()
      const guildName = args.slice(2).join(' ')
      if (!guildName) throw new Error('usage: guilds add <name>')
      const guild = await withStore(async (store) => {
        await store.ensureGuild(config.guildId, config.guildName)
        return store.addGuild(guildName)
      })
      console.log(`Added guild "${guild.name}" (${guild.id}). Add bots with: bots guilds <machine> <guilds>`)
      await reload(config)
      return
    }
    case 'guilds list': {
      const config = requireConfig()
      const guilds = await withStore((store) => guildList(store, config))
      for (const guild of guilds) console.log(`${guild.id}\t${guild.name}${guild.id === config.guildId ? '\t(primary)' : ''}`)
      return
    }
    case 'guilds rename': {
      const config = requireConfig()
      const newName = args.slice(3).join(' ')
      if (!name || !newName) throw new Error('usage: guilds rename <ID|NAME> <new name>')
      await withStore(async (store) => {
        await store.ensureGuild(config.guildId, config.guildName)
        const guild = await store.findGuild(name)
        if (!guild) throw new Error(`No guild "${name}".`)
        await store.renameGuild(guild.id, newName)
      })
      console.log(`Renamed to "${newName}".`)
      await reload(config)
      return
    }
    case 'people invite': {
      const config = requireConfig()
      if (!name) throw new Error('usage: people invite <username> [--guild ID|NAME,...] [--tailscale-login LOGIN]')
      const guilds = guildFlag ? await withStore((store) => resolveGuilds(store, config, guildFlag)) : []
      const invite = (await admin(config, 'POST', '/admin/people', { username: name, guilds, tailscale_login: personLogin })) as { user: { username: string; id: string }; code: string }
      console.log(`Invited ${invite.user.username} (${invite.user.id}). Pairing code for their first device (single use, 24 hours): ${invite.code}`)
      const listener = config.privateListener
      if (listener) console.log(`They open https://${listener.names[0]}:${listener.port} (after installing the profile from http://${listener.address}:${listener.httpPort ?? 47080}), choose "Pair this device" and create a passkey.`)
      if (!personLogin) console.log('No Tailscale login set: they can only connect from a network the private listener allows without Tailscale.')
      return
    }
    case 'people list': {
      const config = requireConfig()
      const { people } = (await admin(config, 'GET', '/admin/people')) as { people: Array<{ username: string; owner: boolean; guilds: string[]; devices: string[]; tailscale_login: string | null }> }
      for (const p of people) console.log(`${p.username}${p.owner ? ' (owner)' : ''}\tin ${p.guilds.join(', ') || 'no guild'}\tdevices: ${p.devices.join(', ') || 'none'}\tTailscale: ${p.tailscale_login ?? '-'}`)
      return
    }
    case 'people remove': {
      const config = requireConfig()
      if (!name) throw new Error('usage: people remove <username>')
      await admin(config, 'DELETE', `/admin/people/${encodeURIComponent(name)}`)
      console.log(`Removed ${name}: devices signed out and out of every guild. Their messages stay.`)
      return
    }
    case 'machines icon': {
      const config = requireConfig()
      const [kind, file] = args.slice(3)
      if (!name || !kind || !file) throw new Error('usage: machines icon <machine> avatar|guild_icon <image file|none>')
      const path = `/admin/machine-icons/${encodeURIComponent(name)}/${encodeURIComponent(kind)}`
      const result = file === 'none' ? await admin(config, 'DELETE', path) : await adminBytes(config, path, fs.readFileSync(file))
      console.log(JSON.stringify(result))
      return
    }
    case 'apps publish': {
      if (!name) throw new Error('usage: apps publish <dir with release.json, installers and .sig files>')
      const { AppReleases } = await import('./app-releases.ts')
      const result = new AppReleases(paths.apps).publish(name)
      console.log(`Published Vocorum ${result.version} (${result.files} files). Signed-in apps see it on their next update check.`)
      return
    }
    case 'apps list': {
      const { AppReleases } = await import('./app-releases.ts')
      const releases = new AppReleases(paths.apps).list()
      for (const r of releases) console.log(`${r.version}\t${r.pub_date}\t${Object.keys(r.files).join(', ')}`)
      if (releases.length === 0) console.log('No app releases.')
      return
    }
    case 'apps remove': {
      if (!name) throw new Error('usage: apps remove <version>')
      const { AppReleases } = await import('./app-releases.ts')
      console.log(new AppReleases(paths.apps).remove(name) ? `Removed ${name}.` : `No release ${name}.`)
      return
    }
    case 'devices add': {
      const config = requireConfig()
      if (!name) throw new Error('usage: devices add <name> [--ttl 30m]')
      const { duration } = await import('./onboard-cli.ts')
      const ttlMs = ttl ? duration(ttl) : 10 * 60_000
      if (ttlMs > 24 * 3_600_000) throw new Error('A pairing code lives at most 24 hours')
      const code = await withStore((store) => store.createPairing(name, { ttlMs }))
      console.log(`Pairing code for "${name}" (single use, ${Math.round(ttlMs / 60_000)} minutes): ${code}`)
      const listener = config.privateListener
      if (listener) {
        if (listener.httpPort !== null) console.log(`New device: open http://${listener.address.includes(':') ? `[${listener.address}]` : listener.address}:${listener.httpPort} first to install the hub's certificate profile.`)
        console.log(`Then open https://${listener.names[0]}:${listener.port}, choose "Pair this device" and create a passkey.`)
        const { appPairLink } = await import('./private-listener.ts')
        const { caFiles } = await import('./ca.ts')
        const link = appPairLink(listener, caFiles(paths.ca).caCert, code)
        if (link) {
          const { qrTerminal } = await import('./qr.ts')
          console.log(`Vocorum app: scan this or open ${link}`)
          console.log(qrTerminal(link))
        }
      } else {
        console.log(`Open ${config.publicUrl ?? `http://localhost:${config.port}`} on the device, choose "Pair this device" and create a passkey.`)
      }
      return
    }
    case 'private setup': {
      const config = requireConfig()
      if (!address) throw new Error('usage: private setup --address IP [--name hub.home.arpa] [--port 47443] [--http-port 47080|off] [--allow CIDR,...]')
      const { PrivateListener, assertSpecificAddress } = await import('./private-listener.ts')
      assertSpecificAddress(address)
      const privateListener = {
        address,
        port: port ? Number(port) : (config.privateListener?.port ?? 47443),
        httpPort: httpPort === 'off' ? null : httpPort ? Number(httpPort) : (config.privateListener?.httpPort ?? 47080),
        names: listenName ? listenName.split(',') : (config.privateListener?.names ?? ['hub.home.arpa']),
        // Default: the tailnet range (and the address's own /32 for other private networks).
        allowedCidrs: allow ? allow.split(',') : (config.privateListener?.allowedCidrs ?? ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']),
      }
      const listener = new PrivateListener(privateListener, paths.ca, { attach: () => {}, tailscaleLogins: () => new Map() })
      const ca = await listener.prepare({ reissueBroad: true })
      if (ca.rotated) console.log(`New CA for ${privateListener.names.join(', ')}. The previous certificate keeps serving its old names and connections by address, so current devices keep working. New names need the new profile; once every device has it, run: vocorum private retire-legacy`)
      else if (ca.reissued) console.log(`The old CA could sign any name under ${ca.broad.join(', ')}: replaced it with one limited to ${privateListener.names.join(', ')}. Remove the old Vocorum profile from every device and install the new one.`)
      const { fingerprint } = await import('./ca.ts')
      initHub(paths, { privateListener })
      console.log(`Private listener: https://${privateListener.names[0]}:${privateListener.port} on ${address} (only from ${privateListener.allowedCidrs.join(', ')})`)
      console.log(`CA fingerprint (SHA-256): ${fingerprint(listener.files.caCert)}`)
      console.log('Restart the hub to apply.')
      return
    }
    case 'private status': {
      const config = requireConfig()
      const listener = config.privateListener
      if (!listener) return console.log('Private listener: off (loopback only).')
      const { caFiles, fingerprint, hasLegacy } = await import('./ca.ts')
      const files = caFiles(paths.ca)
      if (hasLegacy(files)) console.log(`Previous CA still served for its old names and for connections by address (fingerprint ${fingerprint(files.legacy.caCert)}). Once every device has the new CA: vocorum private retire-legacy`)
      console.log(`Private listener: https://${listener.names[0]}:${listener.port} on ${listener.address}, enrolment ${listener.httpPort === null ? 'off' : `http port ${listener.httpPort}`}`)
      console.log(`Allowed networks: ${listener.allowedCidrs.join(', ')}`)
      if (fs.existsSync(files.caCert)) console.log(`CA fingerprint (SHA-256): ${fingerprint(files.caCert)}`)
      return
    }
    case 'private retire-legacy': {
      const { caFiles, hasLegacy } = await import('./ca.ts')
      const files = caFiles(paths.ca)
      if (!hasLegacy(files)) return console.log('No previous CA in use.')
      await fs.promises.rename(files.legacy.dir, `${files.legacy.dir}.retired-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      console.log('The previous CA is no longer served. Restart the hub to apply; devices that only trust it must install the new profile.')
      return
    }
    case 'private off': {
      requireConfig()
      initHub(paths, { privateListener: null })
      console.log('Private listener off. Restart the hub to apply. The CA stays in place for a later setup.')
      return
    }
    case 'devices list': {
      const devices = await withStore((store) => store.listDevices())
      for (const device of devices) console.log(`${device.id}\t${device.name}\tcreated ${ago(device.createdAt)}\tlast seen ${ago(device.lastSeenAt)}\t${device.revokedAt ? `revoked ${ago(device.revokedAt)}` : 'active'}`)
      if (devices.length === 0) console.log('No devices.')
      return
    }
    case 'devices revoke': {
      const config = requireConfig()
      if (!name) throw new Error('usage: devices revoke <id|name>')
      const ids = await withStore((store) => store.revokeDevice(name))
      console.log(ids.length ? `Revoked ${ids.length === 1 ? "1 device" : `${ids.length} devices`}; signed out.` : `No active device "${name}".`)
      await reload(config)
      return
    }
    default:
      if (command) console.error(`Unknown command: ${args.join(' ')}\n`)
      console.log(HELP)
      process.exit(command ? 1 : 0)
  }
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
