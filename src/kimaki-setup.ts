// `vocorum kimaki setup <machine>`: a Kimaki on this machine that lives on the
// hub, next to (never instead of) a Kimaki on Discord. It gets its own bot
// token, its own data folder and its own lock port, so the two never answer
// for each other, and a service that stops cleanly.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { botEnv, readSecret, type HubConfig, type HubPaths } from './config.ts'

const run = promisify(execFile)

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })

export type KimakiOptions = { machine: string; guilds: string[]; kimaki?: string; lockPort?: number; peerDataDir?: string; service: boolean; extraArgs: string[] }

export async function kimakiSetup(config: HubConfig, paths: HubPaths, options: KimakiOptions) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(options.machine)) throw new Error('Machine names are lower case letters, digits and dashes')
  const kimaki = options.kimaki ?? (await run('sh', ['-c', 'command -v kimaki']).then((r) => r.stdout.trim(), () => ''))
  if (!kimaki) throw new Error('No kimaki command found. Install Kimaki first, or pass --kimaki <path to kimaki>')
  const dataDir = path.join(paths.root, 'kimaki-data')
  const envFile = path.join(paths.root, `${options.machine}.env`)
  if (fs.existsSync(envFile)) throw new Error(`${envFile} exists: this machine already has a hub bot. Revoke it first (vocorum bots revoke ${options.machine}) to make a new one.`)
  let lockPort = options.lockPort ?? 29990
  if (!options.lockPort) while (!(await portFree(lockPort))) lockPort++

  const { HubStore } = await import('./store.ts')
  const store = new HubStore(`file:${paths.hubDb}`)
  await store.migrate()
  let env: string
  try {
    const minted = await store.addBot(options.machine)
    if (options.guilds.length) await store.setBotGuilds(options.machine, options.guilds)
    env = botEnv(config, minted, { local: true })
  } finally {
    store.close()
  }
  fs.writeFileSync(envFile, `${env}\nKIMAKI_LOCK_PORT=${lockPort}\n`, { mode: 0o600 })
  await fetch(`http://127.0.0.1:${config.port}/admin/reload`, { method: 'POST', headers: { authorization: `Bearer ${readSecret(paths.adminToken)}` }, signal: AbortSignal.timeout(5000) }).catch(() => null)

  const args = [`--data-dir`, dataDir, ...(options.peerDataDir ? ['--peer-data-dir', options.peerDataDir] : []), ...options.extraArgs]
  const log = path.join(paths.root, 'kimaki.log')
  const ca = config.privateListener ? path.join(paths.ca, 'ca.crt') : null
  let unit: string | null = null
  if (options.service && process.platform === 'linux') {
    unit = path.join(os.homedir(), '.config/systemd/user/kimaki-hub.service')
    if (fs.existsSync(unit)) throw new Error(`${unit} exists already. Remove it or pass --no-service.`)
    fs.mkdirSync(path.dirname(unit), { recursive: true })
    fs.writeFileSync(
      unit,
      `[Unit]
Description=Kimaki on Vocorum (${options.machine})
After=vocorum.service

[Service]
Type=simple
WorkingDirectory=%h
Environment=PATH=${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}
EnvironmentFile=${envFile}
${ca ? `Environment=NODE_EXTRA_CA_CERTS=${ca}\n` : ''}ExecStart=${kimaki} ${args.join(' ')}
Restart=on-failure
RestartSec=10
# Kimaki's supervisor forwards one SIGTERM to the bot; signalling the whole group
# sends two, the second kills it and the unit ends "failed".
KillMode=mixed
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`,
    )
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => null)
    await run('systemctl', ['--user', 'enable', '--now', 'kimaki-hub']).catch(() => null)
  }
  return { machine: options.machine, envFile, dataDir, lockPort, unit, command: `set -a; . ${envFile}; set +a; ${ca ? `NODE_EXTRA_CA_CERTS=${ca} ` : ''}${kimaki} ${args.join(' ')}`, log }
}
