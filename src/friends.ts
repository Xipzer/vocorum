// `vocorum invite <name>`: the simplest safe way to bring a friend onto the hub.
//
//   owner: vocorum invite sam      -> a person "sam" in the Friends server, a 24-hour
//                                     single-use code, a message to send, and what to
//                                     do in Tailscale
//   friend: Tailscale (the hub's machine shared with them), then the setup link by IP:
//           it shows what to install and opens Vocorum with the code; a passkey.
//
// The hub learns the friend's Tailscale account when they pair, so the owner never
// needs their email; from then on only that account works for them. Friends go to a
// server of their own by default, away from the machines and their agent sessions.
// Removing them signs out every device and forgets their Tailscale account.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { fingerprint } from './ca.ts'
import { tool } from './platform.ts'
import type { HubConfig, HubPaths } from './config.ts'

const run = promisify(execFile)

export const FRIENDS_SERVER = 'Friends'

type Tailnet = { ip: string | null; dnsName: string | null; hostName: string | null; login: string | null }

async function tailnet(): Promise<Tailnet> {
  const status = await run(tool('tailscale'), ['status', '--json'], { timeout: 5000, windowsHide: true }).then((r) => JSON.parse(r.stdout) as { Self?: { TailscaleIPs?: string[]; DNSName?: string; HostName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }> }, () => null)
  const self = status?.Self
  return { ip: self?.TailscaleIPs?.find((ip) => !ip.includes(':')) ?? null, dnsName: self?.DNSName?.replace(/\.$/, '') ?? null, hostName: self?.HostName ?? null, login: self?.UserID !== undefined ? (status?.User?.[String(self.UserID)]?.LoginName ?? null) : null }
}

export type Invitation = {
  username: string
  server: string
  code: string
  expires_hours: number
  links: { setup: string | null; app: string }
  fingerprint: string
  via: 'tailscale' | 'private network'
  message: string
  owner_steps: string[]
}

export async function invitation(config: HubConfig, paths: HubPaths, input: { username: string; displayName?: string | null; server: string; code: string; hours: number; links: { setup: string | null; app: string }; local?: boolean }): Promise<Invitation> {
  const l = config.privateListener
  if (!l || ((l.address === '127.0.0.1' || l.address === '::1') && !input.local)) throw new Error('Your hub only answers on this machine, so a friend cannot reach it. Open it on your private network first: vocorum setup --address <your Tailscale or WireGuard address> (or --local for someone on this same computer)')
  const net = await tailnet()
  const onTailnet = net.ip === l.address
  const fp = fingerprint(path.join(paths.ca, 'ca.crt'))
  const short = fp.split(':').slice(0, 4).join(':')
  const app = new URL(input.links.app)
  const lines = [
    `Hi ${input.displayName ?? input.username},`,
    '',
    'I have added you to my Vocorum, a private chat space that runs on my own computer. It is not on the internet, so getting in takes a few steps.',
    '',
    ...(onTailnet
      ? ['1. Install Tailscale (https://tailscale.com/download) on your phone or computer and sign in. Then open the Tailscale link I send you, to accept the computer I share with you.']
      : ['1. Connect to my private network (I will send you its settings).']),
    `2. On that device, open ${input.links.setup ?? input.links.app}`,
    '   It shows what your device needs to trust my hub, then opens Vocorum with your code filled in. Create a passkey when it asks.',
    `3. Before your device trusts anything, find the hub's fingerprint on that page. It should start with ${short}. If it does not, stop and tell me.`,
    `4. From then on Vocorum is at ${app.origin}. Bookmark it (on a phone, add it to the home screen).`,
    '',
    `Your code is ${input.code}. It works once, within ${input.hours} hours. You will only see the servers I add you to.`,
  ]
  const steps = onTailnet
    ? [
        `Share this computer with ${input.username} in Tailscale: https://login.tailscale.com/admin/machines, the menu of ${net.hostName ?? 'this machine'}, Share, then copy a share link (or invite their email). Send them that link with the message.`,
        `Optional but recommended: let shared users reach only Vocorum on this computer. In your tailnet policy add a grant: {"src": ["autogroup:shared"], "dst": ["${l.address}"], "ip": ["${l.port}", "${l.httpPort ?? 47080}"]} and make sure no broader rule includes them.`,
        `Their Tailscale account is tied to them when they pair; nobody else can use their code afterwards.`,
        `Check what they will see: vocorum access ${input.username}`,
        `To remove them later: vocorum people remove ${input.username}, then revoke the share in Tailscale.`,
      ]
    : [`Give ${input.username} access to the private network ${l.address} is on.`, `Check what they will see: vocorum access ${input.username}`, `To remove them later: vocorum people remove ${input.username}`]
  if (onTailnet && net.dnsName && l.names[0] !== net.dnsName) steps.push(`Your hub's name is ${l.names[0]}, not the Tailscale name ${net.dnsName}: their device needs the profile or a hosts line from the setup page before the app opens.`)
  return { username: input.username, server: input.server, code: input.code, expires_hours: input.hours, links: input.links, fingerprint: fp, via: onTailnet ? 'tailscale' : 'private network', message: lines.join('\n'), owner_steps: steps }
}
