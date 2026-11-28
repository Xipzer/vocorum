// Who is online, per user, for the member list: people through their signed-in
// devices' event connections (and the channel each shows), bots through their
// machines' gateway connections. Each person decides whether others see their
// status (show_presence) and where they are (show_activity); others only ever
// see channels they can view themselves. PRESENCE_UPDATE goes out per recipient.
// A person may choose a status, as on Discord: Do Not Disturb and Idle show as chosen,
// Invisible shows as offline to everyone else; Online keeps the idle that devices report.
// Bots get the same presence, invisible as offline, in PRESENCE_UPDATE.

import type { Hub } from './hub.ts'
import type { ChosenStatus, CustomStatus } from './store.ts'

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'
export type UserPresence = {
  user_id: string
  status: PresenceStatus
  // A person's custom status; expires_at in ms, null: until cleared.
  custom_status?: { text: string; expires_at: number | null }
  // People: each connected app window.
  devices?: Array<{ id: string; name: string; channel_id: string | null; visible: boolean }>
  // Bots: each machine that logs in as this bot user, with what it says it is doing.
  machines?: Array<{ machine: string; online: boolean; activity: string | null; activity_at?: number }>
  // A bot's custom status (op 3), the newest among the machines shown; null when cleared.
  activity?: string | null
}

// The newest activity among these machines.
function newestActivity(machines: NonNullable<UserPresence['machines']>) {
  const set = machines.filter((m) => m.online && m.activity_at !== undefined).sort((a, b) => b.activity_at! - a.activity_at!)[0]
  return set?.activity ?? null
}

export class Presence {
  private last = new Map<string, string>()
  private lastBots = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private unobserve: (() => void) | null = null
  private bots: Array<{ machine: string; token: string; userId: string | null }> = []
  private chosen = new Map<string, { status: ChosenStatus; customStatus: CustomStatus | null; at: number }>()
  private expiry: NodeJS.Timeout | null = null

  constructor(private readonly hub: Hub) {}

  async start() {
    for (const [userId, p] of Object.entries(await this.hub.store.profiles())) this.chosen.set(userId, { status: p.status, customStatus: p.customStatus, at: Date.now() })
    this.scheduleExpiry()
    await this.reload()
    this.unobserve = this.hub.twin.observeGatewayConnections(() => this.changed())
  }

  stop() {
    this.unobserve?.()
    if (this.timer) clearTimeout(this.timer)
    if (this.expiry) clearTimeout(this.expiry)
  }

  // The status a person chose, with a custom status that has not expired.
  settingsOf(userId: string, now = Date.now()): { status: ChosenStatus; custom_status: { text: string; expires_at: number | null } | null } {
    const c = this.chosen.get(userId)
    const custom = c?.customStatus && (c.customStatus.expiresAt === null || c.customStatus.expiresAt > now) ? c.customStatus : null
    return { status: c?.status ?? 'online', custom_status: custom && { text: custom.text, expires_at: custom.expiresAt } }
  }

  doNotDisturb(userId: string) {
    return this.chosen.get(userId)?.status === 'dnd'
  }

  async choose(userId: string, update: { status?: ChosenStatus; customStatus?: CustomStatus | null }) {
    await this.hub.store.setProfile(userId, update)
    const was = this.chosen.get(userId) ?? { status: 'online' as const, customStatus: null, at: 0 }
    this.chosen.set(userId, { status: update.status ?? was.status, customStatus: update.customStatus === undefined ? was.customStatus : update.customStatus, at: update.customStatus === undefined ? was.at : Date.now() })
    this.scheduleExpiry()
    this.forget(userId)
  }

  // Wakes when the next custom status expires, so everyone sees it go.
  private scheduleExpiry() {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
    const now = Date.now()
    const next = Math.min(...[...this.chosen.values()].map((c) => c.customStatus?.expiresAt ?? Infinity).filter((t) => t > now))
    if (next === Infinity) return
    this.expiry = setTimeout(() => (this.changed(), this.scheduleExpiry()), Math.min(next - now + 50, 2 ** 31 - 1))
    this.expiry.unref()
  }

  // Bot tokens change only through the CLI.
  async reload() {
    const own = await this.hub.store.botUsers()
    this.bots = (await this.hub.store.listBots()).filter((b) => !b.revokedAt).map((b) => ({ machine: b.machine, token: `${b.clientId}:${b.secretHash}`, userId: own.get(b.machine)?.userId ?? null }))
    this.changed()
  }

  // Everyone's presence as they are, before privacy.
  private raw(): Map<string, UserPresence> {
    const { botUserId } = this.hub.options.config
    const out = new Map<string, UserPresence>()
    for (const c of this.hub.events.connections()) {
      const entry = out.get(c.userId) ?? { user_id: c.userId, status: 'offline' as PresenceStatus, devices: [] }
      entry.devices!.push({ id: c.deviceId, name: c.name, channel_id: c.channelId, visible: c.visible })
      out.set(c.userId, entry)
    }
    for (const entry of out.values()) {
      const chosen = this.settingsOf(entry.user_id)
      entry.status = chosen.status !== 'online' ? chosen.status : entry.devices!.some((d) => d.visible) ? 'online' : 'idle'
      if (chosen.custom_status) entry.custom_status = chosen.custom_status
    }
    const connected = this.hub.twin.connectedGatewayTokens()
    const activities = this.hub.twin.gatewayActivities()
    // Each bot user with its machines: the shared bot, and machines that are their own bot user.
    const byUser = new Map<string, NonNullable<UserPresence['machines']>>([[botUserId, []]])
    for (const b of this.bots) {
      const activity = connected.has(b.token) ? activities.get(b.token) : undefined
      const userId = b.userId ?? botUserId
      byUser.set(userId, [...(byUser.get(userId) ?? []), { machine: b.machine, online: connected.has(b.token), activity: activity?.text ?? null, ...(activity && { activity_at: activity.at }) }])
    }
    for (const [userId, machines] of byUser) out.set(userId, { user_id: userId, status: machines.some((m) => m.online) ? 'online' : 'offline', machines, activity: newestActivity(machines) })
    return out
  }

  // What `viewer` may see of `presence`.
  // The bot: only the machines the viewer can see (null: none, so no bot at all).
  private async shape(presence: UserPresence, viewer: string, profiles: Record<string, { showPresence: boolean; showActivity: boolean }>): Promise<UserPresence | null> {
    if (presence.machines) {
      const visible = await this.hub.visibleMachines(viewer)
      const machines = presence.machines.filter((m) => visible.has(m.machine.toLowerCase()))
      return machines.length ? { ...presence, status: machines.some((m) => m.online) ? 'online' : 'offline', activity: newestActivity(machines), machines: machines.map(({ activity_at: _at, ...m }) => m) } : null
    }
    if (presence.user_id === viewer) return presence
    const profile = profiles[presence.user_id]
    if (presence.status === 'invisible' || (profile && !profile.showPresence)) return { user_id: presence.user_id, status: 'offline' }
    if (profile && !profile.showActivity) return { user_id: presence.user_id, status: presence.status, ...(presence.custom_status && { custom_status: presence.custom_status }) }
    const visible = await this.hub.access.visibleChannels(viewer)
    return { ...presence, devices: presence.devices?.map((d) => ({ ...d, channel_id: d.channel_id && visible.has(d.channel_id) ? d.channel_id : null })) }
  }

  // Presence of the people `viewer` shares a guild with, and the bot.
  async snapshotFor(viewer: string): Promise<Record<string, UserPresence>> {
    const peers = await this.hub.access.peers(viewer)
    const profiles = await this.hub.store.profiles()
    const out: Record<string, UserPresence> = {}
    for (const presence of this.raw().values()) {
      if (presence.user_id !== viewer && !peers.has(presence.user_id) && !presence.machines) continue
      const shaped = await this.shape(presence, viewer, profiles)
      if (shaped) out[presence.user_id] = shaped
    }
    for (const id of peers) if (id !== this.hub.options.config.botUserId) out[id] ??= { user_id: id, status: 'offline' }
    return out
  }

  // After a privacy change: send this user's presence again.
  forget(userId: string) {
    this.last.delete(userId)
    this.changed()
  }

  // Coalesced: a reconnect storm sends one update per user.
  changed() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch((error) => console.error('[presence]', error))
    }, 100)
    this.timer.unref()
  }

  private async flush() {
    const profiles = await this.hub.store.profiles()
    const current = this.raw()
    const ids = new Set([...current.keys(), ...this.last.keys()])
    for (const id of ids) {
      const presence = current.get(id) ?? { user_id: id, status: 'offline' as PresenceStatus }
      const key = JSON.stringify(presence)
      if (this.last.get(id) === key) continue
      if (current.has(id)) this.last.set(id, key)
      else this.last.delete(id)
      const peers = presence.machines ? null : await this.hub.access.peers(id)
      const shapes = new Map<string, UserPresence | null>()
      for (const connection of this.hub.events.connections()) {
        if (!shapes.has(connection.userId)) shapes.set(connection.userId, await this.shape(presence, connection.userId, profiles))
      }
      this.hub.events.send('PRESENCE_UPDATE', presence, { shape: (viewer) => (peers && viewer !== id && !peers.has(viewer) ? null : (shapes.get(viewer) ?? null)) })
      if (!presence.machines) await this.toBots(presence, profiles[id]?.showPresence === false)
    }
  }

  // What bots see of a person: Discord's status, client_status per platform and the custom status.
  private async toBots(presence: UserPresence, hidden: boolean) {
    const status = hidden || presence.status === 'invisible' ? 'offline' : presence.status
    const clientStatus: Record<string, 'online' | 'idle' | 'dnd'> = {}
    if (status !== 'offline') {
      for (const c of this.hub.events.connections()) {
        if (c.userId !== presence.user_id) continue
        const platform = c.kind === 'app' ? 'desktop' : 'web'
        clientStatus[platform] = status === 'online' && !c.visible && clientStatus[platform] !== 'online' ? 'idle' : status
      }
    }
    const customStatus = presence.custom_status && status !== 'offline' ? { text: presence.custom_status.text, createdAt: this.chosen.get(presence.user_id)?.at ?? Date.now() } : null
    const key = JSON.stringify([status, clientStatus, customStatus])
    if (this.lastBots.get(presence.user_id) === key) return
    this.lastBots.set(presence.user_id, key)
    await this.hub.twin.simulatePresenceUpdate({ userId: presence.user_id, status, customStatus, clientStatus })
  }

  // Devices of a user that are in front right now: they see new messages live.
  visibleDevices(userId: string): Set<string> {
    return new Set(this.hub.events.connections().filter((c) => c.visible && c.userId === userId).map((c) => c.deviceId))
  }
}
