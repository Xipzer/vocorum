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
//   private setup --address IP [--name hub.home.arpa] [--port 47443] [--http-port 47080|off] [--allow CIDR,...]
//                 HTTPS on one private address with the hub's own CA (restart the hub after)
//   private status | private off
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

async function main() {
  const { onboardCommand } = await import('./onboard-cli.ts')
  if (await onboardCommand(args)) return
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
      if (ca.reissued) console.log(`The old CA could sign any name under ${ca.broad.join(', ')}: replaced it with one limited to ${privateListener.names.join(', ')}. Remove the old Vocorum profile from every device and install the new one.`)
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
      const { caFiles, fingerprint } = await import('./ca.ts')
      const files = caFiles(paths.ca)
      console.log(`Private listener: https://${listener.names[0]}:${listener.port} on ${listener.address}, enrolment ${listener.httpPort === null ? 'off' : `http port ${listener.httpPort}`}`)
      console.log(`Allowed networks: ${listener.allowedCidrs.join(', ')}`)
      if (fs.existsSync(files.caCert)) console.log(`CA fingerprint (SHA-256): ${fingerprint(files.caCert)}`)
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
      console.log(ids.length ? `Revoked ${ids.length} device(s); their sessions are gone.` : `No active device "${name}".`)
      await reload(config)
      return
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 19).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
      process.exit(command ? 1 : 0)
  }
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
